import { App, TFile } from 'obsidian';
import Indexer from './indexer';
import Registry from './registry';

interface SuggestItem {
  name: string;
  display?: string;
  file?: string;
  property?: string;
}

const BaseSuggest = (globalThis as any).EditorSuggest || null;

let VariableSuggestImpl: any;

if (BaseSuggest && typeof BaseSuggest === 'function') {
  VariableSuggestImpl = class VariableSuggest extends BaseSuggest {
    app: App;
    indexer: Indexer;
    registry: Registry;

    constructor(app: App, indexer: Indexer, registry: Registry) {
      super(app);
      this.app = app;
      this.indexer = indexer;
      this.registry = registry;
    }

    onTrigger(cursor: any, editor: any, file: TFile) {
      const line = editor.getLine(cursor.line);
      const to = cursor.ch;
      const fromIndex = line.lastIndexOf('{{', to - 1);
      if (fromIndex === -1) return null;
      const after = line.slice(fromIndex + 2, to);
      const query = after;
      return { range: { from: { line: cursor.line, ch: fromIndex }, to: { line: cursor.line, ch: to } }, query };
    }

    getSuggestions(context: {query: string}) {
      const q = (context.query || '').toLowerCase();
      const results: SuggestItem[] = [];
      for (const [name, entry] of this.indexer.byName.entries()) {
        const display = entry.def.display ?? '';
        const file = entry.filePath ?? '';
        const property = entry.def.property ?? '';
        if (!q || name.toLowerCase().includes(q) || String(display).toLowerCase().includes(q) || file.toLowerCase().includes(q) || property.toLowerCase().includes(q)) {
          results.push({ name, display, file, property });
        }
      }
      return results.slice(0, 100);
    }

    renderSuggestion(item: SuggestItem, el: HTMLElement) {
      const container = el as any;
      container.createEl('div', { text: item.name });
      if (item.display) container.createEl('div', { text: String(item.display), cls: 'suggest-sub' });
      if (item.file || item.property) container.createEl('div', { text: `${item.file || ''} • ${item.property || ''}`, cls: 'suggest-meta' });
    }

    selectSuggestion(item: SuggestItem, evt: MouseEvent | KeyboardEvent) {
      const ctx = (this as any).context as any;
      const editor = ctx?.editor;
      const range = ctx?.range;
      if (!editor || !range) return;
      editor.replaceRange(`{{${item.name}}}`, range.from, range.to);
    }
  };
} else {
  // Fallback no-op implementation to avoid plugin load failure if EditorSuggest isn't available
  VariableSuggestImpl = class VariableSuggest {
    constructor(app: App, indexer: Indexer, registry: Registry) {
      // no-op
    }
  } as any;
}

export default VariableSuggestImpl;
