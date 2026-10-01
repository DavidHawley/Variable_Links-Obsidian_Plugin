import { Modal, Notice, type App, type Editor, type EditorPosition, type TFile } from 'obsidian';
import type VariableLinksPlugin from './main';
import { parseComputedExpression } from './computed';
import { formatVariableToken, getTokenSyntax, type TokenSyntax } from './tokenSyntax';
import type { InlinePromotionPlan } from './registry';

export interface InlineExpressionTarget {
  sourcePath: string;
  syntax: TokenSyntax;
  isCurrent(): boolean | Promise<boolean>;
  replace(token: string): void | Promise<void>;
  focus(): void;
}

export function editorExpressionTarget(editor: Editor, from: EditorPosition, to: EditorPosition, sourcePath: string, syntax: TokenSyntax): InlineExpressionTarget {
  const original = editor.getRange(from, to);
  return {
    sourcePath, syntax,
    isCurrent: () => editor.getRange(from, to) === original,
    replace: (token) => {
      if (editor.getRange(from, to) !== original) throw new Error('The note changed while editing. Reopen this expression.');
      editor.replaceRange(token, from, to);
    },
    focus: () => editor.focus(),
  };
}

export function readingExpressionTarget(app: App, file: TFile, original: string, start: number, end: number, syntax: TokenSyntax): InlineExpressionTarget {
  return {
    sourcePath: file.path, syntax,
    isCurrent: async () => await app.vault.read(file) === original,
    replace: async (token) => {
      await app.vault.process(file, (current) => {
        if (current !== original) throw new Error('The note changed while editing. Reopen this expression.');
        return current.slice(0, start) + token + current.slice(end);
      });
    },
    focus: () => {},
  };
}

export class InlineExpressionEditor extends Modal {
  private generation = 0;
  private reviewGeneration = 0;
  private closed = false;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly target: InlineExpressionTarget,
    private readonly expression: string,
    private readonly promotionMode = false,
  ) { super(plugin.app); }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-quick-editor');
    this.setTitle(this.promotionMode ? 'Make into variable link' : 'Edit inline expression');
    this.contentEl.createDiv({ text: 'Inputs use existing Variable Links first, then exact properties from this note. Ctrl/Cmd+Enter saves. Escape cancels.', cls: 'variable-links-hint-text' });
    const form = this.contentEl.createDiv({ cls: 'variable-links-quick-form' });
    const label = form.createEl('label', { cls: 'variable-links-quick-field' });
    label.createSpan({ text: 'Expression' });
    const input = label.createEl('textarea', { attr: { rows: '4' } });
    input.value = this.expression;
    const preview = form.createDiv({ attr: { 'aria-live': 'polite' } });
    const error = form.createDiv({ cls: 'variable-links-editor-error', attr: { role: 'alert' } });
    const updatePreview = async (): Promise<void> => {
      const generation = ++this.generation;
      const result = await this.plugin.resolver?.resolveInline(input.value, this.target.sourcePath);
      if (generation !== this.generation || !preview.isConnected) return;
      preview.setText(result?.ok ? `Preview: ${String(result.value)}` : `[Expression error] ${result?.error ?? ''}`);
    };
    input.addEventListener('input', () => void updatePreview());
    void updatePreview();
    const replace = async (name: string): Promise<void> => {
      const token = formatVariableToken(name, this.target.syntax);
      await this.target.replace(token);
      this.close();
      this.target.focus();
    };
    let saving = false;
    const freezeControls = (): (() => void) => {
      const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button');
      const disabled = [...controls].map((control) => control.disabled);
      for (const control of controls) control.disabled = true;
      return () => { [...controls].forEach((control, index) => { control.disabled = disabled[index]; }); };
    };
    const save = async (): Promise<void> => {
      if (promoting || saving || this.closed) return;
      saving = true;
      const restore = freezeControls();
      try { parseComputedExpression(input.value); await replace(`=${input.value.trim()}`); }
      catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      finally { saving = false; restore(); }
    };
    const actions = form.createDiv({ cls: 'variable-links-quick-actions' });
    actions.createEl('button', { text: 'Save expression', cls: 'mod-cta' }).addEventListener('click', () => void save());
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } });
    const permanent = form.createEl('label', { cls: 'variable-links-quick-field' });
    permanent.createSpan({ text: 'Permanent name (optional)' });
    const name = permanent.createEl('input', { type: 'text' });
    let suggestedName: string | undefined;
    const suggestName = (): void => {
      if (name.value.trim() && name.value !== suggestedName) return;
      const registry = this.plugin.registry;
      if (!registry) return;
      const syntax = getTokenSyntax(this.plugin.settings);
      const base = ['math_', 'calc_', 'expression_', 'result_', 'math', 'calc', 'expression', 'result']
        .find((candidate) => !candidate.includes(syntax.prefix) && !candidate.includes(syntax.suffix));
      let inputs: Set<string>;
      try { inputs = new Set(parseComputedExpression(input.value).references.map((reference) => reference.name)); }
      catch { inputs = new Set(); } // An unfinished expression must still open for editing.
      suggestedName = undefined;
      name.value = '';
      if (base) {
        for (let number = 1; number <= 10_000; number++) {
          const candidate = `${base}${String(number).padStart(2, '0')}`;
          if (candidate.includes(syntax.prefix) || candidate.includes(syntax.suffix)
            || inputs.has(candidate) || registry.getVariable(candidate) || registry.getShortcutByCode(candidate)) continue;
          name.value = suggestedName = candidate;
          break;
        }
      }
      name.placeholder = 'Enter a permanent name';
    };
    suggestName();
    name.addEventListener('input', () => { suggestedName = undefined; });
    permanent.createSpan({ text: 'An unused name is suggested when blank. Nothing is created until you review and choose Create.', cls: 'variable-links-hint-text' });
    const summary = form.createDiv({ cls: 'variable-links-hint-text' });
    const review = actions.createEl('button', { text: 'Review permanent creation' });
    const promote = form.createEl('button', { text: 'Create reviewed variable and property links' });
    promote.disabled = true;
    let plan: InlinePromotionPlan | undefined;
    let promoting = false;
    review.addEventListener('click', () => {
      const registry = this.plugin.registry;
      if (!registry || promoting || saving || this.closed) return;
      suggestName();
      const generation = ++this.reviewGeneration;
      plan = undefined;
      promote.disabled = true;
      error.empty();
      summary.setText('Checking permanent inputs…');
      void registry.prepareInlinePromotion(name.value, input.value, this.target.sourcePath).then((prepared) => {
        if (generation !== this.reviewGeneration || !summary.isConnected) return;
        plan = prepared;
        const newProperties = prepared.additions.map((entry) => entry.name);
        const existing = prepared.inputs.filter((entry) => !newProperties.includes(entry.name)).map((entry) => `${entry.name} → ${entry.targetName}${entry.selector ?? ''}`);
        summary.setText(`Create “${prepared.name}” and ${newProperties.length} permanent property link(s) from ${this.target.sourcePath}: ${newProperties.join(', ') || 'none'}. Reuse: ${existing.join(', ') || 'none'}. These names will be available throughout the vault.`);
        promote.disabled = false;
      }).catch((reason: unknown) => {
        if (generation !== this.reviewGeneration || !summary.isConnected) return;
        summary.empty();
        error.setText(reason instanceof Error ? reason.message : String(reason));
      });
    });
    for (const control of [input, name]) control.addEventListener('input', () => { this.reviewGeneration++; plan = undefined; promote.disabled = true; summary.empty(); });
    promote.addEventListener('click', () => {
      if (promoting || saving || this.closed || !plan) return;
      const reviewedPlan = plan;
      promote.disabled = true;
      const registry = this.plugin.registry;
      if (!registry) { error.setText('The registry is unavailable'); return; }
      promoting = true;
      const restore = freezeControls();
      void (async () => {
        if (!await this.target.isCurrent()) throw new Error('The note changed. Reopen the expression.');
        if (this.closed) return;
        await registry.promoteInlineExpression(reviewedPlan);
        try { await replace(reviewedPlan.name); }
        catch (reason) { new Notice(`The permanent variable was created; ${reason instanceof Error ? reason.message : String(reason)}`); this.close(); }
      })().catch((reason: unknown) => {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        promoting = false;
        restore();
        promote.disabled = true;
      });
    });
    if (this.promotionMode) name.focus();
    else input.focus();
  }

  onClose(): void { this.closed = true; this.generation++; this.reviewGeneration++; this.plugin.releaseDialog(this); this.contentEl.empty(); }
}
