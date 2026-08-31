import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Notice,
  TFile,
} from 'obsidian';
import Indexer from './indexer';
import Registry, { getVariableType, type VariableType } from './registry';
import Resolver from './resolver';
import {
  formatSuggestionValue,
  parseSuggestionQuery,
  scoreSuggestionFields,
  truncateSuggestionValue,
} from './suggestionSearch';
import {
  findVariableTokenTrigger,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  getTokenSyntax,
  hasVariableTokenSuffixAt,
} from './tokenSyntax';

interface SuggestItem {
  name: string;
  kind: 'variable' | 'property';
  alreadyMapped?: boolean;
  display?: string;
  file?: string;
  property?: string;
  value?: string;
  variableType?: VariableType;
}

interface CachedSuggestionValue {
  expires: number;
  signature: string;
  value: string | null;
}

export default class VariableSuggest extends EditorSuggest<SuggestItem> {
  private suggestionGeneration = 0;
  private valueCache = new Map<string, CachedSuggestionValue>();

  constructor(
    app: App,
    private readonly indexer: Indexer,
    private readonly registry: Registry,
    private readonly resolver: Resolver,
    private readonly onVariableCreated: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const trigger = findVariableTokenTrigger(
      line,
      cursor.ch,
      getRecognizedTokenSyntaxes(this.registry.plugin.settings),
    );
    if (!trigger) {
      this.suggestionGeneration++;
      return null;
    }
    return {
      start: { line: cursor.line, ch: trigger.start },
      end: { line: cursor.line, ch: cursor.ch },
      query: trigger.query,
    };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<SuggestItem[]> {
    const generation = ++this.suggestionGeneration;
    const query = parseSuggestionQuery(context.query);
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name,
      kind: 'variable',
      display: entry.def.display,
      file: entry.filePath,
      property: getVariableType(entry.def) === 'property' ? entry.def.property : undefined,
      variableType: getVariableType(entry.def),
    }));

    if (query.valueMode) {
      const resolved = await Promise.all(variables.map(async (item) => {
        const value = await this.getResolvedSuggestionValue(item.name);
        return value === null ? null : { ...item, value };
      }));
      if (generation !== this.suggestionGeneration) return [];
      const resolvedItems: SuggestItem[] = [];
      for (const item of resolved) if (item !== null) resolvedItems.push(item);
      return this.rankItems(
        resolvedItems,
        query.terms,
        (item) => [item.value],
      ).slice(0, 100);
    }

    const properties: SuggestItem[] = [];
    const mappedProperties = new Set<string>();
    for (const entry of this.indexer.byName.values()) {
      if (getVariableType(entry.def) !== 'property' || !entry.filePath) continue;
      mappedProperties.add(this.propertyKey(entry.filePath, entry.def.property));
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isRecord(frontmatter)) continue;
      for (const property of Object.keys(frontmatter)) {
        properties.push({
          name: property,
          kind: 'property',
          file: file.path,
          property,
          alreadyMapped: mappedProperties.has(this.propertyKey(file.path, property)),
        });
      }
    }
    const variableMatches = this.rankItems(
      variables,
      query.terms,
      (item) => [item.name, item.display, item.file, item.property],
    );
    const propertyMatches = this.rankItems(
      properties,
      query.terms,
      (item) => [item.name, item.file, item.property],
    );
    return [
      ...variableMatches,
      ...propertyMatches.filter((item) => !item.alreadyMapped),
      ...propertyMatches.filter((item) => item.alreadyMapped),
    ].slice(0, 100);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.createDiv({ text: item.name });
    const detail = item.kind === 'variable'
      ? item.variableType === 'fixed'
        ? `Fixed value${item.file ? ` · ${item.file}` : ''}`
        : `Property value · ${item.file ?? ''}${item.property ? ` • ${item.property}` : ''}`
      : `Property · ${item.file ?? ''}`;
    el.createDiv({ text: detail, cls: 'suggest-meta' });
    if (item.display) el.createDiv({ text: item.display, cls: 'suggest-sub' });
    if (typeof item.value === 'string') {
      el.createDiv({
        text: `Value: ${truncateSuggestionValue(item.value)}`,
        cls: 'suggest-sub variable-links-suggest-value',
      });
    }
  }

  selectSuggestion(item: SuggestItem, _event: MouseEvent | KeyboardEvent): void {
    const context = this.context;
    if (!context) return;
    void this.applySuggestion(item, context);
  }

  private async applySuggestion(item: SuggestItem, context: EditorSuggestContext): Promise<void> {
    let variableName = item.name;
    let createdVariable = false;
    if (item.kind === 'property') {
      const base = (item.property ?? item.name)
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[{}]/g, '') || 'Variable';
      let number = 1;
      do {
        variableName = `${base}_${String(number).padStart(2, '0')}`;
        number++;
      } while (this.registry.getVariable(variableName) || this.indexer.byName.has(variableName));

      try {
        await this.registry.saveVariable(variableName, {
          type: 'property',
          file: item.file ?? '',
          property: item.property ?? item.name,
          display: item.property ?? item.name,
        });
        createdVariable = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Variable Links: could not create ${variableName}: ${detail}`);
        return;
      }
    }

    const line = context.editor.getLine(context.end.line);
    const activeSyntax = getTokenSyntax(this.registry.plugin.settings);
    const trigger = findVariableTokenTrigger(
      line,
      context.end.ch,
      getRecognizedTokenSyntaxes(this.registry.plugin.settings),
    );
    const triggerSyntax = trigger?.start === context.start.ch ? trigger.syntax : activeSyntax;
    const hasAutoCloser = hasVariableTokenSuffixAt(line, context.end.ch, triggerSyntax);
    const token = formatVariableToken(variableName, activeSyntax);
    const replaceEnd = hasAutoCloser
      ? { line: context.end.line, ch: context.end.ch + triggerSyntax.suffix.length }
      : context.end;
    context.editor.replaceRange(
      token,
      context.start,
      replaceEnd,
    );
    context.editor.setCursor({
      line: context.start.line,
      ch: context.start.ch + token.length,
    });
    context.editor.focus();
    if (createdVariable) {
      try {
        await this.onVariableCreated(variableName);
      } catch {
        new Notice('Variable links: the variable was created, but the properties panel could not be refreshed.');
      }
    }
  }

  private rankItems(
    items: SuggestItem[],
    terms: readonly string[],
    fields: (item: SuggestItem) => readonly (string | undefined)[],
  ): SuggestItem[] {
    const ranked: Array<{ item: SuggestItem; score: number; index: number }> = [];
    items.forEach((item, index) => {
      const score = scoreSuggestionFields(terms, fields(item));
      if (score !== null) ranked.push({ item, score, index });
    });
    ranked.sort((left, right) => left.score - right.score || left.index - right.index);
    return ranked.map(({ item }) => item);
  }

  private async getResolvedSuggestionValue(name: string): Promise<string | null> {
    const definition = this.registry.getVariable(name);
    if (!definition) return null;
    const signature = JSON.stringify([
      definition.guid,
      getVariableType(definition),
      definition.file,
      definition.property,
      definition.value,
    ]);
    const now = Date.now();
    const cached = this.valueCache.get(name);
    if (cached && cached.signature === signature && cached.expires > now) return cached.value;

    const result = await this.resolver.resolve(name).catch(() => null);
    const formatted = result?.ok ? formatSuggestionValue(result.value) : '';
    const value = formatted.length ? formatted : null;
    this.valueCache.set(name, {
      expires: now + 2000,
      signature,
      value,
    });
    return value;
  }

  private propertyKey(file: string, property: string): string {
    return `${file}\u0000${property}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
