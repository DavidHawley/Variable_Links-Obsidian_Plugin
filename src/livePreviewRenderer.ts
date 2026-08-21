import Resolver from './resolver';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;

/**
 * Uses CodeMirror's native replacement decorations rather than positioned DOM
 * overlays. The original token remains in the document and is restored while
 * its range contains the editor selection.
 */
export default class LivePreviewRenderer {
  private resolver: Resolver;
  private app: any;

  constructor(app: any, resolver: Resolver) {
    this.app = app;
    this.resolver = resolver;
  }

  createExtension(): any {
    const renderer = this;

    class VariableWidget extends WidgetType {
      constructor(private name: string) { super(); }

      eq(other: VariableWidget) { return other.name === this.name; }

      toDOM() {
        const el = document.createElement('span');
        el.className = 'variable-links-token variable-links-token-live-preview';
        el.textContent = '…';
        el.dataset.var = this.name;

        void renderer.resolver.resolve(this.name).then((result: any) => {
          if (!result.ok) {
            el.textContent = `[Missing: ${this.name}]`;
            el.classList.add('missing');
            el.title = result.error || '';
            return;
          }
          el.textContent = Array.isArray(result.value) ? result.value.join(', ') : String(result.value);
        }).catch(() => {
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
      const text = view.state.doc.toString();
      const selection = view.state.selection.main;
      let match: RegExpExecArray | null;
      TOKEN_REGEX.lastIndex = 0;
      while ((match = TOKEN_REGEX.exec(text)) !== null) {
        const from = match.index;
        const to = TOKEN_REGEX.lastIndex;
        // Do not replace the token while the caret or selection touches it.
        if (selection.from <= to && selection.to >= from) continue;
        builder.add(from, to, Decoration.replace({ widget: new VariableWidget(match[1].trim()) }));
      }
      return builder.finish();
    };

    return ViewPlugin.fromClass(class {
      decorations: any;
      constructor(view: any) { this.decorations = buildDecorations(view); }
      update(update: any) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    }, { decorations: (value: any) => value.decorations });
  }
}
