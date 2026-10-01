import { Editor, Modal, Notice, type EditorPosition } from 'obsidian';
import type VariableLinksPlugin from './main';
import { parseComputedExpression } from './computed';
import { formatVariableToken, getTokenSyntax, type TokenSyntax } from './tokenSyntax';
import type { InlinePromotionPlan } from './registry';

export class InlineExpressionEditor extends Modal {
  private generation = 0;
  private reviewGeneration = 0;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly editor: Editor,
    private readonly from: EditorPosition,
    private readonly to: EditorPosition,
    private readonly original: string,
    private readonly expression: string,
    private readonly sourcePath: string,
    private readonly syntax: TokenSyntax,
  ) { super(plugin.app); }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-quick-editor');
    this.setTitle('Edit inline expression');
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
      const result = await this.plugin.resolver?.resolveInline(input.value, this.sourcePath);
      if (generation !== this.generation || !preview.isConnected) return;
      preview.setText(result?.ok ? `Preview: ${String(result.value)}` : `[Expression error] ${result?.error ?? ''}`);
    };
    input.addEventListener('input', () => void updatePreview());
    void updatePreview();
    const replace = (name: string): void => {
      const token = formatVariableToken(name, this.syntax);
      if (this.editor.getRange(this.from, this.to) !== this.original) throw new Error('The note changed while editing. Reopen this expression.');
      this.editor.replaceRange(token, this.from, this.to);
      this.close();
      this.editor.focus();
    };
    const save = (): void => {
      if (promoting) return;
      try { parseComputedExpression(input.value); replace(`=${input.value.trim()}`); }
      catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
    };
    const actions = form.createDiv({ cls: 'variable-links-quick-actions' });
    actions.createEl('button', { text: 'Save expression', cls: 'mod-cta' }).addEventListener('click', save);
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); } });
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
      if (!registry || promoting) return;
      suggestName();
      const generation = ++this.reviewGeneration;
      plan = undefined;
      promote.disabled = true;
      error.empty();
      summary.setText('Checking permanent inputs…');
      void registry.prepareInlinePromotion(name.value, input.value, this.sourcePath).then((prepared) => {
        if (generation !== this.reviewGeneration || !summary.isConnected) return;
        plan = prepared;
        const newProperties = prepared.additions.map((entry) => entry.name);
        const existing = prepared.inputs.filter((entry) => !newProperties.includes(entry.name)).map((entry) => `${entry.name} → ${entry.targetName}${entry.selector ?? ''}`);
        summary.setText(`Create “${prepared.name}” and ${newProperties.length} permanent property link(s) from ${this.sourcePath}: ${newProperties.join(', ') || 'none'}. Reuse: ${existing.join(', ') || 'none'}. These names will be available throughout the vault.`);
        promote.disabled = false;
      }).catch((reason: unknown) => {
        if (generation !== this.reviewGeneration || !summary.isConnected) return;
        summary.empty();
        error.setText(reason instanceof Error ? reason.message : String(reason));
      });
    });
    for (const control of [input, name]) control.addEventListener('input', () => { this.reviewGeneration++; plan = undefined; promote.disabled = true; summary.empty(); });
    promote.addEventListener('click', () => {
      if (promoting || !plan) return;
      const reviewedPlan = plan;
      promote.disabled = true;
      if (this.editor.getRange(this.from, this.to) !== this.original) { error.setText('The note changed. Reopen the expression.'); return; }
      const registry = this.plugin.registry;
      if (!registry) { error.setText('The registry is unavailable'); return; }
      promoting = true;
      const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button');
      for (const control of controls) control.disabled = true;
      void registry.promoteInlineExpression(reviewedPlan).then(() => {
        try { replace(reviewedPlan.name); }
        catch (reason) { new Notice(`The permanent variable was created; ${reason instanceof Error ? reason.message : String(reason)}`); this.close(); }
      }).catch((reason: unknown) => {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        promoting = false;
        for (const control of controls) control.disabled = false;
        promote.disabled = true;
      });
    });
    input.focus();
  }

  onClose(): void { this.generation++; this.reviewGeneration++; this.plugin.releaseDialog(this); this.contentEl.empty(); }
}
