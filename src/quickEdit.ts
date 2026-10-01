import { Modal, Notice, TFile } from 'obsidian';
import type VariableLinksPlugin from './main';
import { getVariableShape, getVariableType, type VariableDefinition } from './registry';
import { filePathFromLink, toFileLink } from './linkSyntax';
import { createTemporalValue, temporalInputText } from './temporal';
import { parseEditedValue, valueEditorText, valuesEqual } from './valueEditing';

/** One shared editor for token gestures, keyboard commands and manager inspectors. */
export class QuickVariableEditor extends Modal {
  private baseline?: VariableDefinition;
  private busy = false;
  private dirty = false;
  private previewGeneration = 0;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly variableName: string,
    private readonly inspector = false,
    private readonly anchor?: HTMLElement,
  ) { super(plugin.app); }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-quick-editor');
    if (!this.inspector && this.anchor) {
      const rect = this.anchor.getBoundingClientRect();
      this.modalEl.addClass('variable-links-quick-popover');
      this.modalEl.setCssProps({
        '--variable-links-editor-left': `${Math.max(8, Math.min(rect.left, this.anchor.ownerDocument.defaultView!.innerWidth - 380))}px`,
        '--variable-links-editor-top': `${Math.max(8, Math.min(rect.bottom + 6, this.anchor.ownerDocument.defaultView!.innerHeight - 430))}px`,
      });
    }
    void this.render().catch((error: unknown) => {
      this.contentEl.createDiv({ text: error instanceof Error ? error.message : String(error), cls: 'variable-links-editor-error' });
    });
  }

  onClose(): void {
    this.previewGeneration++;
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
    this.anchor?.focus();
  }

  private async render(): Promise<void> {
    const registry = this.plugin.registry;
    const definition = registry?.getVariable(this.variableName);
    if (!definition || !registry) throw new Error('This variable no longer exists');
    this.baseline = JSON.parse(JSON.stringify(definition)) as VariableDefinition;
    const type = getVariableType(definition);
    const list = getVariableShape(definition) === 'list';
    this.setTitle(`${this.inspector ? 'Edit variable' : 'Quick edit'}: ${this.variableName}`);
    const hint = this.contentEl.createDiv({ cls: 'variable-links-hint-text' });
    hint.setText(type === 'property'
      ? `Source: ${definition.file} → ${definition.property}. Editing its value changes the source note and every reference.`
      : 'Saving changes this Variable Link everywhere it is used.');
    const form = this.contentEl.createDiv({ cls: 'variable-links-quick-form' });
    const field = (label: string, value: string, parent = form): HTMLInputElement => {
      const row = parent.createEl('label', { cls: 'variable-links-quick-field' });
      row.createSpan({ text: label });
      const input = row.createEl('input', { type: 'text' });
      input.value = value;
      return input;
    };
    const checkbox = (label: string, value: boolean): HTMLInputElement => {
      const row = form.createEl('label', { cls: 'variable-links-quick-checkbox' });
      const input = row.createEl('input', { type: 'checkbox' });
      input.checked = value;
      row.createSpan({ text: label });
      return input;
    };
    const name = this.inspector ? field('Name', this.variableName) : null;
    const display = this.inspector ? field('Display name', definition.display ?? '') : null;
    const favorite = this.inspector ? checkbox('Favorite', definition.favorite === true) : null;
    const linkEnabled = this.inspector ? checkbox('Enable click-through link', definition.linkEnabled !== false) : null;
    const link = this.inspector ? field('Link note (optional)', filePathFromLink(definition.link ?? '')) : null;
    let mode: HTMLSelectElement | null = null;
    if (type === 'property') {
      const row = form.createEl('label', { cls: 'variable-links-quick-field' });
      row.createSpan({ text: 'Edit' });
      mode = row.createEl('select');
      mode.createEl('option', { value: 'value', text: 'Source property value' });
      mode.createEl('option', { value: 'mapping', text: 'Variable definition / source mapping' });
      mode.value = this.inspector ? 'mapping' : 'value';
    }
    const mapping = form.createDiv();
    const note = type === 'property' ? field('Source note', filePathFromLink(definition.file) || definition.file, mapping) : null;
    const property = type === 'property' ? field('Note property', definition.property, mapping) : null;
    if (note) {
      const suggestions = mapping.createEl('datalist', { attr: { id: `variable-links-notes-${definition.guid}` } });
      for (const file of this.app.vault.getMarkdownFiles()) suggestions.createEl('option', { value: file.path });
      note.setAttribute('list', suggestions.id);
    }
    if (this.inspector && definition.managed) form.createDiv({ text: `Managed by Autolink profile: ${definition.managed.profileId}`, cls: 'variable-links-hint-text' });
    const valueGroup = form.createDiv();
    const result = type === 'property' ? await this.plugin.resolver?.resolve(this.variableName) : null;
    if (!this.contentEl.isConnected) return;
    const sourceFile = result?.sourceFile;
    const frontmatter = sourceFile ? this.plugin.resolver?.extractFrontmatter(await this.app.vault.read(sourceFile)) : null;
    if (!this.contentEl.isConnected) return;
    const originalValue = frontmatter?.[definition.property];
    const propertyError = type === 'property' && (!sourceFile || !frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, definition.property));
    const valueLabel = valueGroup.createEl('label', { cls: 'variable-links-quick-field' });
    valueLabel.createSpan({ text: type === 'computed' ? 'Expression' : definition.temporal ? 'Canonical date/time value' : list ? 'List values' : 'Value' });
    const input = valueLabel.createEl('textarea', { attr: { rows: type === 'computed' || list ? '4' : '2' } });
    input.value = type === 'computed' ? definition.expression ?? ''
      : type === 'property' ? valueEditorText(originalValue)
      : definition.temporal ? temporalInputText(definition.temporal)
      : list ? JSON.stringify((definition.fixedItems ?? []).map((item) => item.value), null, 2) : definition.value ?? '';
    if (list && type === 'fixed') valueGroup.createDiv({ text: 'Edit the JSON list values in their existing order. Use the full editor to add, remove, reorder, or change permanent keys.', cls: 'variable-links-hint-text' });
    if (type === 'property' && Array.isArray(originalValue)) valueGroup.createDiv({ text: 'Use a JSON list. Existing named selectors follow their saved values; use the full editor to update keys after changing list values.', cls: 'variable-links-hint-text' });
    const status = form.createDiv({ cls: 'variable-links-hint-text', attr: { 'aria-live': 'polite' } });
    const errorEl = form.createDiv({ cls: 'variable-links-editor-error', attr: { role: 'alert' } });
    if (propertyError || (type === 'property' && !result?.ok)) errorEl.setText(result?.error ?? 'The source property could not be resolved; edit its mapping instead.');
    const preview = form.createDiv({ cls: 'variable-links-hint-text', attr: { 'aria-live': 'polite' } });
    const updatePreview = async (): Promise<void> => {
      if (type !== 'computed') return;
      const generation = ++this.previewGeneration;
      const resolved = await this.plugin.resolver?.previewComputed(input.value, definition.dependencies, definition.precision);
      if (generation !== this.previewGeneration || !preview.isConnected) return;
      preview.setText(resolved?.ok ? `Preview: ${String(resolved.value)}` : `[Expression error] ${resolved?.error ?? ''}`);
    };
    input.addEventListener('input', () => void updatePreview());
    void updatePreview();
    const updateMode = (): void => {
      const editingValue = mode?.value === 'value';
      mapping.hidden = type !== 'property' || editingValue;
      valueGroup.hidden = type === 'property' && !editingValue;
      for (const control of [name, display, favorite, linkEnabled, link]) if (control) control.disabled = editingValue;
    };
    let previousMode = mode?.value;
    mode?.addEventListener('change', () => {
      if (this.dirty && mode) {
        mode.value = previousMode ?? 'value';
        errorEl.setText('Save or cancel these changes before switching between the source value and mapping.');
        return;
      }
      previousMode = mode?.value;
      updateMode();
    });
    updateMode();
    const markDirty = (event: Event): void => {
      if (event.target === mode) return;
      this.dirty = true;
      status.setText('Unsaved changes');
    };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    const actions = this.contentEl.createDiv({ cls: 'variable-links-quick-actions' });
    const save = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    actions.createEl('button', { text: 'Open full editor' }).addEventListener('click', () => {
      if (this.busy) return;
      if (this.dirty) { errorEl.setText('Save or cancel these changes before opening the full editor.'); return; }
      this.close();
      void this.plugin.openVariableProperties(this.variableName);
    });
    const saveChanges = async (): Promise<void> => {
      if (this.busy) return;
      this.busy = true;
      save.disabled = true;
      for (const control of [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'), ...actions.querySelectorAll<HTMLButtonElement>('button')]) control.disabled = true;
      try {
        const current = definition.guid ? registry.getVariableByGuid(definition.guid) : null;
        if (!current || current.name !== this.variableName || !valuesEqual(current.definition, this.baseline)) throw new Error('This variable changed while the editor was open. Cancel and reopen it to use the latest settings.');
        if (type === 'property' && mode?.value === 'value') {
          if (propertyError || !(sourceFile instanceof TFile)) throw new Error('Choose source mapping to repair the missing property');
          const next = parseEditedValue(input.value, originalValue);
          if (definition.temporal) {
            if (typeof next !== 'string') throw new Error('Date/time properties must contain an ISO text value');
            createTemporalValue(next, definition.temporal.kind, definition.temporal.format);
          }
          await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
            if (!Object.prototype.hasOwnProperty.call(frontmatter, definition.property) || !valuesEqual(frontmatter[definition.property], originalValue)) throw new Error('The source property changed while editing. Cancel and reopen to refresh.');
            frontmatter[definition.property] = next;
          });
        } else {
          const next = { ...definition };
          if (display) next.display = display.value;
          if (favorite) next.favorite = favorite.checked;
          if (linkEnabled) next.linkEnabled = linkEnabled.checked;
          if (link) next.link = link.value ? toFileLink(link.value) : undefined;
          if (type === 'property') {
            const path = (note?.value ?? '').replace(/\.md$/iu, '') + '.md';
            const file = this.app.vault.getFileByPath(path);
            if (!file || !property?.value.trim()) throw new Error('Choose an existing source note and a property');
            const fm = this.plugin.resolver?.extractFrontmatter(await this.app.vault.read(file)) ?? {};
            if (!Object.prototype.hasOwnProperty.call(fm, property.value.trim())) throw new Error('That property does not exist in the selected note');
            next.file = toFileLink(file.path);
            next.property = property.value.trim();
          } else if (type === 'computed') next.expression = input.value;
          else if (definition.temporal) next.temporal = createTemporalValue(input.value, definition.temporal.kind, definition.temporal.format);
          else if (list) {
            const values: unknown = JSON.parse(input.value);
            if (!Array.isArray(values) || values.length !== (definition.fixedItems ?? []).length || values.some((value) => typeof value !== 'string')) throw new Error('Keep the same number of text values; use the full list editor for structural changes');
            next.fixedItems = definition.fixedItems?.map((item, index) => ({ ...item, value: values[index] as string }));
          } else next.value = input.value;
          await registry.saveVariable(name?.value ?? this.variableName, next, this.variableName, this.baseline);
        }
        this.plugin.livePreviewRenderer?.refresh();
        new Notice('Variable links: changes saved');
        this.close();
      } catch (error) {
        errorEl.setText(error instanceof Error ? error.message : String(error));
        this.busy = false;
        for (const control of [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'), ...actions.querySelectorAll<HTMLButtonElement>('button')]) control.disabled = false;
        updateMode();
      }
    };
    save.addEventListener('click', () => void saveChanges());
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (!(event.target instanceof HTMLTextAreaElement) || event.ctrlKey || event.metaKey)) {
        event.preventDefault(); void saveChanges();
      }
    });
    (this.inspector ? name : input)?.focus();
  }
}

export class BulkVariableFlagsEditor extends Modal {
  constructor(private readonly plugin: VariableLinksPlugin, private readonly entries: readonly { name: string; definition: VariableDefinition }[]) { super(plugin.app); }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.setTitle(`Edit ${this.entries.length} selected variables`);
    this.contentEl.createDiv({ text: 'This includes every selected variable, including selections hidden by filters. Review all names before applying.', cls: 'variable-links-hint-text' });
    const selectors = new Map<'favorite' | 'hidden' | 'linkEnabled', HTMLSelectElement>();
    for (const [key, label] of [['favorite', 'Favorite'], ['hidden', 'Hidden value'], ['linkEnabled', 'Click-through link']] as const) {
      const row = this.contentEl.createEl('label', { cls: 'variable-links-quick-field' });
      row.createSpan({ text: label });
      const select = row.createEl('select');
      for (const [value, text] of [['', 'Leave unchanged'], ['true', 'Enabled'], ['false', 'Disabled']]) select.createEl('option', { value, text });
      selectors.set(key, select);
    }
    const preview = this.contentEl.createDiv();
    const error = this.contentEl.createDiv({ cls: 'variable-links-editor-error', attr: { role: 'alert' } });
    const actions = this.contentEl.createDiv({ cls: 'variable-links-quick-actions' });
    const review = actions.createEl('button', { text: 'Preview changes' });
    const apply = actions.createEl('button', { text: 'Apply reviewed changes', cls: 'mod-cta' });
    apply.disabled = true;
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    let patch: Partial<Pick<VariableDefinition, 'favorite' | 'hidden' | 'linkEnabled'>> = {};
    let busy = false;
    for (const select of selectors.values()) select.addEventListener('change', () => { apply.disabled = true; preview.empty(); });
    review.addEventListener('click', () => {
      if (busy) return;
      patch = {};
      for (const [key, select] of selectors) if (select.value) patch[key] = select.value === 'true';
      if (!Object.keys(patch).length) { error.setText('Choose at least one change'); return; }
      error.empty();
      preview.empty();
      const list = preview.createEl('ul');
      for (const entry of this.entries) list.createEl('li', { text: `${entry.name}: ${Object.entries(patch).map(([key, value]) => `${key} → ${String(value)}`).join(', ')}` });
      apply.disabled = false;
    });
    apply.addEventListener('click', () => {
      if (busy || apply.disabled) return;
      const registry = this.plugin.registry;
      if (!registry) { error.setText('The registry is unavailable'); return; }
      busy = true;
      apply.disabled = true;
      review.disabled = true;
      for (const select of selectors.values()) select.disabled = true;
      void registry.updateVariableFlags(this.entries, patch).then(() => this.close()).catch((reason: unknown) => {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        busy = false;
        review.disabled = false;
        for (const select of selectors.values()) select.disabled = false;
      });
    });
  }

  onClose(): void { this.plugin.releaseDialog(this); this.contentEl.empty(); }
}
