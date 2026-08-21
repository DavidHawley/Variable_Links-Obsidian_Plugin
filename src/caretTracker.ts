import { App, TFile } from 'obsidian';
import Resolver from './resolver';
import Registry from './registry';

export type LastTouched = {
  name: string;
  value?: any;
  type?: string;
  sourceFile?: TFile | null;
  def?: any;
  editor?: any;
  from?: any;
  to?: any;
  timestamp: number;
};

export default class CaretTracker {
  app: App;
  registry: Registry;
  resolver: Resolver;
  plugin: any;
  pollMs: number = 200;
  timer: any = null;
  lastIndex: number = -1;
  lastTouched: LastTouched | null = null;

  constructor(app: App, plugin: any, registry: Registry, resolver: Resolver, pollMs = 200) {
    this.app = app;
    this.plugin = plugin;
    this.registry = registry;
    this.resolver = resolver;
    this.pollMs = pollMs;
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      try {
        await this.checkCaret();
      } catch (e) { console.error('CaretTracker check error', e); }
      this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async checkCaret() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) return;
    const view: any = leaf.view;
    if (!view || view.getViewType?.() !== 'markdown') return;
    const editor = view.editor;
    if (!editor || typeof editor.getValue !== 'function') return;

    // determine caret index
    let caretIndex: number | null = null;
    try {
      const cm = editor.cm;
      // CM6 path (head position)
      if (cm && cm.viewState && cm.viewState.state && cm.viewState.state.selection && cm.viewState.state.selection.main) {
        caretIndex = cm.viewState.state.selection.main.head;
      }
    } catch (e) { }

    // CM5/other fallback: compute index from cursor line/ch
    try {
      if (caretIndex === null && typeof editor.getCursor === 'function') {
        const cur = editor.getCursor();
        if (cur && typeof cur.line === 'number' && typeof cur.ch === 'number') {
          const textForIndex = editor.getValue();
          const lines = textForIndex.split(/\r?\n/);
          let idx = 0;
          for (let i = 0; i < cur.line; i++) idx += (lines[i]?.length ?? 0) + 1;
          idx += cur.ch;
          caretIndex = idx;
        }
      }
    } catch (e) { }

    // If still null, give up
    if (caretIndex === null) return;

    if (caretIndex === this.lastIndex) return;
    this.lastIndex = caretIndex;

    const text = editor.getValue();
    const token = this.findTokenAtIndex(text, caretIndex);
    if (!token) return;

    const varName = token.name;
    // resolve and set lastTouched
    const res = await this.resolver.resolve(varName);
    const def = this.registry.getVariable(varName);
    this.lastTouched = {
      name: varName,
      value: res.ok ? res.value : undefined,
      type: res.type,
      sourceFile: res.sourceFile || null,
      def,
      editor,
      from: this.positionAtIndex(editor, text, token.start),
      to: this.positionAtIndex(editor, text, token.end),
      timestamp: Date.now(),
    };

    // debug log when variable detected (use console.log to ensure visibility)
    try { console.log('Variable Links: caret detected variable', this.lastTouched.name, 'value:', this.lastTouched.value); } catch (e) {}

    // notify plugin/view
    try { if (this.plugin && typeof this.plugin.onCaretVariableChanged === 'function') this.plugin.onCaretVariableChanged(this.lastTouched); } catch (e) {}
  }

  findTokenAtIndex(text: string, index: number): { name: string; start: number; end: number } | null {
    if (!text || index < 0 || index > text.length) return null;
    // search backwards for '{{'
    const start = text.lastIndexOf('{{', index);
    if (start === -1) return null;
    const end = text.indexOf('}}', index);
    if (end === -1) return null;
    // extract between
    const inner = text.slice(start + 2, end).trim();
    // validate simple token name (no spaces, not empty)
    if (!inner) return null;
    if (/\s/.test(inner)) return null;
    return { name: inner, start, end: end + 2 };
  }

  private positionAtIndex(editor: any, text: string, index: number) {
    if (typeof editor.offsetToPos === 'function') return editor.offsetToPos(index);
    if (typeof editor.posFromIndex === 'function') return editor.posFromIndex(index);
    const before = text.slice(0, index).split(/\r?\n/);
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
}
