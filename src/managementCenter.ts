import {
  ItemView,
  Modal,
  Notice,
  WorkspaceLeaf,
  setIcon,
  type ViewStateResult,
} from 'obsidian';
import type VariableLinksPlugin from './main';
import { getVariableType, type VariableDefinition } from './registry';

export const VIEW_TYPE_MANAGEMENT_CENTER = 'variable-links-management-center';

type ManagementActivity = 'variables';
type OwnershipFilter = 'all' | 'manual' | 'managed';
type VariableTypeFilter = 'all' | 'property' | 'fixed';
type VariableSort = 'name-ascending' | 'name-descending' | 'type' | 'source';

interface ManagementCenterState {
  activity: ManagementActivity;
  query: string;
  ownership: OwnershipFilter;
  variableType: VariableTypeFilter;
  sort: VariableSort;
  selected: string[];
}

interface VariableEntry {
  definition: VariableDefinition;
  key: string;
  name: string;
}

const DEFAULT_STATE: ManagementCenterState = {
  activity: 'variables',
  query: '',
  ownership: 'all',
  variableType: 'all',
  sort: 'name-ascending',
  selected: [],
};

export class ManagementCenterView extends ItemView {
  private active = false;
  private selectionAnchorKey: string | null = null;
  private state: ManagementCenterState = { ...DEFAULT_STATE };

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VariableLinksPlugin,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_MANAGEMENT_CENTER;
  }

  getDisplayText(): string {
    return 'Variable links management center';
  }

  getIcon(): string {
    return 'database';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), ...this.state };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.state = readState(state);
    await super.setState(state, result);
    this.refresh();
  }

  async onOpen(): Promise<void> {
    this.active = true;
    this.contentEl.addClass('variable-links-management-center');
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.active = false;
    this.contentEl.empty();
  }

  refresh(): void {
    if (!this.active) return;
    const entries = this.getEntries();
    const validKeys = new Set(entries.map(({ key }) => key));
    this.state.selected = this.state.selected.filter((key) => validKeys.has(key));
    const managed = entries.filter(({ definition }) => definition.managed).length;

    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: 'variable-links-management-center-header' });
    header.createEl('h2', { text: 'Variable links management center' });
    header.createEl('p', {
      text: 'Manage variable links and related plugin data from one workspace tab.',
      cls: 'variable-links-hint-text',
    });

    const tabs = this.contentEl.createDiv({
      cls: 'variable-links-management-center-tabs',
      attr: { role: 'tablist', 'aria-label': 'Management activities' },
    });
    tabs.createEl('button', {
      text: 'Variables',
      cls: 'variable-links-management-center-tab is-active',
      attr: { type: 'button', role: 'tab', 'aria-selected': 'true' },
    });

    const content = this.contentEl.createDiv({
      cls: 'variable-links-management-center-content',
      attr: { role: 'tabpanel', 'aria-label': 'Variables' },
    });
    content.createEl('h3', { text: 'Variable links' });
    const summary = content.createDiv({ cls: 'variable-links-management-center-summary' });
    this.addSummaryItem(summary, 'Total', entries.length);
    this.addSummaryItem(summary, 'Manual', entries.length - managed);
    this.addSummaryItem(summary, 'Managed', managed);

    const controls = content.createDiv({ cls: 'variable-links-management-center-controls' });
    const search = controls.createEl('input', {
      cls: 'variable-links-management-center-search',
      attr: {
        type: 'search',
        value: this.state.query,
        placeholder: 'Search variables',
        'aria-label': 'Search variables',
      },
    });
    const ownership = this.addSelect(
      controls,
      'Ownership',
      [['all', 'All ownership'], ['manual', 'Manual'], ['managed', 'Managed']],
      this.state.ownership,
    );
    const variableType = this.addSelect(
      controls,
      'Variable type',
      [['all', 'All types'], ['property', 'Property'], ['fixed', 'Fixed value']],
      this.state.variableType,
    );
    const sort = this.addSelect(
      controls,
      'Sort variables',
      [
        ['name-ascending', 'Name: A–Z'],
        ['name-descending', 'Name: Z–A'],
        ['type', 'Type'],
        ['source', 'Source'],
      ],
      this.state.sort,
    );

    const status = content.createDiv({
      cls: 'variable-links-management-center-list-status variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    const list = content.createDiv({ cls: 'variable-links-management-center-list' });
    const renderList = (): void => this.renderList(entries, list, status);
    search.addEventListener('input', () => {
      this.state.query = search.value;
      this.saveViewState();
      renderList();
    });
    ownership.addEventListener('change', () => {
      this.state.ownership = readOwnershipFilter(ownership.value);
      this.saveViewState();
      renderList();
    });
    variableType.addEventListener('change', () => {
      this.state.variableType = readVariableTypeFilter(variableType.value);
      this.saveViewState();
      renderList();
    });
    sort.addEventListener('change', () => {
      this.state.sort = readVariableSort(sort.value);
      this.saveViewState();
      renderList();
    });
    renderList();
  }

  private getEntries(): VariableEntry[] {
    return this.plugin.registry
      ? [...this.plugin.registry.data.entries()].map(([name, definition]) => ({
          name,
          definition,
          key: definition.guid?.trim() || `name:${name}`,
        }))
      : [];
  }

  private renderList(
    entries: readonly VariableEntry[],
    list: HTMLElement,
    status: HTMLElement,
  ): void {
    list.empty();
    const visible = this.filterAndSort(entries);
    const selected = new Set(this.state.selected);
    const updateStatus = (): void => {
      status.setText(`Showing ${visible.length} of ${entries.length} · ${selected.size} selected`);
    };
    updateStatus();

    if (!visible.length) {
      list.createEl('p', {
        text: entries.length ? 'No variables match the current filters.' : 'No variables are registered yet.',
        cls: 'variable-links-management-center-empty variable-links-hint-text',
      });
      return;
    }

    const header = list.createDiv({ cls: 'variable-links-management-center-list-header' });
    const selectAll = header.createEl('input', {
      attr: { type: 'checkbox', 'aria-label': 'Select all visible variables' },
    });
    const selectedVisible = visible.filter(({ key }) => selected.has(key)).length;
    selectAll.checked = selectedVisible === visible.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    const itemCheckboxes: HTMLInputElement[] = [];
    header.createSpan({ text: 'Name' });
    header.createSpan({ text: 'Source or value' });
    header.createSpan({ text: 'Type' });
    header.createSpan({ text: 'Actions', cls: 'variable-links-management-center-actions-label' });
    selectAll.addEventListener('change', () => {
      for (const { key } of visible) {
        if (selectAll.checked) selected.add(key);
        else selected.delete(key);
      }
      this.state.selected = [...selected];
      this.saveViewState();
      for (const checkbox of itemCheckboxes) checkbox.checked = selectAll.checked;
      this.selectionAnchorKey = null;
      selectAll.indeterminate = false;
      updateStatus();
    });

    for (const entry of visible) {
      const row = list.createDiv({ cls: 'variable-links-management-center-row' });
      const checkbox = row.createEl('input', {
        attr: { type: 'checkbox', 'aria-label': `Select ${entry.name}` },
      });
      checkbox.checked = selected.has(entry.key);
      itemCheckboxes.push(checkbox);
      checkbox.addEventListener('click', (event) => {
        const anchorIndex = this.selectionAnchorKey === null
          ? -1
          : visible.findIndex(({ key }) => key === this.selectionAnchorKey);
        const clickedIndex = visible.findIndex(({ key }) => key === entry.key);
        if (event.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
          const first = Math.min(anchorIndex, clickedIndex);
          const last = Math.max(anchorIndex, clickedIndex);
          for (let index = first; index <= last; index++) {
            const rangeEntry = visible[index];
            const rangeCheckbox = itemCheckboxes[index];
            if (!rangeEntry || !rangeCheckbox) continue;
            rangeCheckbox.checked = checkbox.checked;
            if (checkbox.checked) selected.add(rangeEntry.key);
            else selected.delete(rangeEntry.key);
          }
        } else if (checkbox.checked) selected.add(entry.key);
        else selected.delete(entry.key);
        this.selectionAnchorKey = entry.key;
        this.state.selected = [...selected];
        this.saveViewState();
        const checkedCount = itemCheckboxes.filter((item) => item.checked).length;
        selectAll.checked = checkedCount === itemCheckboxes.length;
        selectAll.indeterminate = checkedCount > 0 && checkedCount < itemCheckboxes.length;
        updateStatus();
      });

      row.createDiv({ text: entry.name, cls: 'variable-links-management-center-name' });
      const sourceText = this.getSourceText(entry.definition);
      row.createDiv({
        text: sourceText,
        cls: 'variable-links-management-center-source',
        attr: { title: sourceText },
      });
      const badges = row.createDiv({ cls: 'variable-links-management-center-badges' });
      badges.createSpan({
        text: getVariableType(entry.definition) === 'fixed' ? 'Fixed' : 'Property',
        cls: 'variable-links-management-center-badge',
      });
      if (entry.definition.managed) {
        badges.createSpan({ text: 'Managed', cls: 'variable-links-management-center-badge' });
      }

      const actions = row.createDiv({ cls: 'variable-links-management-center-actions' });
      const edit = actions.createEl('button', {
        cls: 'clickable-icon',
        attr: { type: 'button', 'aria-label': `Open settings for ${entry.name}` },
      });
      edit.setAttribute('title', 'Open variable settings');
      setIcon(edit, 'settings');
      edit.addEventListener('click', () => void this.plugin.openVariableProperties(entry.name));
      const remove = actions.createEl('button', {
        cls: 'clickable-icon',
        attr: { type: 'button', 'aria-label': `Delete ${entry.name}` },
      });
      remove.setAttribute('title', 'Delete variable');
      setIcon(remove, 'trash-2');
      remove.addEventListener('click', () => {
        new DeleteManagedVariableModal(this.plugin, entry.name, () => {
          void this.deleteVariable(entry);
        }).open();
      });
    }
  }

  private filterAndSort(entries: readonly VariableEntry[]): VariableEntry[] {
    const terms = this.state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const visible = entries.filter(({ name, definition }) => {
      if (this.state.ownership === 'managed' && !definition.managed) return false;
      if (this.state.ownership === 'manual' && definition.managed) return false;
      if (this.state.variableType !== 'all' && getVariableType(definition) !== this.state.variableType) {
        return false;
      }
      const searchable = [
        name,
        definition.file,
        definition.property,
        definition.value ?? '',
        definition.link ?? '',
        definition.managed?.profileId ?? '',
      ].join(' ').toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    return visible.sort((left, right) => {
      if (this.state.sort === 'name-descending') return compareText(right.name, left.name);
      if (this.state.sort === 'type') {
        return compareText(getVariableType(left.definition), getVariableType(right.definition))
          || compareText(left.name, right.name);
      }
      if (this.state.sort === 'source') {
        return compareText(this.getSourceText(left.definition), this.getSourceText(right.definition))
          || compareText(left.name, right.name);
      }
      return compareText(left.name, right.name);
    });
  }

  private getSourceText(definition: VariableDefinition): string {
    if (getVariableType(definition) === 'fixed') return definition.value ?? '';
    const file = definition.file.trim();
    const property = definition.property.trim();
    return property ? `${file}#${property}` : file;
  }

  private addSummaryItem(parent: HTMLElement, label: string, value: number): void {
    const item = parent.createDiv({ cls: 'variable-links-management-center-summary-item' });
    item.createSpan({ text: label, cls: 'variable-links-hint-text' });
    item.createEl('strong', { text: String(value) });
  }

  private addSelect(
    parent: HTMLElement,
    label: string,
    options: readonly (readonly [string, string])[],
    selected: string,
  ): HTMLSelectElement {
    const select = parent.createEl('select', { attr: { 'aria-label': label } });
    for (const [value, text] of options) {
      const option = select.createEl('option', { text, value });
      option.selected = value === selected;
    }
    return select;
  }

  private async deleteVariable(entry: VariableEntry): Promise<void> {
    const registry = this.plugin.registry;
    if (!registry) return;
    const wasSelected = this.state.selected.includes(entry.key);
    this.state.selected = this.state.selected.filter((key) => key !== entry.key);
    try {
      await registry.deleteVariable(entry.name);
      this.saveViewState();
      new Notice(`Variable Links: deleted “${entry.name}”.`);
    } catch (error) {
      if (wasSelected) this.state.selected.push(entry.key);
      this.refresh();
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private saveViewState(): void {
    this.app.workspace.requestSaveLayout();
  }
}

class DeleteManagedVariableModal extends Modal {
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
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    actions.createEl('button', {
      text: 'Delete',
      cls: 'mod-warning',
      attr: { type: 'button' },
    }).addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }
}

function readState(state: unknown): ManagementCenterState {
  const record = typeof state === 'object' && state !== null && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return {
    activity: 'variables',
    query: typeof record.query === 'string' ? record.query : '',
    ownership: readOwnershipFilter(record.ownership),
    variableType: readVariableTypeFilter(record.variableType),
    sort: readVariableSort(record.sort),
    selected: Array.isArray(record.selected)
      ? record.selected.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function readOwnershipFilter(value: unknown): OwnershipFilter {
  return value === 'manual' || value === 'managed' ? value : 'all';
}

function readVariableTypeFilter(value: unknown): VariableTypeFilter {
  return value === 'property' || value === 'fixed' ? value : 'all';
}

function readVariableSort(value: unknown): VariableSort {
  return value === 'name-descending' || value === 'type' || value === 'source'
    ? value
    : 'name-ascending';
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}
