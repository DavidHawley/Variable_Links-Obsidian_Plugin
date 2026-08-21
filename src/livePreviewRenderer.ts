import Resolver from './resolver';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;
const refreshVariableLinks = StateEffect.define<void>();

/**
 * Uses CodeMirror's native replacement decorations rather than positioned DOM
 * overlays. The original token remains in the document and is restored while
 * its range contains the editor selection.
 */
export default class LivePreviewRenderer {
  private resolver: Resolver;
  private app: any;
  private revision = 0;
  private active = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(app: any, resolver: Resolver) {
    this.app = app;
    this.resolver = resolver;
  }

  /** Force open Markdown panes to resolve their variables again. */
  refresh() {
    if (!this.active) return;
    this.revision++;
    const leaves = this.getMarkdownLeaves();

    for (const leaf of leaves) {
      const editorView = leaf?.view?.editor?.cm;
      if (typeof editorView?.dispatch === 'function') {
        try { editorView.dispatch({ effects: refreshVariableLinks.of(undefined) }); }
        catch (error) {}
      }

      const previewMode = leaf?.view?.previewMode;
      try {
        if (typeof previewMode?.rerender === 'function') previewMode.rerender(true);
        else if (typeof previewMode?.renderer?.rerender === 'function') previewMode.renderer.rerender(true);
      } catch (error) {}
    }

    // File-change rendering can be queued just after a vault write. Run a
    // second Reading View pass once that queue has settled.
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.active) return;
      for (const leaf of leaves) {
        const previewMode = leaf?.view?.previewMode;
        try {
          if (typeof previewMode?.rerender === 'function') previewMode.rerender(true);
          else if (typeof previewMode?.renderer?.rerender === 'function') previewMode.renderer.rerender(true);
        } catch (error) {}
      }
    }, 50);
    this.timers.add(timer);
  }

  /** Cancel delayed work and remove this plugin's visible editor decorations. */
  unload() {
    if (!this.active) return;
    this.active = false;
    this.revision++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const leaf of this.getMarkdownLeaves()) {
      const editorView = leaf?.view?.editor?.cm;
      try {
        if (typeof editorView?.dispatch === 'function') {
          editorView.dispatch({ effects: refreshVariableLinks.of(undefined) });
        }
      } catch (error) {}
      const previewMode = leaf?.view?.previewMode;
      try {
        if (typeof previewMode?.rerender === 'function') previewMode.rerender(true);
        else if (typeof previewMode?.renderer?.rerender === 'function') previewMode.renderer.rerender(true);
      } catch (error) {}
    }
  }

  private getMarkdownLeaves(): any[] {
    const leaves: any[] = [];
    if (typeof this.app.workspace?.iterateAllLeaves === 'function') {
      this.app.workspace.iterateAllLeaves((leaf: any) => {
        if (leaf?.view?.getViewType?.() === 'markdown') leaves.push(leaf);
      });
    } else leaves.push(...(this.app.workspace?.getLeavesOfType?.('markdown') || []));
    return leaves;
  }

  createExtension(): any {
    const renderer = this;

    class VariableWidget extends WidgetType {
      constructor(private name: string, private revision: number) { super(); }

      eq(other: VariableWidget) { return other.name === this.name && other.revision === this.revision; }

      toDOM() {
        const el = document.createElement('span');
        el.className = 'variable-links-token variable-links-token-live-preview';
        el.textContent = '…';
        el.dataset.var = this.name;

        void renderer.resolver.resolve(this.name).then((result: any) => {
          if (!renderer.active) return;
          if (!result.ok) {
            el.textContent = `[Missing: ${this.name}]`;
            el.classList.add('missing');
            el.title = result.error || '';
            return;
          }
          el.textContent = Array.isArray(result.value) ? result.value.join(', ') : String(result.value);
        }).catch(() => {
          if (!renderer.active) return;
          el.textContent = `[Missing: ${this.name}]`;
          el.classList.add('missing');
        });
        return el;
      }

      // Let CodeMirror process mouse and keyboard events, including moving the
      // caret into this token so the source text becomes editable again.
      ignoreEvent() { return false; }
    }

    const buildDecorations = (view: any) => {
      const builder = new RangeSetBuilder();
      if (!renderer.active) return builder.finish();
      const text = view.state.doc.toString();
      const selection = view.state.selection.main;
      let match: RegExpExecArray | null;
      TOKEN_REGEX.lastIndex = 0;
      while ((match = TOKEN_REGEX.exec(text)) !== null) {
        const from = match.index;
        const to = TOKEN_REGEX.lastIndex;
        // Do not replace the token while the caret or selection touches it.
        if (selection.from <= to && selection.to >= from) continue;
        builder.add(from, to, Decoration.replace({ widget: new VariableWidget(match[1].trim(), renderer.revision) }));
      }
      return builder.finish();
    };

    return ViewPlugin.fromClass(class {
      decorations: any;
      constructor(view: any) { this.decorations = buildDecorations(view); }
      update(update: any) {
        const refreshRequested = update.transactions.some((transaction: any) =>
          transaction.effects.some((effect: any) => effect.is(refreshVariableLinks))
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || refreshRequested) {
          this.decorations = buildDecorations(update.view);
        }
      }
    }, { decorations: (value: any) => value.decorations });
  }
}
