import { App, Editor, EditorPosition, MarkdownView, TFile } from 'obsidian';
import type VariableLinksPlugin from './main';
import Registry, { VariableDefinition } from './registry';
import Resolver from './resolver';
import { findVariableTokenAt, getRecognizedTokenSyntaxes } from './tokenSyntax';

export interface LastTouched {
  name: string;
  value?: unknown;
  type?: string;
  sourceFile: TFile | null;
  def: VariableDefinition | null;
  editor: Editor;
  from: EditorPosition;
  to: EditorPosition;
  timestamp: number;
}

export default class CaretTracker {
  lastTouched: LastTouched | null = null;
  private timer: number | null = null;
  private running = false;
  private generation = 0;
  private lastIndex = -1;

  constructor(
    private readonly app: App,
    private readonly plugin: VariableLinksPlugin,
    private readonly registry: Registry,
    private readonly resolver: Resolver,
    private readonly pollMs = 200,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    void this.runLoop(generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.lastIndex = -1;
    this.lastTouched = null;
  }

  findTokenAtIndex(text: string, index: number): { name: string; start: number; end: number } | null {
    return findVariableTokenAt(
      text,
      index,
      getRecognizedTokenSyntaxes(this.plugin.settings),
      (name) => this.registry.getVariable(name) !== null,
    );
  }

  private async runLoop(generation: number): Promise<void> {
    try {
      await this.checkCaret();
    } catch {
      // A transient editor state will be checked again on the next poll.
    }
    if (!this.running || this.generation !== generation) return;
    this.timer = window.setTimeout(() => void this.runLoop(generation), this.pollMs);
  }

  private async checkCaret(): Promise<void> {
    if (!this.running) return;
    const generation = this.generation;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const caretIndex = editor.posToOffset(editor.getCursor('head'));
    if (caretIndex === this.lastIndex) return;
    this.lastIndex = caretIndex;

    const text = editor.getValue();
    const token = this.findTokenAtIndex(text, caretIndex);
    if (!token) return;

    const result = await this.resolver.resolve(token.name);
    if (!this.running || this.generation !== generation) return;
    this.lastTouched = {
      name: token.name,
      value: result.ok ? result.value : undefined,
      type: result.type,
      sourceFile: result.sourceFile ?? null,
      def: this.registry.getVariable(token.name),
      editor,
      from: editor.offsetToPos(token.start),
      to: editor.offsetToPos(token.end),
      timestamp: Date.now(),
    };
    this.plugin.onCaretVariableChanged(this.lastTouched);
  }
}
