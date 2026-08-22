import {
  App,
  ItemView,
  MarkdownRenderChild,
  MarkdownRenderer,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import type { CardConfig } from './card';
import type VariableLinksPlugin from './main';
import type { VariableDefinition } from './registry';

export const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';

const EMPTY_DEFINITION: VariableDefinition = { file: '', property: '' };

class DeleteVariableModal extends Modal {
  constructor(
    app: App,
    private readonly variableName: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Delete variable link?' });
    this.contentEl.createEl('p', {
      text: `Delete “${this.variableName}”? Existing tokens will remain in notes but will no longer resolve.`,
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    actions.createEl('button', { text: 'Delete', cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class VariablePropertiesView extends ItemView {
  private panelContentEl: HTMLElement | null = null;
  private selectedVariableName: string | null = null;
  private active = false;
  private refreshGeneration = 0;
  private timers = new Set<number>();
  private markdownChild: MarkdownRenderChild | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VariableLinksPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_VARIABLE_PANEL;
  }

  getDisplayText(): string {
    return 'Variable properties';
  }

  getIcon(): string {
    return 'list';
  }

  async onOpen(): Promise<void> {
    this.active = true;
    this.containerEl.empty();
    this.containerEl.addClass('variable-links-panel');
    this.panelContentEl = this.containerEl.createDiv({ cls: 'variable-links-panel-inner' });
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.active = false;
    this.refreshGeneration++;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.clearMarkdownChild();
    this.panelContentEl = null;
    return Promise.resolve();
  }

  async selectVariable(name: string): Promise<void> {
    this.selectedVariableName = name.trim() || null;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const container = this.panelContentEl;
    const registry = this.plugin.registry;
    if (!this.active || !container || !registry) return;

    const generation = ++this.refreshGeneration;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.clearMarkdownChild();
    container.empty();
    const markdownChild = new MarkdownRenderChild(container);
    this.addChild(markdownChild);
    this.markdownChild = markdownChild;

    const last = this.plugin.caretTracker?.lastTouched;
    const names = Array.from(registry.data.keys()).sort((left, right) => left.localeCompare(right));
    const activeName = this.selectedVariableName ?? last?.name ?? '';
    const definition = activeName ? registry.getVariable(activeName) ?? EMPTY_DEFINITION : EMPTY_DEFINITION;

    const toolbar = container.createDiv({ cls: 'variable-links-panel-toolbar' });
    const select = toolbar.createEl('select');
    select.createEl('option', {
      text: activeName && !definition.file ? `[New] ${activeName}` : 'Select a variable link…',
      value: '',
    });
    for (const name of names) select.createEl('option', { text: name, value: name });
    select.value = definition.file ? activeName : '';
    select.addEventListener('change', () => {
      this.selectedVariableName = select.value || null;
      void this.refresh();
    });

    const setButton = toolbar.createEl('button', { text: 'Set token' });
    setButton.disabled = !activeName || !definition.file || !last;
    setButton.addEventListener('click', () => {
      if (setButton.disabled || !last) return;
      last.editor.replaceRange(`{{${activeName}}}`, last.from, last.to);
      last.name = activeName;
      last.def = definition;
      new Notice(`Variable Links: token set to {{${activeName}}}`);
    });

    const deleteButton = toolbar.createEl('button', { text: 'Delete' });
    deleteButton.disabled = !activeName || !definition.file;
    deleteButton.addEventListener('click', () => {
      if (deleteButton.disabled) return;
      new DeleteVariableModal(this.app, activeName, () => void this.deleteVariable(activeName)).open();
    });

    const layout = container.createDiv({ cls: 'variable-links-panel-split' });
    const propertiesPane = layout.createDiv({
      cls: 'variable-links-panel-pane variable-links-panel-properties',
    });
    const cardPane = layout.createDiv({
      cls: 'variable-links-panel-pane variable-links-panel-infocard',
    });
    propertiesPane.createEl('h4', { text: 'Variable properties' });
    cardPane.createEl('h4', { text: 'Info card' });

    if (!activeName) {
      propertiesPane.createEl('p', {
        text: 'No variable selected. Add a variable below or place the caret in a {{token}}.',
      });
      this.renderVariableForm(propertiesPane, '', EMPTY_DEFINITION, 'Add a variable');
      cardPane.createEl('p', { text: 'Select or create a variable to configure its info card.' });
      return;
    }

    const result = definition.file ? await this.plugin.resolver?.resolve(activeName) : null;
    if (!this.isCurrent(generation)) return;
    propertiesPane.createEl('h5', { text: `{{${activeName}}}` });
    const valueText = result?.ok ? String(result.value) : '[Missing]';
    const valueEl = propertiesPane.createDiv({ cls: 'variable-links-panel-value' });
    await MarkdownRenderer.render(this.app, valueText, valueEl, '', markdownChild);
    if (!this.isCurrent(generation)) return;

    const actions = propertiesPane.createDiv({ cls: 'variable-links-panel-actions' });
    actions.createEl('button', { text: 'Open source' }).addEventListener('click', () => {
      if (result?.sourceFile) {
        void this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
      }
    });
    actions.createEl('button', { text: 'Copy value' }).addEventListener('click', () => {
      void window.navigator.clipboard.writeText(valueText);
    });

    this.renderVariableForm(
      propertiesPane,
      activeName,
      definition,
      definition.file ? 'Edit mapping' : 'Set up this variable',
    );
    if (definition.file) this.renderInfoCardForm(cardPane, activeName, definition);
    else cardPane.createEl('p', { text: 'Save the variable mapping before configuring its info card.' });
  }

  private async deleteVariable(name: string): Promise<void> {
    const registry = this.plugin.registry;
    if (!registry) return;
    try {
      await registry.deleteVariable(name);
      const last = this.plugin.caretTracker?.lastTouched;
      if (last?.name === name) {
        last.def = null;
        last.value = undefined;
      }
      this.selectedVariableName = null;
      new Notice(`Variable Links: deleted {{${name}}}`);
      await this.refresh();
    } catch (error) {
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderVariableForm(
    parent: HTMLElement,
    name: string,
    definition: VariableDefinition,
    title: string,
  ): void {
    const section = parent.createEl('details', { cls: 'variable-links-panel-editor' });
    section.open = true;
    section.createEl('summary', { text: title });
    const form = section.createEl('form');
    const nameInput = this.addInput(form, 'Variable name', name, 'e.g. customer');
    const fileInput = this.addInput(
      form,
      'Source note',
      definition.file,
      '[[People/John Smith]] or People/John Smith.md',
    );
    const propertyInput = this.addInput(form, 'Property', definition.property, 'e.g. company');
    const displayInput = this.addInput(
      form,
      'Display name (optional)',
      definition.display ?? '',
      'e.g. John Smith',
    );
    const favoriteRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
    const favoriteInput = favoriteRow.createEl('input', { type: 'checkbox' });
    favoriteInput.checked = definition.favorite === true;
    favoriteRow.createEl('label', { text: 'Favorite' });

    this.addSaveButton(form, name ? 'Save properties' : 'Add variable', async () => {
      const registry = this.plugin.registry;
      if (!registry) throw new Error('The registry is unavailable.');
      const newName = nameInput.value.trim();
      await registry.saveVariable(newName, {
        file: fileInput.value,
        property: propertyInput.value,
        display: displayInput.value,
        favorite: favoriteInput.checked,
      }, definition.file ? name : undefined);
      const touched = this.plugin.caretTracker?.lastTouched;
      if (touched?.name === name && newName !== name) {
        touched.name = newName;
        touched.def = registry.getVariable(newName);
      }
      this.selectedVariableName = newName;
      new Notice(`Variable Links: saved {{${newName}}}`);
      await this.refresh();
    });
  }

  private renderInfoCardForm(
    parent: HTMLElement,
    name: string,
    definition: VariableDefinition,
  ): void {
    const card = definition.card ?? {};
    parent.createEl('p', { text: 'Shown when hovering over this variable in reading view.' });
    const form = parent.createEl('form', { cls: 'variable-links-panel-card-editor' });
    const titleInput = this.addInput(form, 'Title', card.title ?? '', 'e.g. John Smith');
    const noteInput = this.addTextarea(
      form,
      'Note (Markdown supported)',
      card.note ?? '',
      'Short description',
    );
    const fieldsInput = this.addInput(
      form,
      'Fields (property, [[File]]#property, or either with :Display name)',
      card.fields?.join(', ') ?? '',
      'email:Email address, [[Projects/Plan]]#due:Due date',
    );
    this.attachFieldSuggestions(fieldsInput, definition.file);
    const sourceRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
    const sourceInput = sourceRow.createEl('input', { type: 'checkbox' });
    sourceInput.checked = card.showSourceLink === true;
    sourceRow.createEl('label', { text: 'Show “open source” link' });

    this.addSaveButton(form, 'Save info card', async () => {
      const registry = this.plugin.registry;
      if (!registry) throw new Error('The registry is unavailable.');
      const fields = fieldsInput.value.split(',').map((field) => field.trim()).filter(Boolean);
      const nextCard: CardConfig = {};
      if (titleInput.value.trim()) nextCard.title = titleInput.value.trim();
      if (noteInput.value.trim()) nextCard.note = noteInput.value.trim();
      if (fields.length) nextCard.fields = fields;
      if (sourceInput.checked) nextCard.showSourceLink = true;
      await registry.saveVariable(name, {
        ...definition,
        card: Object.keys(nextCard).length ? nextCard : undefined,
      });
      new Notice(`Variable Links: info card saved for {{${name}}}`);
      await this.refresh();
    });
  }

  private addSaveButton(form: HTMLFormElement, text: string, save: () => Promise<void>): void {
    const button = form.createEl('button', {
      text,
      cls: 'mod-cta',
      attr: { type: 'submit' },
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      button.disabled = true;
      void save()
        .catch((error: unknown) => {
          new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
  }

  private addInput(
    form: HTMLFormElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = form.createDiv({ cls: 'variable-links-panel-field' });
    row.createEl('label', { text: label });
    const input = row.createEl('input', { type: 'text', placeholder });
    input.value = value;
    return input;
  }

  private addTextarea(
    form: HTMLFormElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLTextAreaElement {
    const row = form.createDiv({ cls: 'variable-links-panel-field' });
    row.createEl('label', { text: label });
    const input = row.createEl('textarea', { attr: { placeholder, rows: '4' } });
    input.value = value;
    return input;
  }

  private attachFieldSuggestions(input: HTMLInputElement, sourceFile: string): void {
    input.autocomplete = 'off';
    const row = input.parentElement;
    if (!row) return;
    const menu = row.createDiv({ cls: 'variable-links-field-suggestions' });
    let selected = 0;
    let visibleItems: Array<{ file: TFile; property: string }> = [];
    const normalizedSource = sourceFile.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '') + '.md';

    const choose = (item: { file: TFile; property: string }): void => {
      const comma = input.value.lastIndexOf(',');
      const prefix = comma === -1 ? '' : input.value.slice(0, comma + 1) + ' ';
      const local = item.file.path === normalizedSource;
      const fileLink = item.file.path.replace(/\.md$/i, '');
      input.value = prefix + (local ? item.property : `[[${fileLink}]]#${item.property}`);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      menu.replaceChildren();
    };

    const render = (): void => {
      const comma = input.value.lastIndexOf(',');
      const query = input.value.slice(comma + 1).trim().toLowerCase();
      visibleItems = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!this.isRecord(frontmatter)) continue;
        for (const property of Object.keys(frontmatter)) {
          if (query
            && !property.toLowerCase().includes(query)
            && !file.path.toLowerCase().includes(query)) continue;
          visibleItems.push({ file, property });
          if (visibleItems.length >= 20) break;
        }
        if (visibleItems.length >= 20) break;
      }
      selected = Math.min(selected, Math.max(0, visibleItems.length - 1));
      menu.replaceChildren();
      for (const [index, item] of visibleItems.entries()) {
        const option = menu.createEl('button', {
          cls: `variable-links-field-suggestion${index === selected ? ' is-selected' : ''}`,
          text: `${item.property} · ${item.file.path}`,
          attr: { type: 'button' },
        });
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(item);
        });
      }
      menu.classList.toggle('is-visible', visibleItems.length > 0);
    };

    input.addEventListener('focus', render);
    input.addEventListener('input', () => {
      selected = 0;
      render();
    });
    input.addEventListener('blur', () => {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        if (this.active) menu.classList.remove('is-visible');
      }, 100);
      this.timers.add(timer);
    });
    input.addEventListener('keydown', (event) => {
      if (!menu.classList.contains('is-visible') || !visibleItems.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selected = (selected + 1) % visibleItems.length;
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selected = (selected - 1 + visibleItems.length) % visibleItems.length;
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = visibleItems[selected];
        if (item) choose(item);
      } else if (event.key === 'Escape') {
        menu.classList.remove('is-visible');
      }
    });
  }

  private clearMarkdownChild(): void {
    if (!this.markdownChild) return;
    this.removeChild(this.markdownChild);
    this.markdownChild = null;
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.panelContentEl !== null && this.refreshGeneration === generation;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
