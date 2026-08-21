import { ItemView, MarkdownRenderer, Notice } from 'obsidian';

export const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';

/** A split, editable sidebar for the selected variable and its info card. */
export class VariablePropertiesView extends ItemView {
  plugin: any;
  private contentEl: any = null;
  private selectedVariableName: string | null = null;

  constructor(leaf: any, plugin: any) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_VARIABLE_PANEL; }
  getDisplayText() { return 'Variable Properties'; }
  getIcon() { return 'list'; }

  async onOpen() {
    this.containerEl.empty();
    this.containerEl.addClass('variable-links-panel');
    this.contentEl = this.containerEl.createDiv('variable-links-panel-inner');
    await this.refresh();
  }

  async onClose() { this.contentEl = null; }

  async refresh() {
    if (!this.contentEl) return;
    this.contentEl.empty();

    const registry = this.plugin.registry;
    const last = this.plugin.caretTracker?.lastTouched;
    const names = (Array.from(registry?.data?.keys?.() || []) as string[]).sort((a, b) => a.localeCompare(b));
    if (this.selectedVariableName && !registry?.getVariable(this.selectedVariableName)) this.selectedVariableName = null;
    const activeName = this.selectedVariableName || last?.name || '';
    const definition = activeName ? registry?.getVariable(activeName) || {} : {};

    const toolbar = this.contentEl.createDiv('variable-links-panel-toolbar');
    const select = toolbar.createEl('select') as HTMLSelectElement;
    select.add(new Option(activeName && !definition.file ? `[New] ${activeName}` : 'Select a Variable Link…', ''));
    for (const name of names) select.add(new Option(name, name));
    select.value = definition.file ? activeName : '';
    select.addEventListener('change', () => {
      this.selectedVariableName = select.value || null;
      void this.refresh();
    });

    const setButton = toolbar.createEl('button', { text: 'Set token' }) as HTMLButtonElement;
    setButton.disabled = !activeName || !definition.file || !last?.editor || !last?.from || !last?.to;
    setButton.addEventListener('click', () => {
      if (setButton.disabled) return;
      last.editor.replaceRange(`{{${activeName}}}`, last.from, last.to);
      last.name = activeName;
      last.def = definition;
      new Notice(`Variable Links: token set to {{${activeName}}}`);
    });

    const deleteButton = toolbar.createEl('button', { text: 'Delete' }) as HTMLButtonElement;
    deleteButton.disabled = !activeName || !definition.file;
    deleteButton.addEventListener('click', async () => {
      if (deleteButton.disabled || !window.confirm(`Delete Variable Link “${activeName}”?`)) return;
      try {
        await registry.deleteVariable(activeName);
        if (last?.name === activeName) { last.def = null; last.value = undefined; }
        this.selectedVariableName = null;
        new Notice(`Variable Links: deleted {{${activeName}}}`);
        await this.refresh();
      } catch (error) {
        new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const layout = this.contentEl.createDiv('variable-links-panel-split');
    const propertiesPane = layout.createDiv('variable-links-panel-pane variable-links-panel-properties');
    const cardPane = layout.createDiv('variable-links-panel-pane variable-links-panel-infocard');

    propertiesPane.createEl('h4', { text: 'Variable properties' });
    cardPane.createEl('h4', { text: 'Info card' });

    if (!activeName) {
      propertiesPane.createEl('p', { text: 'No variable selected. Add a variable below or place the caret in a {{token}}.' });
      this.renderVariableForm(propertiesPane, '', {}, 'Add a variable');
      cardPane.createEl('p', { text: 'Select or create a variable to configure its info card.' });
      return;
    }

    const result = definition.file ? await this.plugin.resolver.resolve(activeName) : null;
    propertiesPane.createEl('h5', { text: `{{${activeName}}}` });
    const valueText = result?.ok ? String(result.value) : '[Missing]';
    const valueEl = propertiesPane.createDiv('variable-links-panel-value');
    await MarkdownRenderer.renderMarkdown(valueText, valueEl, '', this.plugin);

    const actions = propertiesPane.createDiv('variable-links-panel-actions');
    actions.createEl('button', { text: 'Open source' }).addEventListener('click', async () => {
      if (result?.sourceFile) await this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
    });
    actions.createEl('button', { text: 'Copy value' }).addEventListener('click', () => void navigator.clipboard?.writeText(valueText));

    this.renderVariableForm(
      propertiesPane,
      activeName,
      definition,
      definition.file ? 'Edit mapping' : 'Set up this variable'
    );
    if (definition.file) this.renderInfoCardForm(cardPane, activeName, definition);
    else cardPane.createEl('p', { text: 'Save the variable mapping before configuring its info card.' });
  }

  private renderVariableForm(parent: any, name: string, definition: any, title: string) {
    const section = parent.createEl('details', { cls: 'variable-links-panel-editor' });
    section.open = true;
    section.createEl('summary', { text: title });
    const form = section.createEl('form');
    const nameInput = this.addInput(form, 'Variable name', name, 'e.g. customer');
    const fileInput = this.addInput(form, 'Source note', definition.file || '', '[[People/John Smith]] or People/John Smith.md');
    const propertyInput = this.addInput(form, 'Property', definition.property || '', 'e.g. company');
    const displayInput = this.addInput(form, 'Display name (optional)', definition.display || '', 'e.g. John Smith');
    this.addSaveButton(form, name ? 'Save properties' : 'Add variable', async () => {
      const newName = nameInput.value.trim();
      await this.plugin.registry.saveVariable(newName, {
        file: fileInput.value,
        property: propertyInput.value,
        display: displayInput.value
      }, definition.file ? name : undefined);
      const touched = this.plugin.caretTracker?.lastTouched;
      if (touched?.name === name && newName !== name) {
        touched.name = newName;
        touched.def = this.plugin.registry.getVariable(newName);
      }
      this.selectedVariableName = newName;
      new Notice(`Variable Links: saved {{${newName}}}`);
      await this.refresh();
    });
  }

  private renderInfoCardForm(parent: any, name: string, definition: any) {
    const card = definition.card || {};
    parent.createEl('p', { text: 'Shown when hovering over this variable in Reading View.' });
    const form = parent.createEl('form', { cls: 'variable-links-panel-card-editor' });
    const titleInput = this.addInput(form, 'Title', card.title || '', 'e.g. John Smith');
    const noteInput = this.addTextarea(form, 'Note (Markdown supported)', card.note || '', 'Short description');
    const fieldsInput = this.addInput(
      form,
      'Fields (property, [[File]]#property, or either with :Display Name)',
      Array.isArray(card.fields) ? card.fields.join(', ') : '',
      'email:Email Address, [[Projects/Plan]]#due:Due Date'
    );
    this.attachFieldSuggestions(fieldsInput, definition.file || '');
    const sourceRow = form.createDiv('variable-links-panel-checkbox');
    const sourceInput = sourceRow.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
    sourceInput.checked = card.showSourceLink === true;
    sourceRow.createEl('label', { text: 'Show “Open source” link' });

    this.addSaveButton(form, 'Save info card', async () => {
      const fields = fieldsInput.value.split(',').map((field) => field.trim()).filter(Boolean);
      const nextCard = {
        ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}),
        ...(noteInput.value.trim() ? { note: noteInput.value.trim() } : {}),
        ...(fields.length ? { fields } : {}),
        ...(sourceInput.checked ? { showSourceLink: true } : {})
      };
      await this.plugin.registry.saveVariable(name, {
        file: definition.file,
        property: definition.property,
        display: definition.display,
        card: Object.keys(nextCard).length ? nextCard : undefined
      });
      new Notice(`Variable Links: info card saved for {{${name}}}`);
      await this.refresh();
    });
  }

  private addSaveButton(form: any, text: string, save: () => Promise<void>) {
    const button = form.createEl('button', { text, cls: 'mod-cta', attr: { type: 'submit' } });
    form.addEventListener('submit', async (event: SubmitEvent) => {
      event.preventDefault();
      button.disabled = true;
      try { await save(); }
      catch (error) { new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`); }
      finally { button.disabled = false; }
    });
  }

  private addInput(form: any, label: string, value: string, placeholder: string): HTMLInputElement {
    const row = form.createDiv('variable-links-panel-field');
    row.createEl('label', { text: label });
    const input = row.createEl('input', { attr: { type: 'text', placeholder } }) as HTMLInputElement;
    input.value = value;
    return input;
  }

  private addTextarea(form: any, label: string, value: string, placeholder: string): HTMLTextAreaElement {
    const row = form.createDiv('variable-links-panel-field');
    row.createEl('label', { text: label });
    const input = row.createEl('textarea', { attr: { placeholder, rows: '4' } }) as HTMLTextAreaElement;
    input.value = value;
    return input;
  }

  private attachFieldSuggestions(input: HTMLInputElement, sourceFile: string) {
    input.autocomplete = 'off';
    const row = input.parentElement as HTMLElement;
    const menu = document.createElement('div');
    menu.className = 'variable-links-field-suggestions';
    row.appendChild(menu);
    let selected = 0;
    let visibleItems: Array<{ file: any; property: string }> = [];

    const normalizedSource = sourceFile.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '') + '.md';
    const choose = (item: { file: any; property: string }) => {
      const comma = input.value.lastIndexOf(',');
      const prefix = comma === -1 ? '' : input.value.slice(0, comma + 1) + ' ';
      const local = item.file.path === normalizedSource;
      const fileLink = item.file.path.replace(/\.md$/i, '');
      input.value = prefix + (local ? item.property : `[[${fileLink}]]#${item.property}`);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      menu.replaceChildren();
    };

    const render = () => {
      const comma = input.value.lastIndexOf(',');
      const segment = input.value.slice(comma + 1).trim();
      const query = segment.toLowerCase();
      visibleItems = [];
      for (const file of (this.app.vault as any).getMarkdownFiles?.() || []) {
        const frontmatter = (this.app as any).metadataCache?.getFileCache?.(file)?.frontmatter;
        if (!frontmatter) continue;
        for (const property of Object.keys(frontmatter)) {
          if (query && !property.toLowerCase().includes(query) && !file.path.toLowerCase().includes(query)) continue;
          visibleItems.push({ file, property });
          if (visibleItems.length >= 20) break;
        }
        if (visibleItems.length >= 20) break;
      }
      selected = Math.min(selected, Math.max(0, visibleItems.length - 1));
      menu.replaceChildren();
      for (const [index, item] of visibleItems.entries()) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'variable-links-field-suggestion' + (index === selected ? ' is-selected' : '');
        option.textContent = `${item.property} · ${item.file.path}`;
        option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(item); });
        menu.appendChild(option);
      }
      menu.classList.toggle('is-visible', visibleItems.length > 0);
    };

    input.addEventListener('focus', render);
    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('blur', () => setTimeout(() => menu.classList.remove('is-visible'), 100));
    input.addEventListener('keydown', (event) => {
      if (!menu.classList.contains('is-visible') || !visibleItems.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); selected = (selected + 1) % visibleItems.length; render(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); selected = (selected - 1 + visibleItems.length) % visibleItems.length; render(); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(visibleItems[selected]); }
      else if (event.key === 'Escape') menu.classList.remove('is-visible');
    });
  }
}
