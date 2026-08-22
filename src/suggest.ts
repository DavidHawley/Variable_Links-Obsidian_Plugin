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
import Registry from './registry';

interface SuggestItem {
  name: string;
  kind: 'variable' | 'property';
  display?: string;
  file?: string;
  property?: string;
}

export default class VariableSuggest extends EditorSuggest<SuggestItem> {
  constructor(
    app: App,
    private readonly indexer: Indexer,
    private readonly registry: Registry,
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
      || [item.name, item.display, item.file, item.property]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(query));
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name,
      kind: 'variable',
      display: entry.def.display,
      file: entry.filePath,
      property: entry.def.property,
    }));
    const properties: SuggestItem[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isRecord(frontmatter)) continue;
      for (const property of Object.keys(frontmatter)) {
        const alreadyMapped = Array.from(this.indexer.byName.values()).some((entry) =>
          entry.filePath === file.path && entry.def.property === property
        );
        if (!alreadyMapped) {
          properties.push({ name: property, kind: 'property', file: file.path, property });
        }
      }
    }
    return [...variables.filter(matches), ...properties.filter(matches)].slice(0, 100);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.createDiv({ text: item.name });
    const detail = item.kind === 'variable'
      ? `Variable · ${item.file ?? ''}${item.property ? ` • ${item.property}` : ''}`
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
          file: item.file ?? '',
          property: item.property ?? item.name,
          display: item.property ?? item.name,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Variable Links: could not create ${variableName}: ${detail}`);
        return;
      }
    }

    const line = context.editor.getLine(context.end.line);
    const hasAutoCloser = line.slice(context.end.ch, context.end.ch + 2) === '}}';
    context.editor.replaceRange(
      hasAutoCloser ? `{{${variableName}` : `{{${variableName}}}`,
      context.start,
      context.end,
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
