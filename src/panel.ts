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
  cloneCardBlocks,
  createCardBlock,
  createPropertyEntry,
  migrateLegacyCardBlocks,
  normalizeCardBlocks,
  type CardBlock,
  type CardPropertyEntry,
  type CardPropertyTableBlock,
} from './cardBlocks';
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
import {
  getVariableType,
  type VariableDefinition,
  type VariableType,
} from './registry';
import type { ResolveResult } from './resolver';

export const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';

const CREATE_FIXED_VALUE = 'create:fixed';
const CREATE_PROPERTY_VALUE = 'create:property';
const VARIABLE_OPTION_PREFIX = 'variable:';

function emptyDefinition(type: VariableType = 'property'): VariableDefinition {
  return { type, file: '', property: '', value: type === 'fixed' ? '' : undefined };
}

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

class ChangeVariableTypeModal extends Modal {
  constructor(
    app: App,
    private readonly currentType: VariableType,
    private readonly nextType: VariableType,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const currentLabel = this.currentType === 'fixed' ? 'Fixed value' : 'Property value';
    const nextLabel = this.nextType === 'fixed' ? 'Fixed value' : 'Property value';
    this.contentEl.createEl('h3', { text: 'Change variable type?' });
    this.contentEl.createEl('p', {
      text: `Change this variable from ${currentLabel} to ${nextLabel}?`,
    });
    this.contentEl.createEl('p', {
      text: this.nextType === 'fixed'
        ? 'It will stop reading its displayed value from a note property after you save.'
        : 'It will read its displayed value from the configured note property after you save.',
    });
    this.contentEl.createEl('p', {
      text: 'The inactive settings will be preserved in case you switch back later.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    actions.createEl('button', { text: 'Change type', cls: 'mod-cta' }).addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class InfoCardLayoutModal extends Modal {
  private readonly blocks: CardBlock[];
  private disableLivePreviewHover: boolean;

  constructor(
    app: App,
    private readonly variableName: string,
    card: CardConfig,
    private readonly hasSourceFile: boolean,
    private readonly attachPropertySuggestions: (input: HTMLInputElement) => void,
    private readonly onSave: (card: CardConfig) => Promise<void>,
  ) {
    super(app);
    this.blocks = normalizeCardBlocks(card.blocks ?? migrateLegacyCardBlocks(card)) ?? [];
    this.disableLivePreviewHover = card.disableLivePreviewHover === true;
  }

  onOpen(): void {
    this.modalEl.addClass('variable-links-card-layout-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `Info Card layout for {{${this.variableName}}}` });
    this.contentEl.createEl('p', {
      cls: 'variable-links-hint-text',
      text: 'Blocks render from top to bottom. Use the movement controls to arrange them.',
    });

    const addRow = this.contentEl.createDiv({ cls: 'variable-links-card-layout-add' });
    const typeSelect = addRow.createEl('select', { attr: { 'aria-label': 'Block type' } });
    const blockTypes: Array<{ type: CardBlock['type']; label: string }> = [
      { type: 'title', label: 'Title' },
      { type: 'note', label: 'Note' },
      { type: 'property', label: 'Property' },
      { type: 'property-table', label: 'Property table' },
      { type: 'divider', label: 'Divider' },
      { type: 'source', label: 'Source link' },
    ];
    for (const item of blockTypes) {
      typeSelect.createEl('option', { text: item.label, value: item.type });
    }
    addRow.createEl('button', { text: 'Add block', attr: { type: 'button' } })
      .addEventListener('click', () => {
        const type = typeSelect.value as CardBlock['type'];
        this.blocks.push(createCardBlock(type));
        this.render();
      });

    const list = this.contentEl.createDiv({ cls: 'variable-links-card-layout-list' });
    if (!this.blocks.length) {
      list.createDiv({
        cls: 'variable-links-card-layout-empty',
        text: 'No blocks yet. Add a block to build this Info Card.',
      });
    }
    this.blocks.forEach((block, index) => this.renderBlock(list, block, index));

    const options = this.contentEl.createDiv({ cls: 'variable-links-card-layout-options' });
    const livePreviewLabel = options.createEl('label');
    const livePreviewInput = livePreviewLabel.createEl('input', { type: 'checkbox' });
    livePreviewInput.checked = this.disableLivePreviewHover;
    livePreviewInput.addEventListener('change', () => {
      this.disableLivePreviewHover = livePreviewInput.checked;
    });
    livePreviewLabel.createSpan({ text: 'Disable live preview hover for this card' });

    const footer = this.contentEl.createDiv({ cls: 'variable-links-card-layout-footer' });
    footer.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    const saveButton = footer.createEl('button', {
      text: 'Save info card',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    saveButton.addEventListener('click', () => {
      saveButton.disabled = true;
      const blocks = normalizeCardBlocks(this.blocks) ?? [];
      void this.onSave({
        blocks: cloneCardBlocks(blocks),
        useBlockLayout: true,
        disableLivePreviewHover: this.disableLivePreviewHover || undefined,
      }).then(() => this.close()).catch((error: unknown) => {
        saveButton.disabled = false;
        new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private renderBlock(parent: HTMLElement, block: CardBlock, index: number): void {
    const item = parent.createDiv({ cls: 'variable-links-card-layout-block' });
    const heading = item.createDiv({ cls: 'variable-links-card-layout-block-heading' });
    heading.createEl('strong', { text: this.blockLabel(block) });
    const controls = heading.createDiv({ cls: 'variable-links-card-layout-controls' });
    this.addMoveButton(controls, 'Move up', index === 0, () => this.moveBlock(index, -1));
    this.addMoveButton(
      controls,
      'Move down',
      index === this.blocks.length - 1,
      () => this.moveBlock(index, 1),
    );
    controls.createEl('button', { text: 'Remove', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.blocks.splice(index, 1);
        this.render();
      });

    if (block.type === 'title') {
      const input = this.addModalInput(item, 'Title text:', block.text, 'Info Card title');
      input.addEventListener('input', () => { block.text = input.value; });
    } else if (block.type === 'note') {
      const input = this.addModalTextarea(
        item,
        'Markdown note:',
        block.markdown,
        'Write a note for this card',
      );
      input.addEventListener('input', () => { block.markdown = input.value; });
    } else if (block.type === 'property') {
      this.renderStandalonePropertyEditor(item, block, index);
    } else if (block.type === 'property-table') {
      this.renderPropertyTableEditor(item, block, index);
    } else if (block.type === 'divider') {
      item.createEl('hr');
    } else if (!this.hasSourceFile) {
      item.createDiv({
        cls: 'variable-links-hint-text',
        text: 'This block will appear after the variable has a file link.',
      });
    }
  }

  private renderStandalonePropertyEditor(
    parent: HTMLElement,
    block: Extract<CardBlock, { type: 'property' }>,
    index: number,
  ): void {
    const input = this.addPropertyInput(parent, block.property);
    input.addEventListener('input', () => { block.property.reference = input.value; });
    const groupButton = parent.createEl('button', {
      text: 'Put in property table',
      attr: { type: 'button' },
    });
    groupButton.addEventListener('click', () => {
      const table = this.blocks.find(
        (candidate): candidate is CardPropertyTableBlock => candidate.type === 'property-table',
      );
      if (table) {
        table.properties.push(block.property);
        this.blocks.splice(index, 1);
      } else {
        this.blocks.splice(index, 1, {
          id: createCardBlock('property-table').id,
          type: 'property-table',
          properties: [block.property],
        });
      }
      this.render();
    });
  }

  private renderPropertyTableEditor(
    parent: HTMLElement,
    block: CardPropertyTableBlock,
    blockIndex: number,
  ): void {
    const properties = parent.createDiv({ cls: 'variable-links-card-layout-properties' });
    if (!block.properties.length) {
      properties.createDiv({ cls: 'variable-links-hint-text', text: 'This table has no properties.' });
    }
    block.properties.forEach((property, propertyIndex) => {
      const row = properties.createDiv({ cls: 'variable-links-card-layout-property-row' });
      const input = this.addPropertyInput(row, property);
      input.addEventListener('input', () => { property.reference = input.value; });
      const controls = row.createDiv({ cls: 'variable-links-card-layout-controls' });
      this.addMoveButton(controls, 'Move up', propertyIndex === 0, () => {
        this.moveProperty(block, propertyIndex, -1);
      });
      this.addMoveButton(
        controls,
        'Move down',
        propertyIndex === block.properties.length - 1,
        () => this.moveProperty(block, propertyIndex, 1),
      );
      controls.createEl('button', { text: 'Move out', attr: { type: 'button' } })
        .addEventListener('click', () => {
          block.properties.splice(propertyIndex, 1);
          this.blocks.splice(blockIndex + 1, 0, {
            id: createCardBlock('property').id,
            type: 'property',
            property,
          });
          this.render();
        });
      controls.createEl('button', { text: 'Remove', attr: { type: 'button' } })
        .addEventListener('click', () => {
          block.properties.splice(propertyIndex, 1);
          this.render();
        });
    });
    parent.createEl('button', { text: 'Add property', attr: { type: 'button' } })
      .addEventListener('click', () => {
        block.properties.push(createPropertyEntry());
        this.render();
      });
  }

  private addPropertyInput(parent: HTMLElement, property: CardPropertyEntry): HTMLInputElement {
    const input = this.addModalInput(
      parent,
      'Property:',
      property.reference,
      'email:Email address or [[Projects/Plan]]#due:Due date',
    );
    this.attachPropertySuggestions(input);
    parent.createDiv({
      cls: 'variable-links-hint-text variable-links-card-layout-property-hint',
      text: 'Property, [[File]]#property, or either with :Display name. Comma-separated entries are saved separately.',
    });
    return input;
  }

  private addModalInput(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = parent.createDiv({ cls: 'variable-links-card-layout-field' });
    row.createEl('label', { text: label });
    const input = row.createEl('input', { type: 'text', placeholder });
    input.value = value;
    return input;
  }

  private addModalTextarea(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLTextAreaElement {
    const row = parent.createDiv({ cls: 'variable-links-card-layout-field' });
    row.createEl('label', { text: label });
    const input = row.createEl('textarea', { attr: { placeholder, rows: '4' } });
    input.value = value;
    return input;
  }

  private addMoveButton(
    parent: HTMLElement,
    text: string,
    disabled: boolean,
    move: () => void,
  ): void {
    const button = parent.createEl('button', { text, attr: { type: 'button' } });
    button.disabled = disabled;
    button.addEventListener('click', move);
  }

  private moveBlock(index: number, direction: -1 | 1): void {
    const destination = index + direction;
    if (destination < 0 || destination >= this.blocks.length) return;
    const [block] = this.blocks.splice(index, 1);
    if (block) this.blocks.splice(destination, 0, block);
    this.render();
  }

  private moveProperty(
    block: CardPropertyTableBlock,
    index: number,
    direction: -1 | 1,
  ): void {
    const destination = index + direction;
    if (destination < 0 || destination >= block.properties.length) return;
    const [property] = block.properties.splice(index, 1);
    if (property) block.properties.splice(destination, 0, property);
    this.render();
  }

  private blockLabel(block: CardBlock): string {
    if (block.type === 'property-table') return 'Property table';
    if (block.type === 'source') return 'Source link';
    return block.type.charAt(0).toUpperCase() + block.type.slice(1);
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
  private creatingVariableType: VariableType | null = null;

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
    this.creatingVariableType = null;
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
    const activeName = this.creatingVariableType
      ? ''
      : this.selectedVariableName ?? last?.name ?? '';
    const storedDefinition = activeName ? registry.getVariable(activeName) : undefined;
    const definition = storedDefinition ?? emptyDefinition(this.creatingVariableType ?? 'property');

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
      text: activeName && !storedDefinition ? `[New] ${activeName}` : 'Select a variable link…',
      value: '',
    });
    const createGroup = select.createEl('optgroup', { attr: { label: 'Create' } });
    createGroup.createEl('option', { text: 'New fixed value', value: CREATE_FIXED_VALUE });
    createGroup.createEl('option', { text: 'New property value', value: CREATE_PROPERTY_VALUE });
    const variableGroup = select.createEl('optgroup', { attr: { label: 'Variables' } });
    for (const name of names) {
      variableGroup.createEl('option', { text: name, value: `${VARIABLE_OPTION_PREFIX}${name}` });
    }
    select.value = this.creatingVariableType
      ? this.creatingVariableType === 'fixed' ? CREATE_FIXED_VALUE : CREATE_PROPERTY_VALUE
      : storedDefinition ? `${VARIABLE_OPTION_PREFIX}${activeName}` : '';
    select.addEventListener('change', () => {
      const value = select.value;
      if (value === CREATE_FIXED_VALUE || value === CREATE_PROPERTY_VALUE) {
        this.creatingVariableType = value === CREATE_FIXED_VALUE ? 'fixed' : 'property';
        this.selectedVariableName = null;
      } else {
        this.creatingVariableType = null;
        this.selectedVariableName = value.startsWith(VARIABLE_OPTION_PREFIX)
          ? value.slice(VARIABLE_OPTION_PREFIX.length)
          : null;
      }
      void this.refresh();
    });

    const setButton = toolbar.createEl('button', { text: 'Set token' });
    setButton.disabled = !activeName || !storedDefinition || !last;
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
    deleteButton.disabled = !activeName || !storedDefinition;
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
    const propertiesContent = propertiesPane.createDiv({ cls: 'variable-links-panel-pane-content' });
    const propertiesSaveHost = propertiesPane.createDiv({
      cls: 'variable-links-panel-sticky-save',
    });
    propertiesSaveHost.hidden = true;
    const cardContent = cardPane.createDiv({ cls: 'variable-links-panel-pane-content' });
    const cardSaveHost = cardPane.createDiv({ cls: 'variable-links-panel-sticky-save' });
    cardSaveHost.hidden = true;
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
      if (this.creatingVariableType) {
        const label = this.creatingVariableType === 'fixed' ? 'fixed value' : 'property value';
        this.renderVariableForm(
          propertiesContent,
          '',
          definition,
          `Add ${label}`,
          undefined,
          propertiesSaveHost,
        );
        cardContent.createEl('p', { text: 'Save the variable before configuring its info card.' });
      } else {
        propertiesContent.createEl('p', {
          text: 'Select a variable or choose a new variable type from the dropdown.',
        });
        cardContent.createEl('p', { text: 'Select or create a variable to configure its info card.' });
      }
      return;
    }

    const result = storedDefinition ? await this.plugin.resolver?.resolve(activeName) : null;
    if (!this.isCurrent(generation)) return;
    const summaryTable = propertiesContent.createEl('table', {
      cls: 'variable-links-panel-summary-table',
    });
    const summaryBody = summaryTable.createEl('tbody');
    const variableRow = summaryBody.createEl('tr');
    variableRow.createEl('th', { text: 'Variable link:', attr: { scope: 'row' } });
    const variableCell = variableRow.createEl('td');
    const variableHeading = variableCell.createDiv({
      cls: 'variable-links-panel-variable-heading',
    });
    variableHeading.createEl('h5', { text: `{{${activeName}}}` });
    if (storedDefinition) {
      this.renderFavoriteControl(variableHeading, activeName, storedDefinition);
    }
    const valueText = result?.ok ? this.formatResolvedValue(result.value) : '[Missing]';
    const valueRow = summaryBody.createEl('tr');
    valueRow.createEl('th', { text: 'Value:', attr: { scope: 'row' } });
    const valueEl = valueRow.createEl('td', { cls: 'variable-links-panel-value' });
    if (result?.ok && valueText === '') valueEl.createSpan({ text: '(Empty)', cls: 'mod-muted' });
    else await MarkdownRenderer.render(this.app, valueText, valueEl, '', markdownChild);
    if (!this.isCurrent(generation)) return;

    const actionsRow = summaryBody.createEl('tr');
    actionsRow.createEl('th', { text: 'Actions:', attr: { scope: 'row' } });
    const actions = actionsRow.createEl('td', { cls: 'variable-links-panel-actions' });
    const fileLinkTarget = filePathFromLink(
      definition.link ?? (getVariableType(definition) === 'property' ? definition.file : ''),
    );
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
      propertiesContent,
      activeName,
      definition,
      storedDefinition ? 'Edit variable' : 'Set up this variable',
      result ?? undefined,
      propertiesSaveHost,
    );
    if (storedDefinition) {
      this.renderInfoCardForm(cardContent, activeName, definition, cardSaveHost);
    } else cardContent.createEl('p', { text: 'Save the variable before configuring its info card.' });
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
    resolvedResult: ResolveResult | undefined,
    saveHost: HTMLElement,
  ): void {
    const existingVariable = name ? this.plugin.registry?.getVariable(name) : undefined;
    let activeType = getVariableType(definition);
    let hasFixedValue = definition.value !== undefined;
    let markFormDirty = (): void => {};
    const typeRow = parent.createDiv({ cls: 'variable-links-panel-field variable-links-panel-type-field' });
    typeRow.createEl('label', { text: 'Variable type:' });
    const typeInput = typeRow.createEl('select');
    typeInput.createEl('option', { text: 'Fixed value', value: 'fixed' });
    typeInput.createEl('option', { text: 'Property value', value: 'property' });
    typeInput.value = activeType;
    const typeStatus = parent.createDiv({
      cls: 'variable-links-panel-type-status',
      text: 'Unsaved change — save properties to apply.',
    });
    typeStatus.hidden = true;

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
    const propertyLinkRow = propertyLinkInput.parentElement;
    const fixedValueInput = this.addInput(
      form,
      'Value',
      definition.value ?? '',
      'Value displayed by this variable',
    );
    const fixedValueRow = fixedValueInput.parentElement;
    const linkedValueRow = form.createDiv({
      cls: 'variable-links-panel-linked-value',
      attr: { 'data-variable-links-ignore-dirty': 'true' },
    });
    this.renderLinkedPropertyValue(
      linkedValueRow,
      name,
      existingVariable ?? undefined,
      resolvedResult,
    );
    const fileLinkInput = this.addInput(
      form,
      'File link',
      toFileLink(
        definition.link ?? (activeType === 'property' ? definition.file : ''),
      ),
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
    const updateTypeFields = (): void => {
      if (propertyLinkRow) propertyLinkRow.hidden = activeType !== 'property';
      if (fixedValueRow) fixedValueRow.hidden = activeType !== 'fixed';
      linkedValueRow.hidden = activeType !== 'property';
      typeInput.value = activeType;
      typeStatus.hidden = !existingVariable || activeType === getVariableType(existingVariable);
    };
    const applyType = (nextType: VariableType): void => {
      if (nextType === 'fixed' && !hasFixedValue) {
        fixedValueInput.value = resolvedResult?.ok
          ? this.formatResolvedValue(resolvedResult.value)
          : '';
        hasFixedValue = true;
      }
      activeType = nextType;
      updateTypeFields();
      markFormDirty();
    };
    typeInput.addEventListener('change', () => {
      const nextType: VariableType = typeInput.value === 'fixed' ? 'fixed' : 'property';
      typeInput.value = activeType;
      if (nextType === activeType) return;
      if (!existingVariable) {
        applyType(nextType);
        return;
      }
      new ChangeVariableTypeModal(
        this.app,
        activeType,
        nextType,
        () => applyType(nextType),
      ).open();
    });
    updateTypeFields();
    let favoriteInput: HTMLInputElement | null = null;
    if (!existingVariable) {
      const favoriteRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
      favoriteInput = favoriteRow.createEl('input', { type: 'checkbox' });
      favoriteInput.checked = definition.favorite === true;
      favoriteRow.createEl('label', { text: 'Favorite' });
    }

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
    decorationRow.createEl('label', { text: 'Decoration:' });
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
    opacityRow.createEl('label', { text: 'Decoration opacity:' });
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
        markFormDirty();
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
      markFormDirty();
    });
    themeColorButton.addEventListener('click', () => {
      customColorInput.checked = false;
      updateAppearanceControls();
      markFormDirty();
    });
    decorationInput.addEventListener('change', updateAppearanceControls);
    customColorInput.addEventListener('change', updateAppearanceControls);
    updateAppearanceControls();

    markFormDirty = this.addSaveButton(
      form,
      existingVariable ? 'Save properties' : 'Add variable',
      saveHost,
      async () => {
        const registry = this.plugin.registry;
        if (!registry) throw new Error('The registry is unavailable.');
        const newName = nameInput.value.trim();
        const propertyLinkText = propertyLinkInput.value.trim();
        let propertyLink = { file: '', property: '' };
        if (propertyLinkText) propertyLink = parsePropertyLink(propertyLinkText);
        else if (activeType === 'property') {
          throw new Error('A property link is required for a Property value variable.');
        }
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
        const favorite = existingVariable
          ? registry.getVariable(name)?.favorite === true
          : favoriteInput?.checked === true;
        await registry.saveVariable(newName, {
          type: activeType,
          file: propertyLink.file,
          property: propertyLink.property,
          value: hasFixedValue ? fixedValueInput.value : undefined,
          link: fileLinkInput.value.trim() ? toFileLink(fileLinkInput.value) : undefined,
          display: displayInput.value,
          favorite,
          appearance: useDefaultsInput.checked ? undefined : nextAppearance,
        }, existingVariable ? name : undefined);
        const touched = this.plugin.caretTracker?.lastTouched;
        if (touched?.name === name && newName !== name) {
          touched.name = newName;
          touched.def = registry.getVariable(newName);
        }
        this.creatingVariableType = null;
        this.selectedVariableName = newName;
        new Notice(`Variable Links: saved {{${newName}}}`);
        await this.refresh();
      },
    );
  }

  private renderFavoriteControl(
    parent: HTMLElement,
    name: string,
    definition: VariableDefinition,
  ): void {
    const label = parent.createEl('label', { cls: 'variable-links-panel-heading-favorite' });
    const input = label.createEl('input', { type: 'checkbox' });
    input.checked = definition.favorite === true;
    label.createSpan({ text: 'Favorite' });
    input.addEventListener('change', () => {
      const favorite = input.checked;
      input.disabled = true;
      void this.saveFavorite(name, favorite)
        .catch((error: unknown) => {
          input.checked = !favorite;
          new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          input.disabled = false;
        });
    });
  }

  private async saveFavorite(name: string, favorite: boolean): Promise<void> {
    const registry = this.plugin.registry;
    const definition = registry?.getVariable(name);
    if (!registry || !definition) throw new Error(`{{${name}}} is not configured.`);
    await registry.saveVariable(name, { ...definition, favorite });
    new Notice(`Variable Links: ${favorite ? 'favorited' : 'unfavorited'} {{${name}}}`);
  }

  private renderInfoCardForm(
    parent: HTMLElement,
    name: string,
    definition: VariableDefinition,
    saveHost: HTMLElement,
  ): void {
    const card = definition.card ?? {};
    const fixedValue = getVariableType(definition) === 'fixed';
    const cardSourceFile = fixedValue ? definition.link ?? '' : definition.file;
    const hasCardSource = Boolean(filePathFromLink(cardSourceFile));
    const useBlockLayout = card.useBlockLayout === true;
    const modeRow = parent.createDiv({ cls: 'variable-links-panel-checkbox' });
    const modeInput = modeRow.createEl('input', { type: 'checkbox' });
    modeInput.checked = useBlockLayout;
    modeRow.createEl('label', { text: 'Use block layout editor' });
    parent.createDiv({
      cls: 'variable-links-hint-text',
      text: 'Turn this off to use the original simple Info Card fields.',
    });

    const saveCard = async (nextCard: CardConfig): Promise<void> => {
      const registry = this.plugin.registry;
      if (!registry) throw new Error('The registry is unavailable.');
      const hasSimpleContent = Boolean(
        nextCard.title || nextCard.note || nextCard.fields?.length || nextCard.showSourceLink,
      );
      const hasBlocks = Boolean(nextCard.blocks?.length);
      const hasOptions = nextCard.disableLivePreviewHover === true;
      await registry.saveVariable(name, {
        ...definition,
        card: hasSimpleContent || hasBlocks || hasOptions ? nextCard : undefined,
      });
      new Notice(`Variable Links: Info Card saved for {{${name}}}`);
      await this.refresh();
    };

    if (useBlockLayout) {
      const blocks = card.blocks ?? migrateLegacyCardBlocks(card);
      parent.createEl('p', {
        text: 'Build the card from movable content blocks shown on hover in reading view or live preview.',
      });
      const summary = parent.createDiv({ cls: 'variable-links-card-layout-summary' });
      summary.createEl('strong', {
        text: `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} configured`,
      });
      if (blocks.length) {
        summary.createDiv({
          cls: 'variable-links-hint-text',
          text: blocks.map((block) => this.cardBlockLabel(block)).join(' → '),
        });
      }
      if (!hasCardSource) {
        summary.createDiv({
          cls: 'variable-links-hint-text',
          text: fixedValue
            ? 'Add a file link before using local Property or Source link blocks.'
            : 'The configured source note is unavailable.',
        });
      }
      parent.createEl('button', {
        text: 'Open info card editor',
        cls: 'mod-cta',
        attr: { type: 'button' },
      }).addEventListener('click', () => {
        new InfoCardLayoutModal(
          this.app,
          name,
          card,
          hasCardSource,
          (input) => this.attachFieldSuggestions(input, cardSourceFile),
          async (nextCard) => saveCard({ ...card, ...nextCard, useBlockLayout: true }),
        ).open();
      });
      modeInput.addEventListener('change', () => {
        if (modeInput.checked) return;
        modeInput.disabled = true;
        void saveCard({ ...card, useBlockLayout: false }).catch((error: unknown) => {
          modeInput.checked = true;
          modeInput.disabled = false;
          new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      return;
    }

    parent.createEl('p', {
      text: 'Configure a simple info card shown on hover in reading view or live preview.',
    });
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
      'Fields',
      card.fields?.join(', ') ?? '',
      'email:Email address, [[Projects/Plan]]#due:Due date',
    );
    fieldsInput.parentElement?.createDiv({
      cls: 'variable-links-hint-text variable-links-panel-field-hint',
      text: 'Property, [[File]]#property, or either with :Display name.',
    });
    this.attachFieldSuggestions(fieldsInput, cardSourceFile);
    const sourceRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
    const sourceInput = sourceRow.createEl('input', { type: 'checkbox' });
    sourceInput.checked = card.showSourceLink === true;
    sourceInput.disabled = !hasCardSource;
    sourceRow.createEl('label', {
      text: fixedValue ? 'Show “open file link”' : 'Show “open source” link',
    });
    const livePreviewRow = form.createDiv({ cls: 'variable-links-panel-checkbox' });
    const livePreviewInput = livePreviewRow.createEl('input', { type: 'checkbox' });
    livePreviewInput.checked = card.disableLivePreviewHover === true;
    livePreviewRow.createEl('label', { text: 'Disable live preview hover for this card' });

    const getSimpleCard = (nextUseBlockLayout: boolean): CardConfig => {
      const fields = fieldsInput.value.split(',').map((field) => field.trim()).filter(Boolean);
      const simpleCard: CardConfig = {
        ...card,
        title: titleInput.value.trim() || undefined,
        note: noteInput.value.trim() || undefined,
        fields: fields.length ? fields : undefined,
        showSourceLink: sourceInput.checked,
        useBlockLayout: nextUseBlockLayout,
        disableLivePreviewHover: livePreviewInput.checked || undefined,
      };
      if (nextUseBlockLayout && !simpleCard.blocks) {
        simpleCard.blocks = migrateLegacyCardBlocks(simpleCard);
      }
      return simpleCard;
    };
    this.addSaveButton(form, 'Save info card', saveHost, async () => {
      await saveCard(getSimpleCard(false));
    });
    modeInput.addEventListener('change', () => {
      if (!modeInput.checked) return;
      modeInput.disabled = true;
      void saveCard(getSimpleCard(true)).catch((error: unknown) => {
        modeInput.checked = false;
        modeInput.disabled = false;
        new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private cardBlockLabel(block: CardBlock): string {
    if (block.type === 'property-table') return 'Property table';
    if (block.type === 'source') return 'Source link';
    return block.type.charAt(0).toUpperCase() + block.type.slice(1);
  }

  private renderLinkedPropertyValue(
    parent: HTMLElement,
    variableName: string,
    storedDefinition: VariableDefinition | undefined,
    result: ResolveResult | undefined,
  ): void {
    parent.createEl('label', { text: 'Linked value:' });
    if (!storedDefinition) {
      parent.createDiv({
        cls: 'variable-links-hint-text',
        text: 'Save this variable before editing its linked value.',
      });
      return;
    }
    if (getVariableType(storedDefinition) !== 'property') {
      parent.createDiv({
        cls: 'variable-links-hint-text',
        text: 'Save the Property value type before editing its linked value.',
      });
      return;
    }
    if (!result?.ok || !result.sourceFile || !result.property) {
      parent.createDiv({
        cls: 'variable-links-hint-text',
        text: result?.error ?? 'The linked value is unavailable.',
      });
      return;
    }

    const sourceFile = result.sourceFile;
    const property = result.property;
    const originalValue = result.value;
    const editableType = typeof originalValue;
    const supported = editableType === 'string'
      || editableType === 'number'
      || editableType === 'boolean';
    const display = parent.createDiv({ cls: 'variable-links-panel-linked-value-display' });
    const value = display.createDiv({
      cls: 'variable-links-panel-linked-value-text',
      attr: {
        title: supported ? 'Double-click to edit the linked property value' : '',
        tabindex: supported ? '0' : '-1',
      },
    });
    value.textContent = this.formatResolvedValue(originalValue) || '(Empty)';
    parent.createDiv({
      cls: 'variable-links-hint-text',
      text: `Edits the saved property ${sourceFile.path}#${property}. Save Property link changes first to edit a different source.`,
    });
    if (!supported) {
      display.createSpan({
        cls: 'variable-links-hint-text',
        text: 'Lists and structured values are read-only.',
      });
      return;
    }

    const editButton = display.createEl('button', {
      text: 'Edit',
      attr: { type: 'button', 'aria-label': `Edit linked value for ${variableName}` },
    });
    const editor = parent.createDiv({ cls: 'variable-links-panel-linked-value-editor' });
    editor.hidden = true;
    let editorControl: HTMLInputElement | HTMLSelectElement;
    if (editableType === 'boolean') {
      const select = editor.createEl('select');
      select.createEl('option', { text: 'True', value: 'true' });
      select.createEl('option', { text: 'False', value: 'false' });
      select.value = originalValue === true ? 'true' : 'false';
      editorControl = select;
    } else {
      const input = editor.createEl('input', {
        type: editableType === 'number' ? 'number' : 'text',
      });
      input.value = this.formatResolvedValue(originalValue);
      editorControl = input;
    }
    const editorActions = editor.createDiv({ cls: 'variable-links-panel-linked-value-actions' });
    const saveButton = editorActions.createEl('button', {
      text: 'Save linked value',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    const cancelButton = editorActions.createEl('button', {
      text: 'Cancel',
      attr: { type: 'button' },
    });
    const startEditing = (): void => {
      display.hidden = true;
      editor.hidden = false;
      editorControl.focus();
      if (editorControl instanceof HTMLInputElement) editorControl.select();
    };
    const cancelEditing = (): void => {
      editorControl.value = editableType === 'boolean'
        ? originalValue === true ? 'true' : 'false'
        : this.formatResolvedValue(originalValue);
      editor.hidden = true;
      display.hidden = false;
      editButton.focus();
    };
    const saveLinkedValue = async (): Promise<void> => {
      saveButton.disabled = true;
      cancelButton.disabled = true;
      try {
        const nextValue = this.parseLinkedPropertyValue(editorControl.value, editableType);
        await this.updateLinkedPropertyValue(
          sourceFile,
          property,
          originalValue,
          nextValue,
        );
        new Notice(`Variable Links: updated linked value for {{${variableName}}}`);
        this.plugin.livePreviewRenderer?.refresh();
        await this.refresh();
      } catch (error) {
        new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        saveButton.disabled = false;
        cancelButton.disabled = false;
      }
    };
    value.addEventListener('dblclick', startEditing);
    value.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      startEditing();
    });
    editButton.addEventListener('click', startEditing);
    cancelButton.addEventListener('click', cancelEditing);
    saveButton.addEventListener('click', () => void saveLinkedValue());
    editorControl.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        cancelEditing();
      } else if (keyboardEvent.key === 'Enter') {
        keyboardEvent.preventDefault();
        void saveLinkedValue();
      }
    });
  }

  private parseLinkedPropertyValue(value: string, type: string): string | number | boolean {
    if (type === 'boolean') return value === 'true';
    if (type === 'number') {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number)) {
        throw new Error('Enter a valid number before saving the linked value.');
      }
      return number;
    }
    return value;
  }

  private async updateLinkedPropertyValue(
    file: TFile,
    property: string,
    originalValue: unknown,
    nextValue: string | number | boolean,
  ): Promise<void> {
    const metadataRefresh = this.waitForMetadataRefresh(file);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (!Object.is(frontmatter[property], originalValue)) {
        throw new Error('The linked value changed after the panel loaded. Refresh and try again.');
      }
      frontmatter[property] = nextValue;
    });
    await metadataRefresh;
  }

  private waitForMetadataRefresh(file: TFile): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        this.app.metadataCache.offref(eventRef);
        resolve();
      };
      const eventRef = this.app.metadataCache.on('changed', (changedFile) => {
        if (changedFile.path === file.path) finish();
      });
      const timer = window.setTimeout(finish, 1000);
    });
  }

  private formatResolvedValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (value === undefined || value === null) return '';
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || typeof value === 'bigint') return String(value);
    return JSON.stringify(value) ?? '';
  }

  private addSaveButton(
    form: HTMLFormElement,
    text: string,
    saveHost: HTMLElement,
    save: () => Promise<void>,
  ): () => void {
    const formId = `variable-links-panel-form-${this.refreshGeneration}-${text.toLowerCase().replace(/\s+/g, '-')}`;
    form.id = formId;
    saveHost.empty();
    saveHost.hidden = false;
    const button = saveHost.createEl('button', {
      text,
      cls: 'mod-cta',
      attr: { type: 'submit', form: formId },
    });
    button.disabled = true;
    const markDirty = (): void => {
      button.disabled = false;
    };
    const markDirtyFromEvent = (event: Event): void => {
      const target = event.target;
      if (target instanceof HTMLElement
        && target.closest('[data-variable-links-ignore-dirty="true"]')) return;
      markDirty();
    };
    form.addEventListener('input', markDirtyFromEvent);
    form.addEventListener('change', markDirtyFromEvent);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      void save()
        .catch((error: unknown) => {
          new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
    return markDirty;
  }

  private addInput(
    form: HTMLFormElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = form.createDiv({ cls: 'variable-links-panel-field' });
    row.createEl('label', { text: `${label}:` });
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
    const row = form.createDiv({
      cls: 'variable-links-panel-field variable-links-panel-textarea-field',
    });
    row.createEl('label', { text: `${label}:` });
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
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
