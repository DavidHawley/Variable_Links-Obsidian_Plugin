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

export default class VariableSuggest extends EditorSuggest<SuggestItem> {
  constructor(
    app: App,
    private readonly indexer: Indexer,
    private readonly registry: Registry,
    private readonly onVariableCreated: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const fromIndex = line.lastIndexOf('{{', cursor.ch - 1);
    if (fromIndex === -1) return null;
    const query = line.slice(fromIndex + 2, cursor.ch);
    if (query.includes('}}') || /\s/.test(query)) return null;
    return {
      start: { line: cursor.line, ch: fromIndex },
      end: { line: cursor.line, ch: cursor.ch },
      query,
    };
  }

  getSuggestions(context: EditorSuggestContext): SuggestItem[] {
    const query = context.query.toLowerCase();
    const matches = (item: SuggestItem): boolean => !query
      || [item.name, item.display, item.file, item.property, item.value]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(query));
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name,
      kind: 'variable',
      display: entry.def.display,
      file: entry.filePath,
      property: getVariableType(entry.def) === 'property' ? entry.def.property : undefined,
      value: entry.def.value,
      variableType: getVariableType(entry.def),
    }));
    const properties: SuggestItem[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isRecord(frontmatter)) continue;
      for (const property of Object.keys(frontmatter)) {
        const alreadyMapped = Array.from(this.indexer.byName.values()).some((entry) =>
          getVariableType(entry.def) === 'property'
          && entry.filePath === file.path
          && entry.def.property === property
        );
        properties.push({
          name: property,
          kind: 'property',
          file: file.path,
          property,
          alreadyMapped,
        });
      }
    }
    const propertyMatches = properties.filter(matches);
    return [
      ...variables.filter(matches),
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
    const hasAutoCloser = line.slice(context.end.ch, context.end.ch + 2) === '}}';
    const token = `{{${variableName}}}`;
    context.editor.replaceRange(
      hasAutoCloser ? token.slice(0, -2) : token,
      context.start,
      context.end,
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
