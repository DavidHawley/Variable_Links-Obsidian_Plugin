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
  isValidNamedCreationName,
  parseFixedCreationSource,
  parseNamedCreationQuery,
  type NamedCreationQuery,
  type NamedCreationType,
} from './creationSyntax';
import { parsePropertyLink } from './linkSyntax';
import {
  formatSuggestionValue,
  parseSuggestionQuery,
  scoreSuggestionFields,
  truncateSuggestionValue,
} from './suggestionSearch';
import {
  canRepresentVariableTextCase,
  findVariableTokenTrigger,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  getTokenSyntax,
  hasVariableTokenSuffixAt,
} from './tokenSyntax';
import {
  getVariableTextCaseLabel,
  parseVariableTextCaseQuery,
  wrapVariableNameWithTextCase,
  type VariableTextCase,
} from './textCase';

interface SuggestItem {
  name: string;
  kind: 'variable' | 'property' | 'creation';
  alreadyMapped?: boolean;
  display?: string;
  file?: string;
  property?: string;
  value?: string;
  variableType?: VariableType;
  textCase?: VariableTextCase;
  creationType?: NamedCreationType;
  creationSource?: string;
  creationError?: string;
}

export interface VariableCreationHandoff {
  type: NamedCreationType;
  name: string;
  editor: Editor;
  from: EditorPosition;
  to: EditorPosition;
  originalText: string;
  textCase?: VariableTextCase;
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
    private readonly onVariableCreationRequested: (
      request: VariableCreationHandoff,
    ) => Promise<void>,
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
    const caseQuery = parseVariableTextCaseQuery(context.query);
    const creationQuery = this.registry.getVariable(caseQuery.query)
      ? null
      : parseNamedCreationQuery(caseQuery.query);
    const query = parseSuggestionQuery(creationQuery?.name ?? caseQuery.query);
    const creationItems = this.getNamedCreationSuggestions(
      creationQuery,
      caseQuery.textCase,
    );
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name,
      kind: 'variable',
      display: entry.def.display,
      file: entry.filePath,
      property: getVariableType(entry.def) === 'property' ? entry.def.property : undefined,
      variableType: getVariableType(entry.def),
    }));

    if (query.valueMode && !creationQuery) {
      const resolved = await Promise.all(variables.map(async (item) => {
        const value = await this.getResolvedSuggestionValue(item.name);
        return value === null ? null : { ...item, value };
      }));
      if (generation !== this.suggestionGeneration) return [];
      const resolvedItems: SuggestItem[] = [];
      for (const item of resolved) if (item !== null) resolvedItems.push(item);
      return this.applyTextCaseToSuggestions(this.rankItems(
        resolvedItems,
        query.terms,
        (item) => [item.value],
      ).slice(0, 100), context.query, caseQuery.textCase);
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
      ...creationItems,
      ...this.applyTextCaseToSuggestions([
      ...variableMatches,
      ...propertyMatches.filter((item) => !item.alreadyMapped),
      ...propertyMatches.filter((item) => item.alreadyMapped),
      ].slice(0, Math.max(0, 100 - creationItems.length)), context.query, caseQuery.textCase),
    ];
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.createDiv({ text: item.kind === 'creation' ? `Create ${item.name}` : item.name });
    const detail = item.kind === 'creation'
      ? item.creationSource === undefined
        ? `Open ${item.creationType === 'fixed' ? 'fixed value' : 'property value'} editor`
        : `Create ${item.creationType === 'fixed' ? 'fixed value' : 'property mapping'}`
      : item.kind === 'variable'
      ? item.variableType === 'fixed'
        ? `Fixed value${item.file ? ` · ${item.file}` : ''}`
        : `Property value · ${item.file ?? ''}${item.property ? ` • ${item.property}` : ''}`
      : `Property · ${item.file ?? ''}`;
    el.createDiv({ text: detail, cls: 'suggest-meta' });
    if (item.creationError) {
      el.createDiv({ text: item.creationError, cls: 'suggest-sub mod-warning' });
    } else if (item.kind === 'creation' && item.creationSource !== undefined) {
      el.createDiv({
        text: item.creationType === 'fixed'
          ? `Value: ${truncateSuggestionValue(item.creationSource)}`
          : item.creationSource,
        cls: 'suggest-sub',
      });
    }
    if (item.display) el.createDiv({ text: item.display, cls: 'suggest-sub' });
    if (item.textCase) {
      el.createDiv({
        text: `Text case: ${getVariableTextCaseLabel(item.textCase)}`,
        cls: 'suggest-sub',
      });
    }
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
    if (item.kind === 'creation') {
      if (item.creationError) {
        new Notice(`Variable links: ${item.creationError}`);
        return;
      }
      if (!item.creationType) return;
      if (this.registry.getVariable(variableName)) {
        new Notice(`Variable links: ${variableName} already exists. Select the existing variable instead.`);
        return;
      }
      if (this.hasTextCaseNameConflict(variableName, item.textCase)) return;
      const target = this.getReplacementTarget(context);
      if (item.creationSource === undefined) {
        await this.onVariableCreationRequested({
          type: item.creationType,
          name: variableName,
          editor: context.editor,
          from: context.start,
          to: target.replaceEnd,
          originalText: context.editor.getRange(context.start, target.replaceEnd),
          textCase: item.textCase,
        });
        return;
      }

      try {
        if (item.creationType === 'fixed') {
          const parsed = parseFixedCreationSource(item.creationSource);
          if (!parsed.ok) throw new Error(parsed.error);
          await this.registry.saveVariable(variableName, {
            type: 'fixed',
            file: '',
            property: '',
            value: parsed.value,
          });
        } else {
          const propertyLink = parsePropertyLink(item.creationSource);
          await this.registry.saveVariable(variableName, {
            type: 'property',
            file: propertyLink.file,
            property: propertyLink.property,
          });
        }
        createdVariable = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Variable links: could not create ${variableName}: ${detail}`);
        return;
      }
    }
    if (item.kind === 'variable' && this.hasTextCaseNameConflict(variableName, item.textCase)) {
      return;
    }
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

      if (this.hasTextCaseNameConflict(variableName, item.textCase)) return;

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

    const target = this.getReplacementTarget(context);
    const token = formatVariableToken(variableName, target.activeSyntax, item.textCase);
    context.editor.replaceRange(
      token,
      context.start,
      target.replaceEnd,
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

  private getReplacementTarget(context: EditorSuggestContext): {
    activeSyntax: ReturnType<typeof getTokenSyntax>;
    replaceEnd: EditorPosition;
  } {
    const line = context.editor.getLine(context.end.line);
    const activeSyntax = getTokenSyntax(this.registry.plugin.settings);
    const trigger = findVariableTokenTrigger(
      line,
      context.end.ch,
      getRecognizedTokenSyntaxes(this.registry.plugin.settings),
    );
    const triggerSyntax = trigger?.start === context.start.ch ? trigger.syntax : activeSyntax;
    const hasAutoCloser = hasVariableTokenSuffixAt(line, context.end.ch, triggerSyntax);
    return {
      activeSyntax,
      replaceEnd: hasAutoCloser
        ? { line: context.end.line, ch: context.end.ch + triggerSyntax.suffix.length }
        : context.end,
    };
  }

  private getNamedCreationSuggestions(
    query: NamedCreationQuery | null,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    if (!query?.name || this.registry.getVariable(query.name)) return [];
    const syntax = getTokenSyntax(this.registry.plugin.settings);
    let nameError = '';
    if (!isValidNamedCreationName(query.name)) {
      nameError = 'Variable names in creation expressions cannot contain spaces.';
    } else if (query.name.includes(syntax.prefix) || query.name.includes(syntax.suffix)) {
      nameError = 'The variable name contains the active token prefix or suffix.';
    }

    const types: NamedCreationType[] = ['fixed', 'property'];
    return types
      .filter((type) => !query.typeQuery || type.startsWith(query.typeQuery))
      .map((type) => {
        let creationError = nameError;
        if (!creationError && query.hasSource) {
          if (type === 'fixed') {
            const parsed = parseFixedCreationSource(query.source ?? '');
            if (!parsed.ok) creationError = parsed.error;
          } else {
            try {
              parsePropertyLink(query.source ?? '');
            } catch (error) {
              creationError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        return {
          name: query.name,
          kind: 'creation' as const,
          creationType: type,
          creationSource: query.hasSource ? query.source ?? '' : undefined,
          creationError: creationError || undefined,
          textCase,
        };
      });
  }

  private applyTextCaseToSuggestions(
    items: SuggestItem[],
    rawQuery: string,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    if (!textCase) return items;
    const literalPrefix = rawQuery.trim().toLocaleLowerCase();
    return items.map((item) => {
      const selectsLiteralPunctuationName = item.kind === 'variable'
        && literalPrefix.length > 0
        && item.name.toLocaleLowerCase().startsWith(literalPrefix);
      return selectsLiteralPunctuationName ? item : { ...item, textCase };
    });
  }

  private hasTextCaseNameConflict(
    variableName: string,
    textCase: VariableTextCase | undefined,
  ): boolean {
    if (!textCase) return false;
    if (canRepresentVariableTextCase(
      variableName,
      textCase,
      (name) => this.registry.getVariable(name) !== null,
    )) return false;
    const wrappedName = wrapVariableNameWithTextCase(variableName, textCase);
    new Notice(`Variable links: cannot apply this text case because ${wrappedName} conflicts with an existing variable name.`);
    return true;
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
