import {
  ItemView,
  MarkdownRenderChild,
  MarkdownRenderer,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import InfoCard, { type CardConfig } from './card';
import {
  cloneCardBlocks,
  createCardBlock,
  createPropertyEntry,
  migrateLegacyCardBlocks,
  normalizeCardBlocks,
  normalizeCardBlockStyle,
  normalizeCardStyle,
  type CardBlock,
  type CardBlockStyle,
  type CardBlockWidth,
  type CardGridColumns,
  type CardLayoutMode,
  type CardPropertyEntry,
  type CardPropertyTableBlock,
  type CardStyleConfig,
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
    private readonly plugin: VariableLinksPlugin,
    private readonly variableName: string,
    private readonly onConfirm: () => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
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
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }
}

class ChangeVariableTypeModal extends Modal {
  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly currentType: VariableType,
    private readonly nextType: VariableType,
    private readonly onConfirm: () => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
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
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }
}

interface InfoCardEditorState {
  blocks: CardBlock[];
  layoutMode: CardLayoutMode;
  gridColumns: CardGridColumns;
  layoutGap: number;
  cardStyle: CardStyleConfig;
  disableLivePreviewHover: boolean;
}

interface InfoCardEditorSize {
  width: number;
  height: number;
}

class InfoCardLayoutModal extends Modal {
  private readonly blocks: CardBlock[];
  private readonly previewCard: InfoCard;
  private readonly history: InfoCardEditorState[] = [];
  private readonly originalState: InfoCardEditorState;
  private layoutMode: CardLayoutMode;
  private gridColumns: CardGridColumns;
  private layoutGap: number;
  private cardStyle: CardStyleConfig;
  private disableLivePreviewHover: boolean;
  private previewHost: HTMLElement | null = null;
  private previewTimer: number | null = null;
  private scrollRestoreFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeEndCleanup: (() => void) | null = null;
  private editorSize: InfoCardEditorSize | null = null;
  private editorSizeDirty = false;
  private undoButton: HTMLButtonElement | null = null;
  private collapsedBlockIds = new Set<string>();
  private collapsedPropertyIds = new Set<string>();
  private draggedBlockId: string | null = null;
  private draggedProperty: { blockId: string; propertyId: string } | null = null;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly variableName: string,
    card: CardConfig,
    private readonly sourceFilePath: string,
    private readonly attachPropertySuggestions: (input: HTMLInputElement) => void,
    private readonly onSave: (card: CardConfig) => Promise<void>,
  ) {
    super(plugin.app);
    this.blocks = normalizeCardBlocks(card.blocks ?? migrateLegacyCardBlocks(card)) ?? [];
    this.layoutMode = card.layoutMode ?? 'stack';
    this.gridColumns = card.gridColumns ?? 2;
    this.layoutGap = card.layoutGap ?? (this.layoutMode === 'grid' ? 8 : 0);
    this.cardStyle = { ...(card.cardStyle ?? {}) };
    this.disableLivePreviewHover = card.disableLivePreviewHover === true;
    this.previewCard = new InfoCard(plugin.app);
    this.originalState = this.snapshot();
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-card-layout-modal');
    this.restoreEditorSize();
    this.render();
    this.observeEditorSize();
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.resizeEndCleanup?.();
    this.resizeEndCleanup = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.persistEditorSize();
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    if (this.scrollRestoreFrame !== null) {
      window.cancelAnimationFrame(this.scrollRestoreFrame);
      this.scrollRestoreFrame = null;
    }
    this.previewCard.destroy();
    this.contentEl.empty();
  }

  private restoreEditorSize(): void {
    const activeWindow = this.modalEl.ownerDocument.defaultView ?? window;
    const maximumWidth = Math.max(1, activeWindow.innerWidth - 24);
    const maximumHeight = Math.max(1, activeWindow.innerHeight - 24);
    const minimumWidth = Math.min(520, maximumWidth);
    const minimumHeight = Math.min(420, maximumHeight);
    const savedWidth = this.plugin.settings.infoCardEditorWidth;
    const savedHeight = this.plugin.settings.infoCardEditorHeight;
    if (savedWidth !== null) {
      const width = Math.min(maximumWidth, Math.max(minimumWidth, savedWidth));
      this.modalEl.style.width = `${width}px`;
    }
    if (savedHeight !== null) {
      const height = Math.min(maximumHeight, Math.max(minimumHeight, savedHeight));
      this.modalEl.style.height = `${height}px`;
    }
  }

  private observeEditorSize(): void {
    this.editorSize = this.readEditorSize();
    this.resizeObserver = new ResizeObserver(() => {
      this.captureEditorSize();
    });
    this.resizeObserver.observe(this.modalEl);
    const ownerDocument = this.modalEl.ownerDocument;
    const saveResizedDimensions = (): void => {
      this.captureEditorSize();
      this.persistEditorSize();
    };
    ownerDocument.addEventListener('pointerup', saveResizedDimensions, true);
    ownerDocument.addEventListener('mouseup', saveResizedDimensions, true);
    this.resizeEndCleanup = () => {
      ownerDocument.removeEventListener('pointerup', saveResizedDimensions, true);
      ownerDocument.removeEventListener('mouseup', saveResizedDimensions, true);
    };
  }

  private captureEditorSize(): void {
    const size = this.readEditorSize();
    const prior = this.editorSize;
    if (prior
      && Math.abs(prior.width - size.width) < 1
      && Math.abs(prior.height - size.height) < 1) return;
    this.editorSize = size;
    this.editorSizeDirty = true;
  }

  private readEditorSize(): InfoCardEditorSize {
    const bounds = this.modalEl.getBoundingClientRect();
    return {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
  }

  private persistEditorSize(): void {
    if (!this.editorSizeDirty || !this.editorSize) return;
    this.editorSizeDirty = false;
    void this.plugin.saveInfoCardEditorSize(
      this.editorSize.width,
      this.editorSize.height,
    ).catch(() => {
      this.editorSizeDirty = true;
    });
  }

  private render(): void {
    this.previewCard.hideImmediate();
    this.pruneCollapsedItemIds();
    this.contentEl.empty();
    const heading = this.contentEl.createDiv({ cls: 'variable-links-card-layout-editor-heading' });
    heading.createEl('h2', { text: `Info Card layout for {{${this.variableName}}}` });
    const headingActions = heading.createDiv({ cls: 'variable-links-card-layout-heading-actions' });
    this.undoButton = headingActions.createEl('button', { text: 'Undo', attr: { type: 'button' } });
    this.undoButton.disabled = this.history.length === 0;
    this.undoButton.addEventListener('click', () => this.undo());
    headingActions.createEl('button', { text: 'Restore original', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.mutate(() => this.applyState(this.originalState));
      });
    headingActions.createEl('button', { text: 'Restore defaults', attr: { type: 'button' } })
      .addEventListener('click', () => this.restoreDefaults());
    const collapseAllButton = headingActions.createEl('button', {
      text: 'Collapse all',
      attr: { type: 'button' },
    });
    collapseAllButton.disabled = this.blocks.length === 0;
    collapseAllButton.addEventListener('click', () => this.setAllItemsCollapsed(true));
    const expandAllButton = headingActions.createEl('button', {
      text: 'Expand all',
      attr: { type: 'button' },
    });
    expandAllButton.disabled = this.collapsedBlockIds.size === 0
      && this.collapsedPropertyIds.size === 0;
    expandAllButton.addEventListener('click', () => this.setAllItemsCollapsed(false));
    this.contentEl.createEl('p', {
      cls: 'variable-links-hint-text',
      text: 'Drag blocks to arrange them, or use the movement controls for keyboard access.',
    });

    this.renderLayoutControls();
    this.renderCardStyleControls();
    this.renderAddBlockControl();

    const list = this.contentEl.createDiv({ cls: 'variable-links-card-layout-list' });
    list.addEventListener('dragover', (event) => {
      if (!this.draggedBlockId) return;
      event.preventDefault();
    });
    list.addEventListener('drop', (event) => {
      if (!this.draggedBlockId || event.target !== list) return;
      event.preventDefault();
      this.dropBlockAt(this.blocks.length);
    });
    if (!this.blocks.length) {
      list.createDiv({
        cls: 'variable-links-card-layout-empty',
        text: 'No blocks yet. Add a block to build this Info Card.',
      });
    }
    this.blocks.forEach((block, index) => this.renderBlock(list, block, index));

    const previewSection = this.contentEl.createDiv({ cls: 'variable-links-card-preview-section' });
    previewSection.createEl('h3', { text: 'Live preview' });
    this.previewHost = previewSection.createDiv({ cls: 'variable-links-card-preview-host' });
    this.schedulePreview(0);

    const options = this.contentEl.createDiv({ cls: 'variable-links-card-layout-options' });
    const livePreviewLabel = options.createEl('label');
    const livePreviewInput = livePreviewLabel.createEl('input', { type: 'checkbox' });
    livePreviewInput.checked = this.disableLivePreviewHover;
    livePreviewInput.addEventListener('change', () => {
      this.recordHistory();
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
      void this.onSave(this.currentCard()).then(() => this.close()).catch((error: unknown) => {
        saveButton.disabled = false;
        new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private renderLayoutControls(): void {
    const controls = this.contentEl.createDiv({ cls: 'variable-links-card-layout-settings' });
    const presetRow = controls.createDiv({ cls: 'variable-links-card-layout-setting' });
    presetRow.createEl('label', { text: 'Starter layout:' });
    const preset = presetRow.createEl('select', { attr: { 'aria-label': 'Starter layout' } });
    preset.createEl('option', { value: 'classic', text: 'Classic stack' });
    preset.createEl('option', { value: 'compact', text: 'Compact grid' });
    preset.createEl('option', { value: 'profile', text: 'Profile card' });
    presetRow.createEl('button', { text: 'Apply', attr: { type: 'button' } })
      .addEventListener('click', () => this.applyPreset(preset.value));
    const mode = this.addSelect(controls, 'Layout:', [
      { value: 'stack', label: 'Stack' },
      { value: 'grid', label: 'Grid' },
    ], this.layoutMode);
    mode.addEventListener('change', () => {
      this.mutate(() => { this.layoutMode = mode.value === 'grid' ? 'grid' : 'stack'; });
    });

    const columns = this.addSelect(controls, 'Grid columns:', [1, 2, 3, 4].map((value) => ({
      value: String(value),
      label: String(value),
    })), String(this.gridColumns));
    columns.disabled = this.layoutMode !== 'grid';
    columns.addEventListener('change', () => {
      this.mutate(() => { this.gridColumns = Number(columns.value) as CardGridColumns; });
    });

    const gapRow = controls.createDiv({ cls: 'variable-links-card-layout-setting' });
    gapRow.createEl('label', { text: 'Spacing:' });
    const gap = gapRow.createEl('input', {
      type: 'range',
      attr: { min: '0', max: '24', step: '2', 'aria-label': 'Layout spacing' },
    });
    gap.value = String(this.layoutGap);
    const gapValue = gapRow.createEl('output', { text: `${this.layoutGap}px` });
    let recorded = false;
    gap.addEventListener('input', () => {
      if (!recorded) {
        this.recordHistory();
        recorded = true;
      }
      this.layoutGap = Number(gap.value);
      gapValue.textContent = `${this.layoutGap}px`;
      this.schedulePreview();
    });
  }

  private renderCardStyleControls(): void {
    const details = this.contentEl.createEl('details', { cls: 'variable-links-card-style-editor' });
    details.createEl('summary', { text: 'Card appearance' });
    const controls = details.createDiv({ cls: 'variable-links-card-layout-settings' });
    const background = this.addSelect(controls, 'Background:', [
      { value: 'default', label: 'Theme default' },
      { value: 'primary', label: 'Primary' },
      { value: 'secondary', label: 'Secondary' },
      { value: 'accent', label: 'Accent tint' },
      { value: 'transparent', label: 'Transparent' },
    ], this.cardStyle.background ?? 'default');
    background.addEventListener('change', () => {
      this.updateCardStyle((style) => {
        style.background = background.value === 'default'
          ? undefined
          : background.value as CardStyleConfig['background'];
      });
    });

    const border = this.addSelect(controls, 'Border:', [
      { value: 'default', label: 'Theme default' },
      { value: 'none', label: 'None' },
      { value: 'subtle', label: 'Subtle' },
      { value: 'accent', label: 'Accent' },
    ], this.cardStyle.border ?? 'default');
    border.addEventListener('change', () => {
      this.updateCardStyle((style) => {
        style.border = border.value === 'default'
          ? undefined
          : border.value as CardStyleConfig['border'];
      });
    });

    const shadow = this.addSelect(controls, 'Shadow:', [
      { value: 'default', label: 'Theme default' },
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ], this.cardStyle.shadow ?? 'default');
    shadow.addEventListener('change', () => {
      this.updateCardStyle((style) => {
        style.shadow = shadow.value === 'default'
          ? undefined
          : shadow.value as CardStyleConfig['shadow'];
      });
    });

    const alignment = this.addSelect(controls, 'Text alignment:', [
      { value: 'default', label: 'Theme default' },
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Center' },
      { value: 'right', label: 'Right' },
    ], this.cardStyle.alignment ?? 'default');
    alignment.addEventListener('change', () => {
      this.updateCardStyle((style) => {
        style.alignment = alignment.value === 'default'
          ? undefined
          : alignment.value as CardStyleConfig['alignment'];
      });
    });

    const maximumWidth = this.addSelect(controls, 'Maximum width:', [
      { value: 'default', label: 'Layout default' },
      ...[320, 400, 480, 560, 640, 720, 800].map((value) => ({
        value: String(value),
        label: `${value}px`,
      })),
    ], this.cardStyle.maxWidth === undefined ? 'default' : String(this.cardStyle.maxWidth));
    maximumWidth.addEventListener('change', () => {
      this.updateCardStyle((style) => {
        style.maxWidth = maximumWidth.value === 'default'
          ? undefined
          : Number(maximumWidth.value);
      });
    });

    this.addCardStyleRange(controls, 'Corner radius:', 'radius', 0, 24, 2, 6);
    this.addCardStyleRange(controls, 'Card padding:', 'padding', 0, 32, 2, 8);

    const classRow = controls.createDiv({ cls: 'variable-links-card-layout-setting' });
    classRow.createEl('label', { text: 'CSS classes:' });
    const classInput = classRow.createEl('input', {
      type: 'text',
      placeholder: 'my-card wide-card',
      attr: { 'aria-label': 'CSS classes' },
    });
    classInput.value = this.cardStyle.cssClasses?.join(' ') ?? '';
    this.bindTextEdit(classInput, (value) => {
      this.cardStyle.cssClasses = value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    });
    controls.createDiv({
      cls: 'variable-links-hint-text variable-links-card-style-hint',
      text: 'Optional class names can be styled from an Obsidian CSS snippet.',
    });
  }

  private addCardStyleRange(
    parent: HTMLElement,
    label: string,
    property: 'radius' | 'padding',
    minimum: number,
    maximum: number,
    step: number,
    fallback: number,
  ): void {
    const row = parent.createDiv({ cls: 'variable-links-card-layout-setting' });
    row.createEl('label', { text: label });
    const input = row.createEl('input', {
      type: 'range',
      attr: {
        min: String(minimum),
        max: String(maximum),
        step: String(step),
        'aria-label': label,
      },
    });
    input.value = String(this.cardStyle[property] ?? fallback);
    const output = row.createEl('output', { text: `${input.value}px` });
    let recorded = false;
    input.addEventListener('input', () => {
      if (!recorded) {
        this.recordHistory();
        recorded = true;
      }
      this.cardStyle[property] = Number(input.value);
      output.textContent = `${input.value}px`;
      this.schedulePreview();
    });
  }

  private renderAddBlockControl(): void {
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
        this.mutate(() => this.blocks.push(createCardBlock(typeSelect.value as CardBlock['type'])));
      });
  }

  private renderBlock(parent: HTMLElement, block: CardBlock, index: number): void {
    const item = parent.createDiv({ cls: 'variable-links-card-layout-block' });
    const collapsed = this.collapsedBlockIds.has(block.id);
    item.toggleClass('is-collapsed', collapsed);
    item.dataset.blockId = block.id;
    item.addEventListener('dragover', (event) => {
      if (!this.draggedBlockId || this.draggedBlockId === block.id) return;
      event.preventDefault();
      event.stopPropagation();
      item.addClass('is-drag-target');
    });
    item.addEventListener('dragleave', () => item.removeClass('is-drag-target'));
    item.addEventListener('drop', (event) => {
      if (!this.draggedBlockId || this.draggedBlockId === block.id) return;
      event.preventDefault();
      event.stopPropagation();
      const after = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
      this.dropBlockAt(index + (after ? 1 : 0));
    });

    const heading = item.createDiv({ cls: 'variable-links-card-layout-block-heading' });
    const title = heading.createDiv({ cls: 'variable-links-card-layout-block-title' });
    const collapseButton = title.createEl('button', {
      text: collapsed ? '▸' : '▾',
      cls: 'variable-links-card-collapse-button',
      attr: {
        type: 'button',
        'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${this.blockLabel(block)}`,
        'aria-expanded': String(!collapsed),
      },
    });
    collapseButton.addEventListener('click', () => {
      this.setItemCollapsed(this.collapsedBlockIds, block.id, !collapsed);
    });
    const dragHandle = title.createEl('button', {
      text: 'Drag',
      cls: 'variable-links-card-drag-handle',
      attr: { type: 'button', draggable: 'true', 'aria-label': `Drag ${this.blockLabel(block)}` },
    });
    dragHandle.addEventListener('dragstart', (event) => {
      this.draggedBlockId = block.id;
      event.dataTransfer?.setData('text/plain', block.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      item.addClass('is-dragging');
    });
    dragHandle.addEventListener('dragend', () => {
      this.draggedBlockId = null;
      item.removeClass('is-dragging');
    });
    const editorHeading = title.createDiv({ cls: 'variable-links-card-editor-heading-text' });
    const editorHeadingName = editorHeading.createEl('strong', {
      text: this.blockEditorHeading(block, index),
    });
    const editorHeadingType = editorHeading.createSpan({
      cls: 'variable-links-card-editor-item-type',
      text: block.editorLabel ? this.blockLabel(block) : '',
    });

    const controls = heading.createDiv({ cls: 'variable-links-card-layout-controls' });
    if (this.layoutMode === 'grid') this.renderBlockWidthControl(controls, block);
    this.addMoveButton(controls, 'Move up', index === 0, () => this.moveBlock(index, -1));
    this.addMoveButton(
      controls,
      'Move down',
      index === this.blocks.length - 1,
      () => this.moveBlock(index, 1),
    );
    controls.createEl('button', { text: 'Remove', attr: { type: 'button' } })
      .addEventListener('click', () => this.mutate(() => { this.blocks.splice(index, 1); }));

    if (collapsed) return;

    const editorLabelInput = this.addModalInput(
      item,
      'Editor label:',
      block.editorLabel ?? '',
      'Optional name shown only in the editor',
    );
    this.bindEditorLabel(editorLabelInput, (value) => {
      block.editorLabel = value;
      editorHeadingName.textContent = this.blockEditorHeading(block, index);
      editorHeadingType.textContent = value ? this.blockLabel(block) : '';
    });
    item.addEventListener('input', () => {
      if (!block.editorLabel) {
        editorHeadingName.textContent = this.blockEditorHeading(block, index);
      }
    });

    this.renderBlockStyleControls(item, block);

    if (block.type === 'title') {
      const input = this.addModalInput(item, 'Title text:', block.text, 'Info Card title');
      this.bindTextEdit(input, (value) => { block.text = value; });
    } else if (block.type === 'note') {
      const input = this.addModalTextarea(
        item,
        'Markdown note:',
        block.markdown,
        'Write a note for this card',
      );
      this.bindTextEdit(input, (value) => { block.markdown = value; });
    } else if (block.type === 'property') {
      this.renderStandalonePropertyEditor(item, block, index);
    } else if (block.type === 'property-table') {
      this.renderPropertyTableEditor(item, block, index);
    } else if (block.type === 'divider') {
      item.createEl('hr');
    } else if (!this.sourceFilePath) {
      item.createDiv({
        cls: 'variable-links-hint-text',
        text: 'This block will appear after the variable has a file link.',
      });
    }
  }

  private renderBlockWidthControl(parent: HTMLElement, block: CardBlock): void {
    const width = parent.createEl('select', { attr: { 'aria-label': 'Block width' } });
    const options: Array<{ value: CardBlockWidth | 'auto'; label: string }> = [
      { value: 'auto', label: 'Auto width' },
      { value: 'full', label: 'Full width' },
      { value: 'half', label: 'Half width' },
      { value: 'third', label: 'Third width' },
      { value: 'quarter', label: 'Quarter width' },
    ];
    for (const option of options) {
      width.createEl('option', { value: option.value, text: option.label });
    }
    width.value = block.width ?? 'auto';
    width.addEventListener('change', () => {
      this.mutate(() => {
        block.width = width.value === 'auto' ? undefined : width.value as CardBlockWidth;
      });
    });
  }

  private renderBlockStyleControls(parent: HTMLElement, block: CardBlock): void {
    const details = parent.createEl('details', { cls: 'variable-links-card-block-style-editor' });
    details.createEl('summary', { text: 'Block appearance' });
    const controls = details.createDiv({ cls: 'variable-links-card-table-settings' });
    const tone = this.addSelect(controls, 'Background:', [
      { value: 'none', label: 'None' },
      { value: 'soft', label: 'Soft' },
      { value: 'strong', label: 'Strong' },
      { value: 'accent', label: 'Accent tint' },
    ], block.style?.tone ?? 'none');
    tone.addEventListener('change', () => {
      this.updateBlockStyle(block, (style) => {
        style.tone = tone.value === 'none'
          ? undefined
          : tone.value as CardBlockStyle['tone'];
      });
    });

    const padding = this.addSelect(controls, 'Padding:', [
      { value: 'default', label: 'Default' },
      ...[0, 4, 8, 12, 16, 24].map((value) => ({ value: String(value), label: `${value}px` })),
    ], block.style?.padding === undefined ? 'default' : String(block.style.padding));
    padding.addEventListener('change', () => {
      this.updateBlockStyle(block, (style) => {
        style.padding = padding.value === 'default' ? undefined : Number(padding.value);
      });
    });

    const border = this.addSelect(controls, 'Border:', [
      { value: 'none', label: 'None' },
      { value: 'outline', label: 'Outline' },
      { value: 'divider', label: 'Bottom divider' },
    ], block.style?.border ?? 'none');
    border.addEventListener('change', () => {
      this.updateBlockStyle(block, (style) => {
        style.border = border.value === 'none'
          ? undefined
          : border.value as CardBlockStyle['border'];
      });
    });

    const alignment = this.addSelect(controls, 'Alignment:', [
      { value: 'default', label: 'Use card setting' },
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Center' },
      { value: 'right', label: 'Right' },
    ], block.style?.alignment ?? 'default');
    alignment.addEventListener('change', () => {
      this.updateBlockStyle(block, (style) => {
        style.alignment = alignment.value === 'default'
          ? undefined
          : alignment.value as CardBlockStyle['alignment'];
      });
    });
  }

  private renderStandalonePropertyEditor(
    parent: HTMLElement,
    block: Extract<CardBlock, { type: 'property' }>,
    index: number,
  ): void {
    const input = this.addPropertyInput(parent, block.property);
    this.bindTextEdit(input, (value) => { block.property.reference = value; });
    parent.createEl('button', { text: 'Put in property table', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.mutate(() => {
          if (!block.property.editorLabel && block.editorLabel) {
            block.property.editorLabel = block.editorLabel;
          }
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
        });
      });
  }

  private renderPropertyTableEditor(
    parent: HTMLElement,
    block: CardPropertyTableBlock,
    blockIndex: number,
  ): void {
    const tableSettings = parent.createDiv({ cls: 'variable-links-card-table-settings' });
    const columns = this.addSelect(tableSettings, 'Columns:', [1, 2, 3, 4].map((value) => ({
      value: String(value),
      label: String(value),
    })), String(block.columns ?? 1));
    columns.addEventListener('change', () => {
      this.mutate(() => { block.columns = Number(columns.value) as CardGridColumns; });
    });
    const rowMode = this.addSelect(tableSettings, 'Rows:', [
      { value: 'auto', label: 'Automatic' },
      { value: 'fixed', label: 'Fixed minimum' },
    ], block.rowMode ?? 'auto');
    rowMode.addEventListener('change', () => {
      this.mutate(() => { block.rowMode = rowMode.value === 'fixed' ? 'fixed' : undefined; });
    });
    if (block.rowMode === 'fixed') {
      const rows = tableSettings.createDiv({ cls: 'variable-links-card-layout-setting' });
      rows.createEl('label', { text: 'Minimum rows:' });
      const rowCount = rows.createEl('input', {
        type: 'number',
        attr: { min: '1', max: '12', step: '1', 'aria-label': 'Minimum rows' },
      });
      rowCount.value = String(block.rows ?? 1);
      rowCount.addEventListener('change', () => {
        this.mutate(() => {
          block.rows = Math.min(12, Math.max(1, Number(rowCount.value) || 1));
        });
      });
    }

    const properties = parent.createDiv({ cls: 'variable-links-card-layout-properties' });
    properties.addEventListener('dragover', (event) => {
      if (!this.draggedProperty) return;
      event.preventDefault();
      event.stopPropagation();
    });
    properties.addEventListener('drop', (event) => {
      if (!this.draggedProperty || event.target !== properties) return;
      event.preventDefault();
      event.stopPropagation();
      this.dropProperty(block.id, block.properties.length);
    });
    if (!block.properties.length) {
      properties.createDiv({ cls: 'variable-links-hint-text', text: 'This table has no properties.' });
    }
    block.properties.forEach((property, propertyIndex) => {
      this.renderPropertyRow(properties, block, blockIndex, property, propertyIndex);
    });
    parent.createEl('button', { text: 'Add property', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.mutate(() => block.properties.push(createPropertyEntry()));
      });
    if (block.rowMode === 'fixed') {
      parent.createDiv({
        cls: 'variable-links-hint-text',
        text: 'Extra properties add rows instead of being hidden.',
      });
    }
  }

  private renderPropertyRow(
    parent: HTMLElement,
    block: CardPropertyTableBlock,
    blockIndex: number,
    property: CardPropertyEntry,
    propertyIndex: number,
  ): void {
    const row = parent.createDiv({ cls: 'variable-links-card-layout-property-row' });
    const collapsed = this.collapsedPropertyIds.has(property.id);
    row.toggleClass('is-collapsed', collapsed);
    row.addEventListener('dragover', (event) => {
      if (!this.draggedProperty || this.draggedProperty.propertyId === property.id) return;
      event.preventDefault();
      event.stopPropagation();
      row.addClass('is-drag-target');
    });
    row.addEventListener('dragleave', () => row.removeClass('is-drag-target'));
    row.addEventListener('drop', (event) => {
      if (!this.draggedProperty || this.draggedProperty.propertyId === property.id) return;
      event.preventDefault();
      event.stopPropagation();
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      this.dropProperty(block.id, propertyIndex + (after ? 1 : 0));
    });
    const propertyHeading = row.createDiv({ cls: 'variable-links-card-layout-property-heading' });
    const collapseButton = propertyHeading.createEl('button', {
      text: collapsed ? '▸' : '▾',
      cls: 'variable-links-card-collapse-button',
      attr: {
        type: 'button',
        'aria-label': `${collapsed ? 'Expand' : 'Collapse'} property`,
        'aria-expanded': String(!collapsed),
      },
    });
    collapseButton.addEventListener('click', () => {
      this.setItemCollapsed(this.collapsedPropertyIds, property.id, !collapsed);
    });
    const dragHandle = propertyHeading.createEl('button', {
      text: 'Drag',
      cls: 'variable-links-card-drag-handle',
      attr: { type: 'button', draggable: 'true', 'aria-label': 'Drag property' },
    });
    dragHandle.addEventListener('dragstart', (event) => {
      this.draggedProperty = { blockId: block.id, propertyId: property.id };
      event.dataTransfer?.setData('text/plain', property.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.addClass('is-dragging');
    });
    dragHandle.addEventListener('dragend', () => {
      this.draggedProperty = null;
      row.removeClass('is-dragging');
    });
    const editorHeading = propertyHeading.createDiv({
      cls: 'variable-links-card-editor-heading-text',
    });
    const editorHeadingName = editorHeading.createEl('strong', {
      text: this.propertyEditorHeading(property, propertyIndex),
    });
    const editorHeadingType = editorHeading.createSpan({
      cls: 'variable-links-card-editor-item-type',
      text: property.editorLabel ? `Property · Cell ${propertyIndex + 1}` : '',
    });
    if (collapsed) return;
    const editorLabelInput = this.addModalInput(
      row,
      'Editor label:',
      property.editorLabel ?? '',
      'Optional name shown only in the editor',
    );
    this.bindEditorLabel(editorLabelInput, (value) => {
      property.editorLabel = value;
      editorHeadingName.textContent = this.propertyEditorHeading(property, propertyIndex);
      editorHeadingType.textContent = value ? `Property · Cell ${propertyIndex + 1}` : '';
    });
    row.addEventListener('input', () => {
      if (!property.editorLabel) {
        editorHeadingName.textContent = this.propertyEditorHeading(property, propertyIndex);
      }
    });
    const input = this.addPropertyInput(row, property);
    this.bindTextEdit(input, (value) => { property.reference = value; });
    const controls = row.createDiv({ cls: 'variable-links-card-layout-controls' });
    this.addMoveButton(controls, 'Move left', propertyIndex === 0, () => {
      this.moveProperty(block, propertyIndex, -1);
    });
    this.addMoveButton(
      controls,
      'Move right',
      propertyIndex === block.properties.length - 1,
      () => this.moveProperty(block, propertyIndex, 1),
    );
    if ((block.columns ?? 1) > 1) {
      const column = controls.createEl('select', { attr: { 'aria-label': 'Move to column' } });
      for (let index = 0; index < (block.columns ?? 1); index++) {
        column.createEl('option', { value: String(index), text: `Column ${index + 1}` });
      }
      column.value = String(propertyIndex % (block.columns ?? 1));
      column.addEventListener('change', () => {
        this.movePropertyToColumn(block, propertyIndex, Number(column.value));
      });
    }
    controls.createEl('button', { text: 'Move out', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.mutate(() => {
          block.properties.splice(propertyIndex, 1);
          this.blocks.splice(blockIndex + 1, 0, {
            id: createCardBlock('property').id,
            type: 'property',
            editorLabel: property.editorLabel,
            property,
          });
        });
      });
    controls.createEl('button', { text: 'Remove', attr: { type: 'button' } })
      .addEventListener('click', () => {
        this.mutate(() => { block.properties.splice(propertyIndex, 1); });
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
    this.renderPropertyDisplayControls(parent, property);
    return input;
  }

  private renderPropertyDisplayControls(
    parent: HTMLElement,
    property: CardPropertyEntry,
  ): void {
    const details = parent.createEl('details', { cls: 'variable-links-card-property-style-editor' });
    details.createEl('summary', { text: 'Property display' });
    const controls = details.createDiv({ cls: 'variable-links-card-table-settings' });

    const labelRow = controls.createDiv({ cls: 'variable-links-card-layout-setting' });
    labelRow.createEl('label', { text: 'Displayed label:' });
    const label = labelRow.createEl('input', {
      type: 'text',
      placeholder: 'Use property name',
      attr: { 'aria-label': 'Displayed label' },
    });
    label.value = property.label ?? '';
    this.bindTextEdit(label, (value) => { property.label = value.trim() || undefined; });

    const position = this.addSelect(controls, 'Label position:', [
      { value: 'left', label: 'Beside value' },
      { value: 'above', label: 'Above value' },
      { value: 'hidden', label: 'Hidden' },
    ], property.labelPosition ?? 'left');
    position.addEventListener('change', () => {
      this.recordHistory();
      property.labelPosition = position.value === 'left'
        ? undefined
        : position.value as CardPropertyEntry['labelPosition'];
      this.schedulePreview();
    });

    const alignment = this.addSelect(controls, 'Alignment:', [
      { value: 'default', label: 'Use block setting' },
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Center' },
      { value: 'right', label: 'Right' },
    ], property.alignment ?? 'default');
    alignment.addEventListener('change', () => {
      this.recordHistory();
      property.alignment = alignment.value === 'default'
        ? undefined
        : alignment.value as CardPropertyEntry['alignment'];
      this.schedulePreview();
    });

    const widthRow = controls.createDiv({ cls: 'variable-links-card-layout-setting' });
    widthRow.createEl('label', { text: 'Label width:' });
    const width = widthRow.createEl('input', {
      type: 'range',
      attr: { min: '20', max: '70', step: '5', 'aria-label': 'Property label width' },
    });
    width.value = String(property.labelWidth ?? 40);
    const widthValue = widthRow.createEl('output', { text: `${width.value}%` });
    let recorded = false;
    width.addEventListener('input', () => {
      if (!recorded) {
        this.recordHistory();
        recorded = true;
      }
      property.labelWidth = Number(width.value);
      widthValue.textContent = `${width.value}%`;
      this.schedulePreview();
    });
    controls.createDiv({
      cls: 'variable-links-hint-text variable-links-card-style-hint',
      text: 'A blank displayed label uses the label in the reference, then the property name.',
    });
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
    input.setAttribute('aria-label', label.replace(/:$/, ''));
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
    input.setAttribute('aria-label', label.replace(/:$/, ''));
    input.value = value;
    return input;
  }

  private addSelect(
    parent: HTMLElement,
    label: string,
    options: Array<{ value: string; label: string }>,
    value: string,
  ): HTMLSelectElement {
    const row = parent.createDiv({ cls: 'variable-links-card-layout-setting' });
    row.createEl('label', { text: label });
    const select = row.createEl('select');
    select.setAttribute('aria-label', label.replace(/:$/, ''));
    for (const option of options) {
      select.createEl('option', { value: option.value, text: option.label });
    }
    select.value = value;
    return select;
  }

  private bindTextEdit(
    input: HTMLInputElement | HTMLTextAreaElement,
    update: (value: string) => void,
  ): void {
    let recorded = false;
    input.addEventListener('input', () => {
      if (!recorded) {
        this.recordHistory();
        recorded = true;
      }
      update(input.value);
      this.schedulePreview();
    });
  }

  private bindEditorLabel(
    input: HTMLInputElement,
    update: (value: string | undefined) => void,
  ): void {
    let recorded = false;
    input.addEventListener('input', () => {
      if (!recorded) {
        this.recordHistory();
        recorded = true;
      }
      const value = input.value.trim().slice(0, 80) || undefined;
      update(value);
    });
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
    this.mutate(() => {
      const [block] = this.blocks.splice(index, 1);
      if (block) this.blocks.splice(destination, 0, block);
    });
  }

  private dropBlockAt(destination: number): void {
    const source = this.blocks.findIndex((block) => block.id === this.draggedBlockId);
    if (source === -1) return;
    this.mutate(() => {
      const [block] = this.blocks.splice(source, 1);
      if (!block) return;
      const adjusted = source < destination ? destination - 1 : destination;
      this.blocks.splice(Math.max(0, Math.min(adjusted, this.blocks.length)), 0, block);
    });
    this.draggedBlockId = null;
  }

  private moveProperty(
    block: CardPropertyTableBlock,
    index: number,
    direction: -1 | 1,
  ): void {
    const destination = index + direction;
    if (destination < 0 || destination >= block.properties.length) return;
    this.mutate(() => {
      const [property] = block.properties.splice(index, 1);
      if (property) block.properties.splice(destination, 0, property);
    });
  }

  private movePropertyToColumn(
    block: CardPropertyTableBlock,
    propertyIndex: number,
    columnIndex: number,
  ): void {
    const columns = block.columns ?? 1;
    const rowStart = Math.floor(propertyIndex / columns) * columns;
    const destination = Math.min(rowStart + columnIndex, block.properties.length - 1);
    if (destination === propertyIndex) return;
    this.mutate(() => {
      const [property] = block.properties.splice(propertyIndex, 1);
      if (property) block.properties.splice(destination, 0, property);
    });
  }

  private dropProperty(targetBlockId: string, destination: number): void {
    if (!this.draggedProperty) return;
    const sourceBlock = this.blocks.find(
      (block): block is CardPropertyTableBlock => (
        block.type === 'property-table' && block.id === this.draggedProperty?.blockId
      ),
    );
    const targetBlock = this.blocks.find(
      (block): block is CardPropertyTableBlock => (
        block.type === 'property-table' && block.id === targetBlockId
      ),
    );
    if (!sourceBlock || !targetBlock) return;
    const source = sourceBlock.properties.findIndex(
      (property) => property.id === this.draggedProperty?.propertyId,
    );
    if (source === -1) return;
    this.mutate(() => {
      const [property] = sourceBlock.properties.splice(source, 1);
      if (!property) return;
      const adjusted = sourceBlock === targetBlock && source < destination
        ? destination - 1
        : destination;
      targetBlock.properties.splice(
        Math.max(0, Math.min(adjusted, targetBlock.properties.length)),
        0,
        property,
      );
    });
    this.draggedProperty = null;
  }

  private updateCardStyle(update: (style: CardStyleConfig) => void): void {
    this.recordHistory();
    const style = { ...this.cardStyle };
    update(style);
    this.cardStyle = normalizeCardStyle(style) ?? {};
    this.schedulePreview();
  }

  private updateBlockStyle(
    block: CardBlock,
    update: (style: CardBlockStyle) => void,
  ): void {
    this.recordHistory();
    const style = { ...(block.style ?? {}) };
    update(style);
    block.style = normalizeCardBlockStyle(style);
    this.schedulePreview();
  }

  private applyPreset(preset: string): void {
    this.mutate(() => {
      this.layoutMode = preset === 'classic' ? 'stack' : 'grid';
      this.gridColumns = preset === 'profile' ? 2 : preset === 'compact' ? 3 : 2;
      this.layoutGap = preset === 'classic' ? 0 : preset === 'profile' ? 12 : 8;
      this.cardStyle = preset === 'classic'
        ? {}
        : {
          background: 'secondary',
          border: 'subtle',
          radius: preset === 'profile' ? 12 : 8,
          shadow: 'small',
          maxWidth: preset === 'profile' ? 640 : 560,
          padding: preset === 'profile' ? 12 : 8,
        };
      for (const block of this.blocks) {
        block.style = undefined;
        if (preset === 'classic') {
          block.width = undefined;
        } else if (block.type === 'title'
          || block.type === 'source'
          || block.type === 'divider'
          || block.type === 'property-table'
          || (preset === 'profile' && block.type === 'note')) {
          block.width = 'full';
        } else {
          block.width = undefined;
        }
        if (block.type === 'property-table') {
          block.columns = preset === 'classic' ? undefined : 2;
          block.rowMode = undefined;
          block.rows = undefined;
        }
      }
    });
  }

  private restoreDefaults(): void {
    this.mutate(() => {
      this.layoutMode = 'stack';
      this.gridColumns = 2;
      this.layoutGap = 0;
      this.cardStyle = {};
      for (const block of this.blocks) {
        block.width = undefined;
        block.style = undefined;
        if (block.type === 'property') this.resetPropertyDisplay(block.property);
        if (block.type === 'property-table') {
          block.columns = undefined;
          block.rowMode = undefined;
          block.rows = undefined;
          for (const property of block.properties) this.resetPropertyDisplay(property);
        }
      }
    });
  }

  private resetPropertyDisplay(property: CardPropertyEntry): void {
    property.label = undefined;
    property.labelPosition = undefined;
    property.alignment = undefined;
    property.labelWidth = undefined;
  }

  private applyState(state: InfoCardEditorState): void {
    this.blocks.splice(0, this.blocks.length, ...cloneCardBlocks(state.blocks));
    this.layoutMode = state.layoutMode;
    this.gridColumns = state.gridColumns;
    this.layoutGap = state.layoutGap;
    this.cardStyle = { ...state.cardStyle, cssClasses: state.cardStyle.cssClasses?.slice() };
    this.disableLivePreviewHover = state.disableLivePreviewHover;
  }

  private mutate(change: () => void): void {
    const scrollPosition = this.getScrollContainer().scrollTop;
    this.recordHistory();
    change();
    this.render();
    this.restoreScrollPosition(scrollPosition);
  }

  private setItemCollapsed(collection: Set<string>, id: string, collapsed: boolean): void {
    if (collapsed) collection.add(id);
    else collection.delete(id);
    this.rerenderPreservingScroll();
  }

  private setAllItemsCollapsed(collapsed: boolean): void {
    if (collapsed) {
      for (const block of this.blocks) {
        this.collapsedBlockIds.add(block.id);
        if (block.type === 'property-table') {
          for (const property of block.properties) {
            this.collapsedPropertyIds.add(property.id);
          }
        }
      }
    } else {
      this.collapsedBlockIds.clear();
      this.collapsedPropertyIds.clear();
    }
    this.rerenderPreservingScroll();
  }

  private pruneCollapsedItemIds(): void {
    const blockIds = new Set(this.blocks.map((block) => block.id));
    const propertyIds = new Set<string>();
    for (const block of this.blocks) {
      if (block.type === 'property') propertyIds.add(block.property.id);
      if (block.type === 'property-table') {
        for (const property of block.properties) propertyIds.add(property.id);
      }
    }
    for (const id of this.collapsedBlockIds) {
      if (!blockIds.has(id)) this.collapsedBlockIds.delete(id);
    }
    for (const id of this.collapsedPropertyIds) {
      if (!propertyIds.has(id)) this.collapsedPropertyIds.delete(id);
    }
  }

  private rerenderPreservingScroll(): void {
    const scrollPosition = this.getScrollContainer().scrollTop;
    this.render();
    this.restoreScrollPosition(scrollPosition);
  }

  private recordHistory(): void {
    this.history.push(this.snapshot());
    if (this.history.length > 50) this.history.shift();
    if (this.undoButton) this.undoButton.disabled = false;
  }

  private undo(): void {
    const previous = this.history.pop();
    if (!previous) return;
    const scrollPosition = this.getScrollContainer().scrollTop;
    this.applyState(previous);
    this.render();
    this.restoreScrollPosition(scrollPosition);
  }

  private getScrollContainer(): HTMLElement {
    return this.contentEl.closest<HTMLElement>('.modal-content') ?? this.contentEl;
  }

  private restoreScrollPosition(scrollPosition: number): void {
    const scrollContainer = this.getScrollContainer();
    scrollContainer.scrollTop = scrollPosition;
    if (this.scrollRestoreFrame !== null) {
      window.cancelAnimationFrame(this.scrollRestoreFrame);
    }
    this.scrollRestoreFrame = window.requestAnimationFrame(() => {
      this.scrollRestoreFrame = null;
      if (scrollContainer.isConnected) scrollContainer.scrollTop = scrollPosition;
    });
  }

  private snapshot(): InfoCardEditorState {
    return {
      blocks: cloneCardBlocks(this.blocks),
      layoutMode: this.layoutMode,
      gridColumns: this.gridColumns,
      layoutGap: this.layoutGap,
      cardStyle: {
        ...this.cardStyle,
        cssClasses: this.cardStyle.cssClasses?.slice(),
      },
      disableLivePreviewHover: this.disableLivePreviewHover,
    };
  }

  private currentCard(): CardConfig {
    return {
      blocks: cloneCardBlocks(normalizeCardBlocks(this.blocks) ?? []),
      useBlockLayout: true,
      layoutMode: this.layoutMode,
      gridColumns: this.gridColumns,
      layoutGap: this.layoutGap,
      cardStyle: normalizeCardStyle(this.cardStyle),
      disableLivePreviewHover: this.disableLivePreviewHover || undefined,
    };
  }

  private schedulePreview(delay = 80): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      const host = this.previewHost;
      if (!host?.isConnected) return;
      host.empty();
      void this.previewCard.renderPreview(host, this.sourceFilePath, this.currentCard());
    }, delay);
  }

  private blockLabel(block: CardBlock): string {
    if (block.type === 'property-table') return 'Property table';
    if (block.type === 'source') return 'Source link';
    return block.type.charAt(0).toUpperCase() + block.type.slice(1);
  }

  private blockEditorHeading(block: CardBlock, index: number): string {
    if (block.editorLabel) return block.editorLabel;
    if (block.type === 'title') {
      return `Title — ${this.editorExcerpt(block.text, `Item ${index + 1}`)}`;
    }
    if (block.type === 'note') {
      return `Note — ${this.editorExcerpt(block.markdown, `Item ${index + 1}`)}`;
    }
    if (block.type === 'property') {
      return `Property — ${this.editorExcerpt(block.property.reference, `Item ${index + 1}`)}`;
    }
    if (block.type === 'property-table') {
      const count = block.properties.length;
      return `Property table — ${count} ${count === 1 ? 'property' : 'properties'}`;
    }
    return this.blockLabel(block);
  }

  private propertyEditorHeading(property: CardPropertyEntry, index: number): string {
    if (property.editorLabel) return property.editorLabel;
    return `Property ${index + 1} — ${this.editorExcerpt(property.reference, 'Unconfigured')}`;
  }

  private editorExcerpt(value: string, fallback: string): string {
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
}

export class VariablePropertiesView extends ItemView {
  private panelContentEl: HTMLElement | null = null;
  private selectedVariableName: string | null = null;
  private active = false;
  private refreshGeneration = 0;
  private timers = new Set<number>();
  private metadataWaitCleanups = new Set<() => void>();
  private markdownChild: MarkdownRenderChild | null = null;
  private activeTab: PanelTab = 'link';
  private creatingVariableType: VariableType | null = null;
  private variableEditorOpen = true;
  private variableAppearanceOpen = true;

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
    this.plugin.trackPanel(this);
    this.containerEl.empty();
    this.containerEl.addClass('variable-links-panel');
    this.panelContentEl = this.containerEl.createDiv({ cls: 'variable-links-panel-inner' });
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.releasePluginResources();
    this.plugin.releasePanel(this);
    return Promise.resolve();
  }

  releasePluginResources(): void {
    this.active = false;
    this.refreshGeneration++;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const cleanup of [...this.metadataWaitCleanups]) cleanup();
    this.metadataWaitCleanups.clear();
    this.clearMarkdownChild();
    this.panelContentEl = null;
    this.containerEl.empty();
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
      new DeleteVariableModal(this.plugin, activeName, () => void this.deleteVariable(activeName)).open();
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

    const form = parent.createEl('form', { cls: 'variable-links-panel-variable-form' });
    const editSection = form.createEl('details', { cls: 'variable-links-panel-editor' });
    editSection.open = this.variableEditorOpen;
    editSection.addEventListener('toggle', () => {
      this.variableEditorOpen = editSection.open;
    });
    editSection.createEl('summary', { text: title });
    const editControls = editSection.createDiv({ cls: 'variable-links-panel-section-content' });
    const nameInput = this.addInput(editControls, 'Variable name', name, 'e.g. customer');
    const propertyLinkInput = this.addInput(
      editControls,
      'Property link',
      formatPropertyLink(definition.file, definition.property),
      '[[People/John Smith]]#company',
    );
    const propertyLinkRow = propertyLinkInput.parentElement;
    const fixedValueInput = this.addInput(
      editControls,
      'Value',
      definition.value ?? '',
      'Value displayed by this variable',
    );
    const fixedValueRow = fixedValueInput.parentElement;
    const linkedValueRow = editControls.createDiv({
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
      editControls,
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
      editControls,
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
        this.plugin,
        activeType,
        nextType,
        () => applyType(nextType),
      ).open();
    });
    updateTypeFields();
    let favoriteInput: HTMLInputElement | null = null;
    if (!existingVariable) {
      const favoriteRow = editControls.createDiv({ cls: 'variable-links-panel-checkbox' });
      favoriteInput = favoriteRow.createEl('input', { type: 'checkbox' });
      favoriteInput.checked = definition.favorite === true;
      favoriteRow.createEl('label', { text: 'Favorite' });
    }

    const appearanceSection = form.createEl('details', {
      cls: 'variable-links-panel-appearance',
    });
    appearanceSection.open = this.variableAppearanceOpen;
    appearanceSection.addEventListener('toggle', () => {
      this.variableAppearanceOpen = appearanceSection.open;
    });
    appearanceSection.createEl('summary', { text: 'Variable appearance' });
    const appearanceControls = appearanceSection.createDiv({
      cls: 'variable-links-panel-section-content',
    });
    const defaultAppearance = getDefaultVariableAppearance(this.plugin.settings);
    const useDefaults = definition.appearance === undefined;
    const appearance = definition.appearance ?? defaultAppearance;
    const defaultsRow = appearanceControls.createDiv({ cls: 'variable-links-panel-appearance-defaults' });
    const useDefaultsInput = this.addInlineCheckbox(
      defaultsRow,
      'Use default appearance',
      useDefaults,
    );
    const restoreDefaultsButton = defaultsRow.createEl('button', {
      text: 'Restore defaults',
      attr: { type: 'button' },
    });
    const emphasisRow = appearanceControls.createDiv({ cls: 'variable-links-panel-appearance-options' });
    const boldInput = this.addInlineCheckbox(emphasisRow, 'Bold', appearance.bold === true);
    const italicInput = this.addInlineCheckbox(emphasisRow, 'Italic', appearance.italic === true);
    const decorationRow = appearanceControls.createDiv({ cls: 'variable-links-panel-field' });
    decorationRow.createEl('label', { text: 'Decoration:' });
    const decorationInput = decorationRow.createEl('select');
    decorationInput.createEl('option', { text: 'Underline', value: 'underline' });
    decorationInput.createEl('option', { text: 'Highlight', value: 'highlight' });
    decorationInput.createEl('option', { text: 'None', value: 'none' });
    decorationInput.value = appearance.decoration ?? 'underline';
    const colorRow = appearanceControls.createDiv({ cls: 'variable-links-panel-decoration-color' });
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
    const opacityRow = appearanceControls.createDiv({ cls: 'variable-links-panel-opacity' });
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
    const swatchRow = appearanceControls.createDiv({ cls: 'variable-links-panel-color-swatches' });
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
      const layoutSummary = card.layoutMode === 'grid'
        ? `Grid · ${card.gridColumns ?? 2} columns`
        : 'Stack';
      summary.createEl('strong', {
        text: `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} · ${layoutSummary}`,
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
          this.plugin,
          name,
          card,
          filePathFromLink(cardSourceFile),
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
        this.metadataWaitCleanups.delete(finish);
        resolve();
      };
      const eventRef = this.app.metadataCache.on('changed', (changedFile) => {
        if (changedFile.path === file.path) finish();
      });
      const timer = window.setTimeout(finish, 1000);
      this.metadataWaitCleanups.add(finish);
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
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = parent.createDiv({ cls: 'variable-links-panel-field' });
    row.createEl('label', { text: `${label}:` });
    const input = row.createEl('input', { type: 'text', placeholder });
    input.value = value;
    return input;
  }

  private addTextarea(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLTextAreaElement {
    const row = parent.createDiv({
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
