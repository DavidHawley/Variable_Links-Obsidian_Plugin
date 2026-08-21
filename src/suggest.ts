import { App, EditorSuggest, Notice, TFile } from 'obsidian';
import Indexer from './indexer';
import Registry from './registry';

interface SuggestItem {
  name: string;
  kind: 'variable' | 'property';
  display?: string;
  file?: string;
  property?: string;
}

/** Suggest registry variables and unregistered frontmatter properties after {{. */
export default class VariableSuggest extends EditorSuggest<SuggestItem> {
  app: App;
  indexer: Indexer;
  registry: Registry;

  constructor(app: App, indexer: Indexer, registry: Registry) {
    super(app);
    this.app = app;
    this.indexer = indexer;
    this.registry = registry;
  }

  onTrigger(cursor: any, editor: any, _file: TFile) {
    const line = editor.getLine(cursor.line);
    const fromIndex = line.lastIndexOf('{{', cursor.ch - 1);
    if (fromIndex === -1) return null;
    const query = line.slice(fromIndex + 2, cursor.ch);
    if (query.includes('}}') || /\s/.test(query)) return null;
    return {
      start: { line: cursor.line, ch: fromIndex },
      end: { line: cursor.line, ch: cursor.ch },
      query
    };
  }

  getSuggestions(context: { query: string }): SuggestItem[] {
    const query = (context.query || '').toLowerCase();
    const matches = (item: SuggestItem) => !query || [item.name, item.display, item.file, item.property]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name, kind: 'variable', display: entry.def.display, file: entry.filePath, property: entry.def.property
    }));
    const properties: SuggestItem[] = [];
    const files = (this.app.vault as any).getMarkdownFiles?.() || [];
    for (const file of files) {
      const frontmatter = (this.app as any).metadataCache?.getFileCache?.(file)?.frontmatter;
      if (!frontmatter) continue;
      for (const property of Object.keys(frontmatter)) {
        const alreadyMapped = Array.from(this.indexer.byName.values()).some((entry) =>
          entry.filePath === file.path && entry.def.property === property
        );
        if (alreadyMapped) continue;
        properties.push({ name: property, kind: 'property', file: file.path, property });
      }
    }
    return [...variables.filter(matches), ...properties.filter(matches)].slice(0, 100);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement) {
    const container = el as any;
    container.createEl('div', { text: item.name });
    const detail = item.kind === 'variable'
      ? `Variable · ${item.file || ''}${item.property ? ` • ${item.property}` : ''}`
      : `Property · ${item.file || ''}`;
    container.createEl('div', { text: detail, cls: 'suggest-meta' });
    if (item.display) container.createEl('div', { text: String(item.display), cls: 'suggest-sub' });
  }

  async selectSuggestion(item: SuggestItem, _event: MouseEvent | KeyboardEvent) {
    const context = (this as any).context;
    if (!context?.editor || !context?.start || !context?.end) return;
    let variableName = item.name;

    if (item.kind === 'property') {
      const base = (item.property || item.name)
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
          file: item.file || '',
          property: item.property || item.name,
          display: item.property || item.name
        });
      } catch (error) {
        new Notice(`Variable Links: could not create ${variableName}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const line = context.editor.getLine(context.end.line);
    const hasAutoCloser = line.slice(context.end.ch, context.end.ch + 2) === '}}';
    context.editor.replaceRange(
      hasAutoCloser ? `{{${variableName}` : `{{${variableName}}}`,
      context.start,
      context.end
    );
  }
}
