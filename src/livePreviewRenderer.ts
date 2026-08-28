import { App, Editor, editorLivePreviewField, MarkdownView } from 'obsidian';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Extension, RangeSetBuilder, StateEffect } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import Resolver from './resolver';
import { applyVariableAppearance, getEffectiveVariableAppearance } from './appearance';

const TOKEN_REGEX = /\{\{\s*([^}\s]+)\s*}}/g;
const refreshVariableLinks = StateEffect.define<void>();

const NON_PROSE_NODE_FRAGMENTS = [
  'code',
  'comment',
  'frontmatter',
  'html',
  'math',
  'yaml',
];

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

function isLivePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField, false) === true;
}

function isNonProseSyntaxNode(name: string): boolean {
  const normalized = name.replace(/[-_]/g, '').toLowerCase();
  return normalized === 'url'
    || normalized.includes('linkdestination')
    || NON_PROSE_NODE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isInsideNonProseSyntax(state: EditorState, from: number, to: number): boolean {
  const position = Math.min(from + 1, Math.max(from, to - 1));
  let node = syntaxTree(state).resolve(position, 1);
  while (true) {
    if (isNonProseSyntaxNode(node.name)) return true;
    const parent = node.parent;
    if (!parent) return false;
    node = parent;
  }
}

function isInsideWikiLinkTarget(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(from);
  if (to > line.to) return false;
  const relativeFrom = from - line.from;
  const relativeTo = to - line.from;
  const before = line.text.slice(0, relativeFrom);
  const open = before.lastIndexOf('[[');
  if (open === -1 || open < before.lastIndexOf(']]')) return false;
  const close = line.text.indexOf(']]', relativeTo);
  if (close === -1) return false;
  const alias = line.text.indexOf('|', open + 2);
  return alias === -1 || relativeFrom < alias;
}

function shouldRenderToken(state: EditorState, from: number, to: number): boolean {
  return isLivePreview(state)
    && !isInsideNonProseSyntax(state, from, to)
    && !isInsideWikiLinkTarget(state, from, to);
}

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
      if (!this.active || !isLivePreview(view.state)) return builder.finish();
      const selection = view.state.selection.main;
      const visibleLineRanges: Array<{ from: number; to: number }> = [];
      for (const range of view.visibleRanges) {
        const from = view.state.doc.lineAt(range.from).from;
        const to = view.state.doc.lineAt(range.to).to;
        const previous = visibleLineRanges[visibleLineRanges.length - 1];
        if (previous && from <= previous.to) previous.to = Math.max(previous.to, to);
        else visibleLineRanges.push({ from, to });
      }

      for (const range of visibleLineRanges) {
        const text = view.state.sliceDoc(range.from, range.to);
        let match: RegExpExecArray | null;
        TOKEN_REGEX.lastIndex = 0;
        while ((match = TOKEN_REGEX.exec(text)) !== null) {
          const name = match[1];
          if (!name) continue;
          const from = range.from + match.index;
          const to = range.from + TOKEN_REGEX.lastIndex;
          if (selection.from <= to && selection.to >= from) continue;
          if (!shouldRenderToken(view.state, from, to)) continue;
          builder.add(from, to, Decoration.replace({
            widget: new VariableWidget(name.trim(), this.revision, renderVariable),
          }));
        }
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
        const livePreviewChanged = isLivePreview(update.startState) !== isLivePreview(update.state);
        if (update.docChanged
          || update.selectionSet
          || update.viewportChanged
          || refreshRequested
          || livePreviewChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    }, {
      decorations: (value) => value.decorations,
    });
  }

  private async resolveInto(name: string, el: HTMLElement): Promise<void> {
    applyVariableAppearance(
      el,
      getEffectiveVariableAppearance(
        this.resolver.registry.getVariable(name)?.appearance,
        this.resolver.registry.plugin.settings,
      ),
    );
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
