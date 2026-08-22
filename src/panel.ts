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
import {
  getDefaultVariableAppearance,
  type VariableAppearance,
  type VariableDecoration,
} from './appearance';
import {
  filePathFromLink,
  formatPropertyLink,
  parsePropertyLink,
  toFileLink,
} from './linkSyntax';
import type VariableLinksPlugin from './main';
import type { VariableDefinition } from './registry';

export const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';

const EMPTY_DEFINITION: VariableDefinition = { file: '', property: '' };

interface PropertySuggestion {
  file: TFile;
  property: string;
}

type PanelTab = 'link' | 'card';

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
  private activeTab: PanelTab = 'link';

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
    return 'Variable link properties';
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

    const header = container.createDiv({ cls: 'variable-links-panel-header' });
    header.createEl('h2', { text: 'Variable link properties' });
    const tabs = header.createDiv({ cls: 'variable-links-panel-tabs', attr: { role: 'tablist' } });
    const linkTab = tabs.createEl('button', {
      text: 'Link',
      cls: 'variable-links-panel-tab',
      attr: { type: 'button', role: 'tab' },
    });
    const cardTab = tabs.createEl('button', {
      text: 'Card',
      cls: 'variable-links-panel-tab',
      attr: { type: 'button', role: 'tab' },
    });

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
      const token = `{{${activeName}}}`;
      last.editor.replaceRange(token, last.from, last.to);
      last.editor.setCursor({ line: last.from.line, ch: last.from.ch + token.length });
      last.editor.focus();
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

    const tabContent = container.createDiv({ cls: 'variable-links-panel-tab-content' });
    const propertiesPane = tabContent.createDiv({
      cls: 'variable-links-panel-pane variable-links-panel-properties',
      attr: { role: 'tabpanel' },
    });
    const cardPane = tabContent.createDiv({
      cls: 'variable-links-panel-pane variable-links-panel-infocard',
      attr: { role: 'tabpanel' },
    });
    const showTab = (tab: PanelTab): void => {
      this.activeTab = tab;
      const showLink = tab === 'link';
      propertiesPane.hidden = !showLink;
      cardPane.hidden = showLink;
      linkTab.classList.toggle('is-active', showLink);
      cardTab.classList.toggle('is-active', !showLink);
      linkTab.setAttribute('aria-selected', showLink ? 'true' : 'false');
      cardTab.setAttribute('aria-selected', showLink ? 'false' : 'true');
      linkTab.tabIndex = showLink ? 0 : -1;
      cardTab.tabIndex = showLink ? -1 : 0;
    };
    linkTab.addEventListener('click', () => showTab('link'));
    cardTab.addEventListener('click', () => showTab('card'));
    linkTab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      showTab('card');
      cardTab.focus();
    });
    cardTab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft') return;
      event.preventDefault();
      showTab('link');
      linkTab.focus();
    });
    showTab(this.activeTab);

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
    const fileLinkTarget = filePathFromLink(definition.link ?? definition.file);
    const openLinkButton = actions.createEl('button', { text: 'Open file link' });
    openLinkButton.disabled = !fileLinkTarget;
    openLinkButton.addEventListener('click', () => {
      if (fileLinkTarget) {
        void this.app.workspace.openLinkText(
          fileLinkTarget,
          '',
          this.plugin.settings.openInNewPane,
        );
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
    const propertyLinkInput = this.addInput(
      form,
      'Property link',
      formatPropertyLink(definition.file, definition.property),
      '[[People/John Smith]]#company',
    );
    const fileLinkInput = this.addInput(
      form,
      'File link',
      toFileLink(definition.link ?? definition.file),
      '[[People/John Smith]]',
    );
    this.attachPropertyLinkSuggestions(propertyLinkInput, (fileLink) => {
      if (!fileLinkInput.value.trim()) fileLinkInput.value = fileLink;
    });
    this.attachFileLinkSuggestions(fileLinkInput);
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

    form.createEl('h5', { text: 'Variable appearance' });
    const defaultAppearance = getDefaultVariableAppearance(this.plugin.settings);
    const useDefaults = definition.appearance === undefined;
    const appearance = definition.appearance ?? defaultAppearance;
    const defaultsRow = form.createDiv({ cls: 'variable-links-panel-appearance-defaults' });
    const useDefaultsInput = this.addInlineCheckbox(
      defaultsRow,
      'Use default appearance',
      useDefaults,
    );
    const restoreDefaultsButton = defaultsRow.createEl('button', {
      text: 'Restore defaults',
      attr: { type: 'button' },
    });
    const emphasisRow = form.createDiv({ cls: 'variable-links-panel-appearance-options' });
    const boldInput = this.addInlineCheckbox(emphasisRow, 'Bold', appearance.bold === true);
    const italicInput = this.addInlineCheckbox(emphasisRow, 'Italic', appearance.italic === true);
    const decorationRow = form.createDiv({ cls: 'variable-links-panel-field' });
    decorationRow.createEl('label', { text: 'Decoration' });
    const decorationInput = decorationRow.createEl('select');
    decorationInput.createEl('option', { text: 'Underline', value: 'underline' });
    decorationInput.createEl('option', { text: 'Highlight', value: 'highlight' });
    decorationInput.createEl('option', { text: 'None', value: 'none' });
    decorationInput.value = appearance.decoration ?? 'underline';
    const colorRow = form.createDiv({ cls: 'variable-links-panel-decoration-color' });
    const customColorInput = this.addInlineCheckbox(
      colorRow,
      'Custom decoration color',
      Boolean(appearance.color),
    );
    const colorInput = colorRow.createEl('input', {
      type: 'color',
      attr: { 'aria-label': 'Decoration color' },
    });
    colorInput.value = appearance.color ?? this.plugin.settings.defaultAppearanceColor;
    const opacityRow = form.createDiv({ cls: 'variable-links-panel-opacity' });
    opacityRow.createEl('label', { text: 'Decoration opacity' });
    const opacityInput = opacityRow.createEl('input', {
      type: 'range',
      attr: { min: '0', max: '100', step: '1' },
    });
    opacityInput.value = String(appearance.opacity ?? 100);
    const opacityValue = opacityRow.createEl('output', { text: `${opacityInput.value}%` });
    opacityInput.addEventListener('input', () => {
      opacityValue.textContent = `${opacityInput.value}%`;
    });
    const swatchRow = form.createDiv({ cls: 'variable-links-panel-color-swatches' });
    const themeColorButton = swatchRow.createEl('button', {
      text: 'Theme',
      cls: 'variable-links-panel-theme-color',
      attr: { type: 'button', title: 'Use the active Obsidian theme color' },
    });
    const swatchButtons = this.plugin.settings.savedAppearanceColors.map((color, index) => {
      const button = swatchRow.createEl('button', {
        cls: 'variable-links-panel-color-swatch',
        attr: {
          type: 'button',
          title: `Saved color ${index + 1}: ${color}`,
          'aria-label': `Use saved color ${index + 1}`,
        },
      });
      button.style.backgroundColor = color;
      button.addEventListener('click', () => {
        customColorInput.checked = true;
        colorInput.value = color;
        updateAppearanceControls();
      });
      return button;
    });
    const setAppearanceControls = (value: VariableAppearance): void => {
      boldInput.checked = value.bold === true;
      italicInput.checked = value.italic === true;
      decorationInput.value = value.decoration ?? 'underline';
      customColorInput.checked = Boolean(value.color);
      colorInput.value = value.color ?? this.plugin.settings.defaultAppearanceColor;
      opacityInput.value = String(value.opacity ?? 100);
      opacityValue.textContent = `${opacityInput.value}%`;
    };
    const updateAppearanceControls = (): void => {
      const inherited = useDefaultsInput.checked;
      const noDecoration = decorationInput.value === 'none';
      boldInput.disabled = inherited;
      italicInput.disabled = inherited;
      decorationInput.disabled = inherited;
      customColorInput.disabled = inherited || noDecoration;
      colorInput.disabled = inherited || noDecoration || !customColorInput.checked;
      opacityInput.disabled = inherited || noDecoration;
      themeColorButton.disabled = inherited || noDecoration;
      for (const button of swatchButtons) button.disabled = inherited || noDecoration;
      restoreDefaultsButton.disabled = inherited;
    };
    useDefaultsInput.addEventListener('change', () => {
      if (useDefaultsInput.checked) setAppearanceControls(defaultAppearance);
      updateAppearanceControls();
    });
    restoreDefaultsButton.addEventListener('click', () => {
      useDefaultsInput.checked = true;
      setAppearanceControls(defaultAppearance);
      updateAppearanceControls();
    });
    themeColorButton.addEventListener('click', () => {
      customColorInput.checked = false;
      updateAppearanceControls();
    });
    decorationInput.addEventListener('change', updateAppearanceControls);
    customColorInput.addEventListener('change', updateAppearanceControls);
    updateAppearanceControls();

    this.addSaveButton(form, name ? 'Save properties' : 'Add variable', async () => {
      const registry = this.plugin.registry;
      if (!registry) throw new Error('The registry is unavailable.');
      const newName = nameInput.value.trim();
      const propertyLink = parsePropertyLink(propertyLinkInput.value);
      const nextAppearance: VariableAppearance = {};
      if (boldInput.checked) nextAppearance.bold = true;
      if (italicInput.checked) nextAppearance.italic = true;
      const decoration = decorationInput.value as VariableDecoration;
      if (decoration !== 'underline') nextAppearance.decoration = decoration;
      if (decoration !== 'none' && customColorInput.checked) {
        nextAppearance.color = colorInput.value;
      }
      const opacity = Number(opacityInput.value);
      if (decoration !== 'none' && opacity !== 100) nextAppearance.opacity = opacity;
      await registry.saveVariable(newName, {
        file: propertyLink.file,
        property: propertyLink.property,
        link: fileLinkInput.value.trim() ? toFileLink(fileLinkInput.value) : undefined,
        display: displayInput.value,
        favorite: favoriteInput.checked,
        appearance: useDefaultsInput.checked ? undefined : nextAppearance,
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
    parent.createEl('p', { text: 'Shown when hovering over this variable in reading view or live preview.' });
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
    const livePreviewRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
    const livePreviewInput = livePreviewRow.createEl('input', { type: 'checkbox' });
    livePreviewInput.checked = card.disableLivePreviewHover === true;
    livePreviewRow.createEl('label', { text: 'Disable live preview hover for this card' });

    this.addSaveButton(form, 'Save info card', async () => {
      const registry = this.plugin.registry;
      if (!registry) throw new Error('The registry is unavailable.');
      const fields = fieldsInput.value.split(',').map((field) => field.trim()).filter(Boolean);
      const nextCard: CardConfig = {};
      if (titleInput.value.trim()) nextCard.title = titleInput.value.trim();
      if (noteInput.value.trim()) nextCard.note = noteInput.value.trim();
      if (fields.length) nextCard.fields = fields;
      if (sourceInput.checked) nextCard.showSourceLink = true;
      if (livePreviewInput.checked) nextCard.disableLivePreviewHover = true;
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

  private addInlineCheckbox(
    parent: HTMLElement,
    label: string,
    checked: boolean,
  ): HTMLInputElement {
    const wrapper = parent.createEl('label', { cls: 'variable-links-panel-inline-checkbox' });
    const input = wrapper.createEl('input', { type: 'checkbox' });
    input.checked = checked;
    wrapper.createSpan({ text: label });
    return input;
  }

  private attachFieldSuggestions(input: HTMLInputElement, sourceFile: string): void {
    const normalizedSource = `${filePathFromLink(sourceFile)}.md`;
    this.attachSuggestionDropdown(
      input,
      () => {
        const comma = input.value.lastIndexOf(',');
        return input.value.slice(comma + 1);
      },
      (query) => this.getPropertySuggestions(query),
      (item) => `${item.property} · ${item.file.path}`,
      (item) => {
        const comma = input.value.lastIndexOf(',');
        const prefix = comma === -1 ? '' : input.value.slice(0, comma + 1) + ' ';
        const local = item.file.path === normalizedSource;
        const propertyLink = `${toFileLink(item.file.path)}#${item.property}`;
        input.value = prefix + (local ? item.property : propertyLink);
      },
    );
  }

  private attachPropertyLinkSuggestions(
    input: HTMLInputElement,
    onChooseFile: (fileLink: string) => void,
  ): void {
    this.attachSuggestionDropdown(
      input,
      () => input.value,
      (query) => this.getPropertySuggestions(query),
      (item) => `${item.property} · ${item.file.path}`,
      (item) => {
        const fileLink = toFileLink(item.file.path);
        input.value = `${fileLink}#${item.property}`;
        onChooseFile(fileLink);
      },
    );
  }

  private attachFileLinkSuggestions(input: HTMLInputElement): void {
    this.attachSuggestionDropdown(
      input,
      () => input.value,
      (query) => this.app.vault.getMarkdownFiles()
        .filter((file) => this.matchesSuggestion(query, file.path))
        .slice(0, 20),
      (file) => file.path,
      (file) => {
        input.value = toFileLink(file.path);
      },
    );
  }

  private getPropertySuggestions(query: string): PropertySuggestion[] {
    const suggestions: PropertySuggestion[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isRecord(frontmatter)) continue;
      for (const property of Object.keys(frontmatter)) {
        if (!this.matchesSuggestion(query, property, file.path)) continue;
        suggestions.push({ file, property });
        if (suggestions.length >= 20) return suggestions;
      }
    }
    return suggestions;
  }

  private matchesSuggestion(query: string, ...values: string[]): boolean {
    const terms = query.toLowerCase()
      .replace(/[[\]#]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const searchable = values.join(' ').toLowerCase();
    return terms.every((term) => searchable.includes(term));
  }

  private attachSuggestionDropdown<T>(
    input: HTMLInputElement,
    getQuery: () => string,
    getItems: (query: string) => T[],
    getLabel: (item: T) => string,
    chooseItem: (item: T) => void,
  ): void {
    input.autocomplete = 'off';
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    const row = input.parentElement;
    if (!row) return;
    const menu = row.createDiv({ cls: 'variable-links-field-suggestions', attr: { role: 'listbox' } });
    let selected = 0;
    let visibleItems: T[] = [];

    const choose = (item: T): void => {
      chooseItem(item);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      menu.replaceChildren();
      menu.classList.remove('is-visible');
      input.setAttribute('aria-expanded', 'false');
    };

    const render = (): void => {
      visibleItems = getItems(getQuery().trim());
      selected = Math.min(selected, Math.max(0, visibleItems.length - 1));
      menu.replaceChildren();
      for (const [index, item] of visibleItems.entries()) {
        const option = menu.createEl('button', {
          cls: `variable-links-field-suggestion${index === selected ? ' is-selected' : ''}`,
          text: getLabel(item),
          attr: {
            type: 'button',
            role: 'option',
            'aria-selected': index === selected ? 'true' : 'false',
          },
        });
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(item);
        });
      }
      menu.classList.toggle('is-visible', visibleItems.length > 0);
      input.setAttribute('aria-expanded', visibleItems.length > 0 ? 'true' : 'false');
    };

    input.addEventListener('focus', render);
    input.addEventListener('input', () => {
      selected = 0;
      render();
    });
    input.addEventListener('blur', () => {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        if (this.active) {
          menu.classList.remove('is-visible');
          input.setAttribute('aria-expanded', 'false');
        }
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
        input.setAttribute('aria-expanded', 'false');
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
