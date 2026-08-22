import { App, Editor, MarkdownView } from 'obsidian';
import { Extension, RangeSetBuilder, StateEffect } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import Resolver from './resolver';

const TOKEN_REGEX = /\{\{\s*([^}\s]+)\s*}}/g;
const refreshVariableLinks = StateEffect.define<void>();

interface EditorWithCodeMirror extends Editor {
  cm?: EditorView;
}

interface PreviewMode {
  rerender?: (force: boolean) => void;
  renderer?: { rerender?: (force: boolean) => void };
}

type MarkdownViewInternals = MarkdownView & {
  editor: EditorWithCodeMirror;
  previewMode?: PreviewMode;
};

export default class LivePreviewRenderer {
  private revision = 0;
  private active = true;
  private timers = new Set<number>();

  constructor(
    private readonly app: App,
    private readonly resolver: Resolver,
  ) {}

  refresh(): void {
    if (!this.active) return;
    this.revision++;
    const views = this.getMarkdownViews();
    for (const view of views) {
      this.refreshEditor(view);
      this.rerenderPreview(view);
    }

    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.active) return;
      for (const view of views) this.rerenderPreview(view);
    }, 50);
    this.timers.add(timer);
  }

  unload(): void {
    if (!this.active) return;
    this.active = false;
    this.revision++;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const view of this.getMarkdownViews()) {
      this.refreshEditor(view);
      this.rerenderPreview(view);
    }
  }

  createExtension(): Extension {
    const renderVariable = (name: string, el: HTMLElement): void => {
      void this.resolveInto(name, el);
    };

    class VariableWidget extends WidgetType {
      constructor(
        private readonly name: string,
        private readonly revision: number,
        private readonly render: (name: string, el: HTMLElement) => void,
      ) {
        super();
      }

      eq(other: VariableWidget): boolean {
        return other.name === this.name && other.revision === this.revision;
      }

      toDOM(): HTMLElement {
        const el = createSpan({
          cls: 'variable-links-token variable-links-token-live-preview',
          text: '…',
        });
        el.dataset.var = this.name;
        this.render(this.name, el);
        return el;
      }

      ignoreEvent(): boolean {
        return false;
      }
    }

    const buildDecorations = (view: EditorView): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      if (!this.active) return builder.finish();
      const text = view.state.doc.toString();
      const selection = view.state.selection.main;
      let match: RegExpExecArray | null;
      TOKEN_REGEX.lastIndex = 0;
      while ((match = TOKEN_REGEX.exec(text)) !== null) {
        const name = match[1];
        if (!name) continue;
        const from = match.index;
        const to = TOKEN_REGEX.lastIndex;
        if (selection.from <= to && selection.to >= from) continue;
        builder.add(from, to, Decoration.replace({
          widget: new VariableWidget(name.trim(), this.revision, renderVariable),
        }));
      }
      return builder.finish();
    };

    return ViewPlugin.fromClass(class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate): void {
        const refreshRequested = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshVariableLinks))
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || refreshRequested) {
          this.decorations = buildDecorations(update.view);
        }
      }
    }, {
      decorations: (value) => value.decorations,
    });
  }

  private async resolveInto(name: string, el: HTMLElement): Promise<void> {
    try {
      const result = await this.resolver.resolve(name);
      if (!this.active) return;
      if (!result.ok) {
        el.textContent = `[Missing: ${name}]`;
        el.classList.add('missing');
        el.title = result.error ?? '';
        return;
      }
      el.textContent = Array.isArray(result.value)
        ? result.value.map(String).join(', ')
        : String(result.value);
    } catch {
      if (!this.active) return;
      el.textContent = `[Missing: ${name}]`;
      el.classList.add('missing');
    }
  }

  private getMarkdownViews(): MarkdownViewInternals[] {
    return this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView)
      .map((view) => view as MarkdownViewInternals);
  }

  private refreshEditor(view: MarkdownViewInternals): void {
    try {
      view.editor.cm?.dispatch({ effects: refreshVariableLinks.of(undefined) });
    } catch {
      // The editor can disappear while a pane is being closed.
    }
  }

  private rerenderPreview(view: MarkdownViewInternals): void {
    try {
      if (typeof view.previewMode?.rerender === 'function') {
        view.previewMode.rerender(true);
      } else {
        view.previewMode?.renderer?.rerender?.(true);
      }
    } catch {
      // Reading View may be transitioning between files.
    }
  }
}
