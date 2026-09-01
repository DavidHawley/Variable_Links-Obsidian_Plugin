import {
  ItemView,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type ViewStateResult,
} from 'obsidian';
import type VariableLinksPlugin from './main';
import {
  getVariableType,
  type VariableDefinition,
  type VariableRename,
} from './registry';
import type { TokenValueReplacement, TokenValueReplacementPlan } from './tokenCache';
import { getTokenSyntax } from './tokenSyntax';
import { parseVariableTextCaseMarker } from './textCase';
import { filePathFromLink } from './linkSyntax';
import { renderNamePattern, type NamePatternContext } from './namePattern';
import { addContextHelpButton } from './contextHelp';
import { renderNamePatternHelp } from './namePatternHelp';
import {
  DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES,
  normalizeVaultPath,
  profileMatchesPath,
} from './autolink';

export const VIEW_TYPE_MANAGEMENT_CENTER = 'variable-links-management-center';

type ManagementActivity = 'variables';
type MassRenameMode = 'prefix' | 'suffix' | 'replace' | 'pattern' | 'profile-pattern';
type RenameWordSelection = 'whole' | 'first' | 'last' | 'custom';
type OwnershipFilter = 'all' | 'manual' | 'managed';
type VariableTypeFilter = 'all' | 'property' | 'fixed';
type VariableSort = 'name-ascending' | 'name-descending' | 'type' | 'source' | 'property' | 'profile';
type ManagementPageSize = 20 | 50 | 100 | 250 | 'all';

interface ManagementCenterState {
  activity: ManagementActivity;
  query: string;
  ownership: OwnershipFilter;
  profileId: string;
  variableType: VariableTypeFilter;
  sort: VariableSort;
  page: number;
  pageSize: ManagementPageSize;
  selected: string[];
}

interface VariableEntry {
  definition: VariableDefinition;
  key: string;
  name: string;
}

interface DeletionPreview {
  fileCount: number;
  replacements: Map<string, TokenValueReplacement>;
  tokenCount: number;
  unresolvedNames: string[];
}

interface ProfilePatternRenameData {
  context: NamePatternContext;
  counter: number;
  error: string;
  fixedName: string;
  pattern: string;
}

const DEFAULT_STATE: ManagementCenterState = {
  activity: 'variables',
  query: '',
  ownership: 'all',
  profileId: 'all',
  variableType: 'all',
  sort: 'name-ascending',
  page: 1,
  pageSize: 50,
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

    const listTools = content.createDiv({ cls: 'variable-links-management-center-list-tools' });
    const controls = listTools.createDiv({ cls: 'variable-links-management-center-controls' });
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
    const profileOptions = this.getProfileFilterOptions(entries);
    if (!profileOptions.some(([value]) => value === this.state.profileId)) {
      this.state.profileId = 'all';
    }
    if (this.state.profileId !== 'all') {
      this.state.ownership = 'managed';
      ownership.value = 'managed';
    }
    const profile = this.addSelect(
      controls,
      'Autolink profile',
      profileOptions,
      this.state.profileId,
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
        ['property', 'Property'],
        ['profile', 'Autolink profile'],
      ],
      this.state.sort,
    );

    const listToolbar = listTools.createDiv({ cls: 'variable-links-management-center-list-toolbar' });
    const status = listToolbar.createDiv({
      cls: 'variable-links-management-center-list-status variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    const bulkActions = listToolbar.createDiv({
      cls: 'variable-links-management-center-bulk-actions',
    });
    const selectProfile = bulkActions.createEl('button', {
      text: 'Select profile',
      attr: { type: 'button' },
    });
    const renameSelected = bulkActions.createEl('button', {
      text: 'Rename selected',
      attr: { type: 'button' },
    });
    renameSelected.addEventListener('click', () => {
      void this.openMassRename(entries).catch((error: unknown) => {
        new Notice(`Variable Links: could not prepare pattern data: ${getErrorMessage(error)}`);
      });
    });
    const deleteSelected = bulkActions.createEl('button', {
      text: 'Delete selected',
      cls: 'mod-warning',
      attr: { type: 'button' },
    });
    deleteSelected.addEventListener('click', () => {
      void this.confirmBulkDelete(entries);
    });
    const pagination = content.createDiv({ cls: 'variable-links-management-center-pagination' });
    pagination.createSpan({ text: 'Rows per page:', cls: 'variable-links-hint-text' });
    const pageSize = this.addSelect(
      pagination,
      'Rows per page',
      [['20', '20'], ['50', '50'], ['100', '100'], ['250', '250'], ['all', 'All']],
      String(this.state.pageSize),
    );
    const previousPage = pagination.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': 'Previous page', title: 'Previous page' },
    });
    setIcon(previousPage, 'chevron-left');
    const pageStatus = pagination.createSpan({
      cls: 'variable-links-management-center-page-status variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    const nextPage = pagination.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': 'Next page', title: 'Next page' },
    });
    setIcon(nextPage, 'chevron-right');
    const list = content.createDiv({ cls: 'variable-links-management-center-list' });
    const renderList = (): void => this.renderList(
      entries,
      list,
      status,
      renameSelected,
      deleteSelected,
      previousPage,
      pageStatus,
      nextPage,
    );
    const updateSelectProfile = (): void => {
      const profileId = this.state.profileId;
      const count = profileId === 'all'
        ? 0
        : entries.filter(({ definition }) => definition.managed?.profileId === profileId).length;
      selectProfile.disabled = profileId === 'all' || count === 0;
      selectProfile.setText(count ? `Select profile (${count})` : 'Select profile');
    };
    selectProfile.addEventListener('click', () => {
      if (this.state.profileId === 'all') return;
      const selected = new Set(this.state.selected);
      for (const { definition, key } of entries) {
        if (definition.managed?.profileId === this.state.profileId) selected.add(key);
      }
      this.state.selected = [...selected];
      this.selectionAnchorKey = null;
      this.saveViewState();
      renderList();
    });
    search.addEventListener('input', () => {
      this.state.query = search.value;
      this.resetPage();
      this.saveViewState();
      renderList();
    });
    ownership.addEventListener('change', () => {
      this.state.ownership = readOwnershipFilter(ownership.value);
      if (this.state.ownership !== 'managed') {
        this.state.profileId = 'all';
        profile.value = 'all';
      }
      this.resetPage();
      this.saveViewState();
      updateSelectProfile();
      renderList();
    });
    profile.addEventListener('change', () => {
      this.state.profileId = profile.value;
      if (this.state.profileId !== 'all') {
        this.state.ownership = 'managed';
        ownership.value = 'managed';
      }
      this.resetPage();
      this.saveViewState();
      updateSelectProfile();
      renderList();
    });
    variableType.addEventListener('change', () => {
      this.state.variableType = readVariableTypeFilter(variableType.value);
      this.resetPage();
      this.saveViewState();
      renderList();
    });
    sort.addEventListener('change', () => {
      this.state.sort = readVariableSort(sort.value);
      this.resetPage();
      this.saveViewState();
      renderList();
    });
    pageSize.addEventListener('change', () => {
      this.state.pageSize = readManagementPageSize(pageSize.value);
      this.resetPage();
      this.saveViewState();
      renderList();
    });
    previousPage.addEventListener('click', () => {
      if (this.state.page <= 1) return;
      this.state.page--;
      this.selectionAnchorKey = null;
      this.saveViewState();
      renderList();
    });
    nextPage.addEventListener('click', () => {
      this.state.page++;
      this.selectionAnchorKey = null;
      this.saveViewState();
      renderList();
    });
    updateSelectProfile();
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

  private getProfileFilterOptions(
    entries: readonly VariableEntry[],
  ): Array<readonly [string, string]> {
    const options: Array<readonly [string, string]> = [['all', 'All profiles']];
    const knownIds = new Set<string>();
    for (const profile of this.plugin.registry?.autolinkProfiles ?? []) {
      knownIds.add(profile.id);
      options.push([profile.id, profile.name]);
    }
    const missingIds = new Set(entries
      .map(({ definition }) => definition.managed?.profileId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && !knownIds.has(id)));
    for (const id of [...missingIds].sort(compareText)) {
      options.push([id, `Missing profile: ${id}`]);
    }
    return options;
  }

  private renderList(
    entries: readonly VariableEntry[],
    list: HTMLElement,
    status: HTMLElement,
    renameSelected: HTMLButtonElement,
    deleteSelected: HTMLButtonElement,
    previousPage: HTMLButtonElement,
    pageStatus: HTMLElement,
    nextPage: HTMLButtonElement,
  ): void {
    list.empty();
    const visible = this.filterAndSort(entries);
    const pageSize = this.state.pageSize === 'all' ? Math.max(visible.length, 1) : this.state.pageSize;
    const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
    this.state.page = Math.min(Math.max(1, this.state.page), pageCount);
    const firstIndex = (this.state.page - 1) * pageSize;
    const pageEntries = visible.slice(firstIndex, firstIndex + pageSize);
    const selected = new Set(this.state.selected);
    const updateStatus = (): void => {
      const range = visible.length
        ? `${firstIndex + 1}–${firstIndex + pageEntries.length}`
        : '0';
      status.setText(`Showing ${range} of ${visible.length} matching · ${selected.size} selected`);
      renameSelected.disabled = selected.size === 0;
      renameSelected.setText(selected.size ? `Rename selected (${selected.size})` : 'Rename selected');
      deleteSelected.disabled = selected.size === 0;
      deleteSelected.setText(selected.size ? `Delete selected (${selected.size})` : 'Delete selected');
      previousPage.disabled = this.state.page <= 1;
      nextPage.disabled = this.state.page >= pageCount;
      pageStatus.setText(`Page ${this.state.page} of ${pageCount}`);
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
      attr: { type: 'checkbox', 'aria-label': 'Select all variables on this page' },
    });
    const selectedVisible = pageEntries.filter(({ key }) => selected.has(key)).length;
    selectAll.checked = selectedVisible === pageEntries.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < pageEntries.length;
    const itemCheckboxes: HTMLInputElement[] = [];
    header.createSpan({ text: 'Name' });
    header.createSpan({ text: 'Source or value' });
    header.createSpan({ text: 'Type' });
    header.createSpan({ text: 'Actions', cls: 'variable-links-management-center-actions-label' });
    selectAll.addEventListener('change', () => {
      for (const { key } of pageEntries) {
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

    for (const entry of pageEntries) {
      const row = list.createDiv({ cls: 'variable-links-management-center-row' });
      const checkbox = row.createEl('input', {
        attr: { type: 'checkbox', 'aria-label': `Select ${entry.name}` },
      });
      checkbox.checked = selected.has(entry.key);
      itemCheckboxes.push(checkbox);
      checkbox.addEventListener('click', (event) => {
        const anchorIndex = this.selectionAnchorKey === null
          ? -1
          : pageEntries.findIndex(({ key }) => key === this.selectionAnchorKey);
        const clickedIndex = pageEntries.findIndex(({ key }) => key === entry.key);
        if (event.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
          const first = Math.min(anchorIndex, clickedIndex);
          const last = Math.max(anchorIndex, clickedIndex);
          for (let index = first; index <= last; index++) {
            const rangeEntry = pageEntries[index];
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
        const profileName = this.getProfileName(entry.definition.managed.profileId);
        badges.createSpan({
          text: profileName,
          cls: 'variable-links-management-center-badge variable-links-management-center-profile-badge',
          attr: { title: profileName },
        });
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
        void this.confirmSingleDelete(entry);
      });
    }
  }

  private resetPage(): void {
    this.state.page = 1;
    this.selectionAnchorKey = null;
  }

  private filterAndSort(entries: readonly VariableEntry[]): VariableEntry[] {
    const terms = this.state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const visible = entries.filter(({ name, definition }) => {
      if (this.state.ownership === 'managed' && !definition.managed) return false;
      if (this.state.ownership === 'manual' && definition.managed) return false;
      if (this.state.profileId !== 'all'
        && definition.managed?.profileId !== this.state.profileId) return false;
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
        this.getProfileName(definition.managed?.profileId),
      ].join(' ').toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    return this.sortEntries(visible);
  }

  private sortEntries(entries: readonly VariableEntry[]): VariableEntry[] {
    return [...entries].sort((left, right) => {
      if (this.state.sort === 'name-descending') return compareText(right.name, left.name);
      if (this.state.sort === 'type') {
        return compareText(getVariableType(left.definition), getVariableType(right.definition))
          || compareText(left.name, right.name);
      }
      if (this.state.sort === 'source') {
        return compareText(this.getSourceText(left.definition), this.getSourceText(right.definition))
          || compareText(left.name, right.name);
      }
      if (this.state.sort === 'property') {
        return compareText(left.definition.property, right.definition.property)
          || compareText(left.name, right.name);
      }
      if (this.state.sort === 'profile') {
        return compareText(
          this.getProfileName(left.definition.managed?.profileId),
          this.getProfileName(right.definition.managed?.profileId),
        ) || compareText(left.name, right.name);
      }
      return compareText(left.name, right.name);
    });
  }

  private getProfileName(profileId: string | undefined): string {
    if (!profileId) return 'Manual';
    return this.plugin.registry?.autolinkProfiles.find(({ id }) => id === profileId)?.name
      ?? `Missing profile: ${profileId}`;
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

  private async confirmSingleDelete(entry: VariableEntry): Promise<void> {
    try {
      const preview = await this.prepareDeletionPreview([entry]);
      new DeleteManagedVariableModal(this.plugin, entry.name, preview, (replaceTokens) => {
        void this.deleteVariables([entry], replaceTokens ? preview : null);
      }).open();
    } catch (error) {
      new Notice(
        `Variable Links: could not prepare deletion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async openMassRename(entries: readonly VariableEntry[]): Promise<void> {
    const selectedKeys = new Set(this.state.selected);
    const selectedEntries = this.sortEntries(entries.filter(({ key }) => selectedKeys.has(key)));
    if (!selectedEntries.length) return;
    const contexts = new Map<string, NamePatternContext>();
    const profilePatterns = new Map<string, ProfilePatternRenameData>();
    for (const entry of selectedEntries) {
      const context = await this.buildNamePatternContext(entry);
      contexts.set(entry.key, context);
      profilePatterns.set(entry.key, this.buildProfilePatternRenameData(entry, context));
    }
    new MassRenameVariablesModal(
      this.plugin,
      selectedEntries,
      new Set(entries.map(({ name }) => name)),
      contexts,
      profilePatterns,
      (renames) => void this.renameVariables(renames),
    ).open();
  }

  private async buildNamePatternContext(entry: VariableEntry): Promise<NamePatternContext> {
    const definition = entry.definition;
    const sourcePath = definition.managed?.sourcePath || filePathFromLink(definition.file);
    const markdownPath = sourcePath && !/\.md$/i.test(sourcePath) ? `${sourcePath}.md` : sourcePath;
    const sourceFile = markdownPath ? this.app.vault.getFileByPath(markdownPath) : null;
    let properties: Readonly<Record<string, unknown>> | undefined;
    if (sourceFile instanceof TFile) {
      const cached: unknown = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
      if (isRecord(cached)) properties = cached;
      else {
        const content = await this.app.vault.read(sourceFile);
        properties = this.plugin.resolver?.extractFrontmatter(content) ?? undefined;
      }
    }
    const resolved = await this.plugin.resolver?.resolve(entry.name).catch(() => null);
    const profileId = definition.managed?.profileId;
    const profile = profileId
      ? this.plugin.registry?.autolinkProfiles.find(({ id }) => id === profileId)
      : undefined;
    return {
      filename: sourceFile?.basename,
      folder: sourceFile?.parent?.name || undefined,
      path: sourceFile?.path.replace(/\.md$/i, ''),
      profile: profile?.name,
      properties,
      property: definition.property || undefined,
      value: resolved?.ok ? resolved.value : undefined,
      variable: entry.name,
    };
  }

  private buildProfilePatternRenameData(
    entry: VariableEntry,
    context: NamePatternContext,
  ): ProfilePatternRenameData {
    const managed = entry.definition.managed;
    const empty = (error: string): ProfilePatternRenameData => ({
      pattern: '',
      fixedName: '',
      context: {},
      counter: 0,
      error,
    });
    if (!managed) return empty('Not managed by an Autolink profile');
    const profile = this.plugin.registry?.autolinkProfiles.find(({ id }) => id === managed.profileId);
    if (!profile) return empty('Managing Autolink profile is missing');
    const sourcePath = normalizeVaultPath(managed.sourcePath);
    const sourceFile = this.app.vault.getFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) return empty('Managed source note is missing');
    if (!profileMatchesPath(profile, sourceFile.path)) {
      return empty('Managed source note is outside the profile scope');
    }
    const matchedFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => profileMatchesPath(profile, file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const sourceIndex = matchedFiles.findIndex((file) =>
      normalizeVaultPath(file.path).toLocaleLowerCase() === sourcePath.toLocaleLowerCase()
    );
    if (sourceIndex === -1) {
      return empty('Managed source note is not in the profile scan order');
    }
    let fixedName = '';
    let valueProperty = profile.valueProperty;
    if (profile.allowOverrides) {
      const overrideProperties = profile.customOverridePropertyNames
        ? profile.overrideProperties
        : DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES;
      const override = context.properties?.[overrideProperties.name];
      if (override !== undefined && override !== null && override !== '') {
        if (typeof override !== 'string') return empty(`${overrideProperties.name} must contain text`);
        fixedName = override.trim();
        if (!fixedName) return empty(`${overrideProperties.name} cannot be blank`);
        if (/\s/u.test(fixedName)) return empty(`${overrideProperties.name} contains whitespace`);
      }
      const valuePropertyOverride = context.properties?.[overrideProperties.valueProperty];
      if (valuePropertyOverride !== undefined
        && valuePropertyOverride !== null
        && valuePropertyOverride !== '') {
        if (typeof valuePropertyOverride !== 'string') {
          return empty(`${overrideProperties.valueProperty} must contain text`);
        }
        valueProperty = valuePropertyOverride.trim();
        if (!valueProperty) return empty(`${overrideProperties.valueProperty} cannot be blank`);
      }
    }
    return {
      pattern: profile.namePattern || '{filename}',
      fixedName,
      context: {
        filename: context.filename,
        folder: context.folder,
        path: context.path,
        profile: profile.name,
        properties: context.properties,
        property: valueProperty || undefined,
        value: valueProperty ? context.properties?.[valueProperty] : undefined,
      },
      counter: sourceIndex + 1,
      error: '',
    };
  }

  private async renameVariables(renames: readonly VariableRename[]): Promise<void> {
    const registry = this.plugin.registry;
    if (!registry) return;
    try {
      const result = await registry.renameVariables(renames);
      new Notice(
        `Variable Links: renamed ${result.renamed} variable link${result.renamed === 1 ? '' : 's'} and updated ${result.tokenCount} token${result.tokenCount === 1 ? '' : 's'} in ${result.fileCount} note${result.fileCount === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      this.refresh();
    }
  }

  private async confirmBulkDelete(entries: readonly VariableEntry[]): Promise<void> {
    const selectedKeys = new Set(this.state.selected);
    const selectedEntries = entries.filter(({ key }) => selectedKeys.has(key));
    if (!selectedEntries.length) return;
    const visibleKeys = new Set(this.filterAndSort(entries).map(({ key }) => key));
    const hiddenCount = selectedEntries.filter(({ key }) => !visibleKeys.has(key)).length;
    const guids = selectedEntries
      .map(({ definition }) => definition.guid)
      .filter((guid): guid is string => Boolean(guid));
    try {
      const preview = await this.prepareDeletionPreview(selectedEntries, guids);
      new BulkDeleteVariablesModal(
        this.plugin,
        selectedEntries.map(({ name }) => name),
        preview,
        hiddenCount,
        (replaceTokens) => void this.deleteVariables(
          selectedEntries,
          replaceTokens ? preview : null,
        ),
      ).open();
    } catch (error) {
      new Notice(
        `Variable Links: could not prepare deletion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prepareDeletionPreview(
    entries: readonly VariableEntry[],
    knownGuids?: readonly string[],
  ): Promise<DeletionPreview> {
    const guids = knownGuids ?? entries
      .map(({ definition }) => definition.guid)
      .filter((guid): guid is string => Boolean(guid));
    const impact = await this.plugin.tokenCache?.getGuidLocationImpact(guids)
      ?? { fileCount: 0, tokenCount: 0 };
    const replacements = new Map<string, TokenValueReplacement>();
    const unresolvedNames: string[] = [];
    for (const entry of entries) {
      const result = await this.plugin.resolver?.resolve(entry.name).catch(() => null);
      if (!result?.ok) {
        unresolvedNames.push(entry.name);
        continue;
      }
      replacements.set(entry.name, {
        value: formatResolvedValue(result.value),
        textCase: entry.definition.textCase,
      });
    }
    return { ...impact, replacements, unresolvedNames };
  }

  private async deleteVariables(
    entries: readonly VariableEntry[],
    replacementPreview: DeletionPreview | null,
  ): Promise<void> {
    const registry = this.plugin.registry;
    if (!registry) return;
    const deletedKeys = new Set(entries.map(({ key }) => key));
    const previousSelection = [...this.state.selected];
    this.state.selected = this.state.selected.filter((key) => !deletedKeys.has(key));
    let replacementPlan: TokenValueReplacementPlan | null = null;
    let count = 0;
    try {
      if (replacementPreview) {
        const tokenCache = this.plugin.tokenCache;
        if (!tokenCache) throw new Error('The token cache is unavailable.');
        replacementPlan = await tokenCache.prepareValueReplacement(replacementPreview.replacements);
        if (replacementPlan.tokenCount !== replacementPreview.tokenCount
          || replacementPlan.fileCount !== replacementPreview.fileCount) {
          throw new Error('Token locations changed after the confirmation opened. Review the deletion again.');
        }
        await replacementPlan.apply();
      }
      count = await registry.deleteVariables(entries.map(({ name }) => name));
    } catch (error) {
      let rollbackError: unknown = null;
      if (replacementPlan) {
        try {
          await replacementPlan.rollback();
        } catch (caught) {
          rollbackError = caught;
        }
      }
      this.state.selected = previousSelection;
      this.refresh();
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
      if (rollbackError) {
        new Notice(
          `Variable Links: ${getErrorMessage(rollbackError)}`,
        );
      }
      return;
    }
    if (replacementPlan) {
      try {
        await replacementPlan.commit();
      } catch (error) {
        new Notice(
          `Variable Links: values were inserted, but the token cache could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.saveViewState();
    new Notice(`Variable Links: deleted ${count} variable link${count === 1 ? '' : 's'}.`);
  }

  private saveViewState(): void {
    this.app.workspace.requestSaveLayout();
  }
}

class MassRenameVariablesModal extends Modal {
  private currentRenames: VariableRename[] = [];
  private currentProblemKeys = new Set<string>();
  private excludedKeys = new Set<string>();
  private find = '';
  private mode: MassRenameMode = 'prefix';
  private outputSeparator = '_';
  private pattern = '{filename}_##_text';
  private prefix = '';
  private preserveWhitespace = false;
  private replacement = '';
  private splitOnComma = false;
  private splitOnSpace = true;
  private splitOnUnderscore = false;
  private startNumber = 1;
  private suffix = '';
  private wordOrder = '2, 1';
  private wordSelection: RenameWordSelection = 'whole';

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly entries: readonly VariableEntry[],
    private readonly existingNames: ReadonlySet<string>,
    private readonly patternContexts: ReadonlyMap<string, NamePatternContext>,
    private readonly profilePatterns: ReadonlyMap<string, ProfilePatternRenameData>,
    private readonly onConfirm: (renames: readonly VariableRename[]) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-management-center-rename-modal');
    this.contentEl.createEl('h3', { text: 'Rename selected variable links' });
    this.contentEl.createEl('p', {
      text: 'Review every resulting name before applying the batch. If any name is invalid or occupied, nothing will be renamed.',
      cls: 'variable-links-hint-text',
    });

    const controls = this.contentEl.createDiv({ cls: 'variable-links-management-center-rename-controls' });
    const modeSetting = controls.createDiv({ cls: 'setting-item' });
    modeSetting.createDiv({ text: 'Rename mode', cls: 'setting-item-name' });
    const modeControl = modeSetting.createDiv({ cls: 'setting-item-control' });
    const mode = modeControl.createEl('select', { attr: { 'aria-label': 'Rename mode' } });
    mode.createEl('option', { text: 'Add prefix', value: 'prefix' });
    mode.createEl('option', { text: 'Add suffix', value: 'suffix' });
    mode.createEl('option', { text: 'Find and replace', value: 'replace' });
    mode.createEl('option', { text: 'Pattern', value: 'pattern' });
    mode.createEl('option', { text: 'Reapply autolink profile pattern', value: 'profile-pattern' });
    const wordSetting = controls.createDiv({ cls: 'setting-item' });
    const wordName = wordSetting.createDiv({ text: 'Word selection', cls: 'setting-item-name' });
    addContextHelpButton(
      wordName,
      this.plugin,
      'Mass rename word processing',
      (parent) => this.renderWordProcessingHelp(parent),
    );
    const wordControl = wordSetting.createDiv({ cls: 'setting-item-control' });
    const wordSelection = wordControl.createEl('select', { attr: { 'aria-label': 'Word selection' } });
    wordSelection.createEl('option', { text: 'Whole result', value: 'whole' });
    wordSelection.createEl('option', { text: 'First word', value: 'first' });
    wordSelection.createEl('option', { text: 'Last word', value: 'last' });
    wordSelection.createEl('option', { text: 'Custom order', value: 'custom' });
    const wordOptions = controls.createDiv({ cls: 'variable-links-management-center-word-options' });
    const fields = controls.createDiv();
    const previewStatus = this.contentEl.createDiv({
      cls: 'variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    const preview = this.contentEl.createDiv({ cls: 'variable-links-management-center-rename-preview' });
    const previewActions = this.contentEl.createDiv({
      cls: 'variable-links-management-center-rename-preview-actions',
    });
    const skipProblems = previewActions.createEl('button', {
      text: 'Skip problem rows',
      attr: { type: 'button' },
    });
    const includeAll = previewActions.createEl('button', {
      text: 'Include all',
      attr: { type: 'button' },
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    const apply = actions.createEl('button', {
      text: 'Rename variables',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    apply.addEventListener('click', () => {
      if (!this.currentRenames.length || apply.disabled) return;
      const renames = [...this.currentRenames];
      this.close();
      this.onConfirm(renames);
    });

    const renderPreview = (): void => this.renderPreview(
      preview,
      previewStatus,
      apply,
      skipProblems,
      includeAll,
    );
    skipProblems.addEventListener('click', () => {
      for (const key of this.currentProblemKeys) this.excludedKeys.add(key);
      renderPreview();
    });
    includeAll.addEventListener('click', () => {
      this.excludedKeys.clear();
      renderPreview();
    });
    const addTextField = (
      label: string,
      value: string,
      update: (next: string) => void,
      placeholder: string,
    ): HTMLInputElement => {
      const setting = fields.createDiv({ cls: 'setting-item' });
      setting.createDiv({ text: label, cls: 'setting-item-name' });
      const control = setting.createDiv({ cls: 'setting-item-control' });
      const input = control.createEl('input', { attr: { type: 'text', placeholder } });
      input.value = value;
      input.addEventListener('input', () => {
        update(input.value);
        renderPreview();
      });
      return input;
    };
    const renderFields = (): void => {
      fields.empty();
      if (this.mode === 'prefix') {
        addTextField('Prefix', this.prefix, (value) => { this.prefix = value; }, 'Text before each name');
      } else if (this.mode === 'suffix') {
        addTextField('Suffix', this.suffix, (value) => { this.suffix = value; }, 'Text after each name');
      } else if (this.mode === 'replace') {
        addTextField('Find', this.find, (value) => { this.find = value; }, 'Text to replace');
        addTextField('Replace with', this.replacement, (value) => { this.replacement = value; }, 'Replacement text');
      } else if (this.mode === 'pattern') {
        const patternSetting = fields.createDiv({ cls: 'setting-item' });
        const patternInfo = patternSetting.createDiv({ cls: 'setting-item-info' });
        const patternName = patternInfo.createDiv({
          cls: 'setting-item-name variable-links-management-center-pattern-name',
        });
        patternName.createSpan({ text: 'Pattern' });
        addContextHelpButton(
          patternName,
          this.plugin,
          'Naming pattern syntax',
          renderNamePatternHelp,
        );
        patternInfo.createDiv({
          text: 'Numbering follows the current list sort order, including selected rows hidden by filters.',
          cls: 'setting-item-description',
        });
        const patternControl = patternSetting.createDiv({ cls: 'setting-item-control' });
        const pattern = patternControl.createEl('input', {
          attr: { type: 'text', placeholder: '{filename}_##_text' },
        });
        pattern.value = this.pattern;
        pattern.addEventListener('input', () => {
          this.pattern = pattern.value;
          renderPreview();
        });

        const startSetting = fields.createDiv({ cls: 'setting-item' });
        startSetting.createDiv({ text: 'Starting number', cls: 'setting-item-name' });
        const startControl = startSetting.createDiv({ cls: 'setting-item-control' });
        const start = startControl.createEl('input', {
          attr: { type: 'number', min: '0', step: '1', 'aria-label': 'Starting number' },
        });
        start.value = String(this.startNumber);
        start.addEventListener('input', () => {
          const value = Number(start.value);
          this.startNumber = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1;
          renderPreview();
        });
      } else {
        fields.createEl('p', {
          text: 'Each managed variable link uses its own saved autolink profile pattern and its source note’s position in that profile’s complete scan order.',
          cls: 'variable-links-hint-text',
        });
      }
      renderPreview();
    };
    const updateModeVisibility = (): void => {
      const usesProfilePattern = this.mode === 'profile-pattern';
      wordSetting.hidden = usesProfilePattern;
      wordOptions.hidden = usesProfilePattern;
    };
    mode.addEventListener('change', () => {
      this.mode = readMassRenameMode(mode.value);
      updateModeVisibility();
      renderFields();
    });
    const renderWordOptions = (): void => {
      wordOptions.empty();
      const separatorSetting = wordOptions.createDiv({ cls: 'setting-item' });
      separatorSetting.createDiv({
        text: 'Split words on',
        cls: 'setting-item-name',
      });
      const separatorControl = separatorSetting.createDiv({
        cls: 'setting-item-control variable-links-management-center-word-separators',
      });
      const addSeparator = (
        label: string,
        checked: boolean,
        update: (next: boolean) => void,
      ): void => {
        const option = separatorControl.createEl('label');
        const checkbox = option.createEl('input', { attr: { type: 'checkbox' } });
        checkbox.checked = checked;
        option.createSpan({ text: label });
        checkbox.addEventListener('change', () => {
          update(checkbox.checked);
          renderPreview();
        });
      };
      addSeparator('Spaces', this.splitOnSpace, (value) => { this.splitOnSpace = value; });
      addSeparator('Commas', this.splitOnComma, (value) => { this.splitOnComma = value; });
      addSeparator('Underscores', this.splitOnUnderscore, (value) => { this.splitOnUnderscore = value; });

      if (this.wordSelection === 'custom') {
        const orderSetting = wordOptions.createDiv({ cls: 'setting-item' });
        const orderInfo = orderSetting.createDiv({ cls: 'setting-item-info' });
        orderInfo.createDiv({ text: 'Word order', cls: 'setting-item-name' });
        orderInfo.createDiv({
          text: 'Use 1-based comma-separated positions, such as 2, 1.',
          cls: 'setting-item-description',
        });
        const orderControl = orderSetting.createDiv({ cls: 'setting-item-control' });
        const order = orderControl.createEl('input', {
          attr: { type: 'text', placeholder: '2, 1', 'aria-label': 'Word order' },
        });
        order.value = this.wordOrder;
        order.addEventListener('input', () => {
          this.wordOrder = order.value;
          renderPreview();
        });
      }

      const outputSetting = wordOptions.createDiv({ cls: 'setting-item' });
      const outputInfo = outputSetting.createDiv({ cls: 'setting-item-info' });
      outputInfo.createDiv({ text: 'Output separator', cls: 'setting-item-name' });
      outputInfo.createDiv({
        text: 'An underscore is used by default. Leave blank to join or remove without a separator.',
        cls: 'setting-item-description',
      });
      const outputControl = outputSetting.createDiv({ cls: 'setting-item-control' });
      const output = outputControl.createEl('input', {
        attr: { type: 'text', 'aria-label': 'Output separator' },
      });
      output.value = this.outputSeparator;
      output.addEventListener('input', () => {
        this.outputSeparator = output.value;
        renderPreview();
      });

      const preserveSetting = wordOptions.createDiv({ cls: 'setting-item' });
      const preserveLabel = preserveSetting.createEl('label', {
        cls: 'variable-links-management-center-preserve-whitespace',
      });
      const preserve = preserveLabel.createEl('input', { attr: { type: 'checkbox' } });
      preserve.checked = this.preserveWhitespace;
      preserveLabel.createSpan({ text: 'Leave whitespace unchanged' });
      preserve.addEventListener('change', () => {
        this.preserveWhitespace = preserve.checked;
        renderPreview();
      });
    };
    wordSelection.addEventListener('change', () => {
      this.wordSelection = readRenameWordSelection(wordSelection.value);
      renderWordOptions();
      renderPreview();
    });
    renderWordOptions();
    updateModeVisibility();
    renderFields();
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }

  private renderPreview(
    parent: HTMLElement,
    status: HTMLElement,
    apply: HTMLButtonElement,
    skipProblems: HTMLButtonElement,
    includeAll: HTMLButtonElement,
  ): void {
    const scrollTop = parent.scrollTop;
    parent.empty();
    let includedIndex = 0;
    const rows = this.entries.map((entry) => {
      const included = !this.excludedKeys.has(entry.key);
      const result = included
        ? this.getNewName(entry, includedIndex++)
        : { value: '', errors: [] };
      const processed = included
        ? this.mode === 'profile-pattern'
          ? { value: result.value.trim().replace(/\s+/gu, '_'), errors: [] }
          : this.processResultWords(result.value)
        : { value: '', errors: [] };
      return {
        entry,
        included,
        newName: processed.value,
        issue: [...result.errors, ...processed.errors].join(' '),
      };
    });
    const findMissing = this.mode === 'replace' && !this.find;
    const tokenSyntax = getTokenSyntax(this.plugin.settings);
    for (const row of rows) {
      if (!row.included) continue;
      if (row.issue) continue;
      if (findMissing) row.issue = 'Enter text to find';
      else if (!row.entry.definition.guid) row.issue = 'Missing stable identifier';
      else if (!row.newName) row.issue = 'Name cannot be empty';
      else if (row.newName.includes(tokenSyntax.prefix) || row.newName.includes(tokenSyntax.suffix)) {
        row.issue = 'Contains the active token delimiter';
      } else if (parseVariableTextCaseMarker(row.newName)) {
        row.issue = 'Resembles reserved text-case syntax';
      }
    }
    const nameCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.included && !row.issue) {
        nameCounts.set(row.newName, (nameCounts.get(row.newName) ?? 0) + 1);
      }
    }
    for (const row of rows) {
      if (row.included && !row.issue && (nameCounts.get(row.newName) ?? 0) > 1) {
        row.issue = 'Duplicates another resulting name';
      }
    }
    let addedCollision = false;
    do {
      addedCollision = false;
      const changingOldNames = new Set(
        rows.filter(({ entry, included, issue, newName }) =>
          included && !issue && newName !== entry.name
        ).map(({ entry }) => entry.name),
      );
      for (const row of rows) {
        if (!row.included || row.issue || row.newName === row.entry.name) continue;
        if (this.existingNames.has(row.newName) && !changingOldNames.has(row.newName)) {
          row.issue = 'Already exists';
          addedCollision = true;
        }
      }
    } while (addedCollision);

    const includedRows = rows.filter(({ included }) => included);
    const changed = includedRows.filter(({ entry, issue, newName }) => !issue && newName !== entry.name);
    const issues = includedRows.filter(({ issue }) => issue).length;
    this.currentProblemKeys = new Set(
      includedRows.filter(({ issue }) => issue).map(({ entry }) => entry.key),
    );
    this.currentRenames = changed.map(({ entry, newName }) => ({
          guid: entry.definition.guid ?? '',
          oldName: entry.name,
          newName,
        }));
    apply.disabled = issues > 0 || !this.currentRenames.length;
    apply.setText(`Rename included (${changed.length})`);
    skipProblems.disabled = this.currentProblemKeys.size === 0;
    includeAll.disabled = this.excludedKeys.size === 0;
    const skipped = rows.length - includedRows.length;
    if (!includedRows.length) status.setText(`No rows are included. ${skipped} skipped.`);
    else if (issues) {
      status.setText(
        `${issues} included problem${issues === 1 ? '' : 's'} must be resolved or skipped. ${skipped} skipped.`,
      );
    } else {
      status.setText(
        `${changed.length} of ${includedRows.length} included variable link${includedRows.length === 1 ? '' : 's'} will be renamed. ${skipped} skipped.`,
      );
    }

    const header = parent.createDiv({ cls: 'variable-links-management-center-rename-row is-header' });
    header.createSpan({ text: 'Include' });
    header.createSpan({ text: 'Current name' });
    header.createSpan({ text: 'New name' });
    header.createSpan({ text: 'Status' });
    for (const row of rows) {
      const item = parent.createDiv({ cls: 'variable-links-management-center-rename-row' });
      const include = item.createEl('input', {
        attr: { type: 'checkbox', 'aria-label': `Include ${row.entry.name}` },
      });
      include.checked = row.included;
      include.addEventListener('change', () => {
        if (include.checked) this.excludedKeys.delete(row.entry.key);
        else this.excludedKeys.add(row.entry.key);
        this.renderPreview(parent, status, apply, skipProblems, includeAll);
      });
      item.createSpan({ text: row.entry.name, attr: { title: row.entry.name } });
      item.createSpan({
        text: row.included ? row.newName || '—' : '—',
        attr: { title: row.included ? row.newName : '' },
      });
      item.createSpan({
        text: row.included
          ? row.issue || (row.newName === row.entry.name ? 'No change' : 'Ready')
          : 'Skipped',
        cls: row.included && row.issue ? 'is-error' : 'variable-links-hint-text',
        attr: { title: row.issue },
      });
    }
    parent.scrollTop = scrollTop;
  }

  private processResultWords(value: string): { errors: string[]; value: string } {
    const trimmed = value.trim();
    const separators: string[] = [];
    if (this.splitOnSpace && !this.preserveWhitespace) separators.push('\\s');
    if (this.splitOnComma) separators.push(',');
    if (this.splitOnUnderscore) separators.push('_');
    const words = separators.length
      ? trimmed.split(new RegExp(`[${separators.join('')}]+`, 'u')).filter(Boolean)
      : trimmed ? [trimmed] : [];
    let selectedWords = words;
    if (this.wordSelection === 'first') selectedWords = words.slice(0, 1);
    else if (this.wordSelection === 'last') selectedWords = words.slice(-1);
    else if (this.wordSelection === 'custom') {
      const positions = this.wordOrder.split(',').map((position) => position.trim());
      if (!positions.length || positions.some((position) => !/^\d+$/u.test(position))) {
        return {
          value: '',
          errors: ['Enter valid 1-based word positions separated by commas.'],
        };
      }
      const indexes = positions.map(Number);
      if (indexes.some((index) => index < 1)) {
        return {
          value: '',
          errors: ['Word positions must start at 1.'],
        };
      }
      const unavailable = indexes.find((index) => index > words.length);
      if (unavailable !== undefined) {
        return {
          value: '',
          errors: [`Word position ${unavailable} is unavailable; this result has ${words.length} word${words.length === 1 ? '' : 's'}.`],
        };
      }
      selectedWords = indexes.map((index) => words[index - 1] ?? '');
    }
    return { value: selectedWords.join(this.outputSeparator).trim(), errors: [] };
  }

  private renderWordProcessingHelp(parent: HTMLElement): void {
    parent.createEl('p', {
      text: 'Word processing runs after the selected rename mode or naming pattern creates each proposed name.',
    });
    const details = parent.createEl('ul');
    details.createEl('li', {
      text: 'Whole result keeps every detected word; First word and last word keep one; Custom order uses 1-based positions such as 2, 1.',
    });
    details.createEl('li', {
      text: 'The split checkboxes choose which spaces, commas, or underscores count as word boundaries.',
    });
    details.createEl('li', {
      text: 'Output separator is inserted between retained words. Leave it blank to join them directly.',
    });
    details.createEl('li', {
      text: 'Leave whitespace unchanged prevents spaces from acting as word boundaries; selected comma or underscore boundaries still apply.',
    });
    details.createEl('li', {
      text: 'Repeated custom order positions are allowed. Invalid or unavailable positions appear as row problems before anything is renamed.',
    });
  }

  private getNewName(entry: VariableEntry, index: number): { errors: string[]; value: string } {
    if (this.mode === 'prefix') return { value: `${this.prefix}${entry.name}`, errors: [] };
    if (this.mode === 'suffix') return { value: `${entry.name}${this.suffix}`, errors: [] };
    if (this.mode === 'replace') {
      return {
        value: this.find ? entry.name.split(this.find).join(this.replacement) : entry.name,
        errors: [],
      };
    }
    if (this.mode === 'profile-pattern') {
      const profilePattern = this.profilePatterns.get(entry.key);
      if (!profilePattern) return { value: '', errors: ['Autolink profile pattern data is unavailable'] };
      if (profilePattern.error) return { value: '', errors: [profilePattern.error] };
      if (profilePattern.fixedName) return { value: profilePattern.fixedName, errors: [] };
      return renderNamePattern(
        profilePattern.pattern,
        profilePattern.context,
        profilePattern.counter,
      );
    }
    if (!this.pattern.trim()) return { value: '', errors: ['Enter a pattern'] };
    return renderNamePattern(
      this.pattern,
      this.patternContexts.get(entry.key) ?? { variable: entry.name },
      this.startNumber + index,
    );
  }
}

class DeleteManagedVariableModal extends Modal {
  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly variableName: string,
    private readonly preview: DeletionPreview,
    private readonly onConfirm: (replaceTokens: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: 'Delete variable link?' });
    this.contentEl.createEl('p', {
      text: `Delete “${this.variableName}”?`,
    });
    const replacement = addReplacementControl(this.contentEl, this.preview);
    const impact = this.contentEl.createEl('p');
    const updateImpact = (): void => setDeletionImpactText(impact, this.preview, replacement.checked);
    replacement.addEventListener('change', updateImpact);
    updateImpact();
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    actions.createEl('button', {
      text: 'Delete',
      cls: 'mod-warning',
      attr: { type: 'button' },
    }).addEventListener('click', () => {
      this.close();
      this.onConfirm(replacement.checked);
    });
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }
}

class BulkDeleteVariablesModal extends Modal {
  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly variableNames: readonly string[],
    private readonly preview: DeletionPreview,
    private readonly hiddenCount: number,
    private readonly onConfirm: (replaceTokens: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    const count = this.variableNames.length;
    this.contentEl.createEl('h3', { text: 'Delete selected variable links?' });
    this.contentEl.createEl('p', {
      text: `Delete ${count} selected variable link${count === 1 ? '' : 's'}?${this.hiddenCount
        ? ` This includes ${this.hiddenCount} selection${this.hiddenCount === 1 ? '' : 's'} hidden by the current filters.`
        : ''}`,
    });
    const replacement = addReplacementControl(this.contentEl, this.preview);
    const impact = this.contentEl.createEl('p');
    const updateImpact = (): void => setDeletionImpactText(impact, this.preview, replacement.checked);
    replacement.addEventListener('change', updateImpact);
    updateImpact();
    const details = this.contentEl.createEl('details');
    details.createEl('summary', { text: 'Review selected names' });
    const names = details.createEl('ul');
    for (const name of this.variableNames.slice(0, 100)) names.createEl('li', { text: name });
    if (count > 100) names.createEl('li', { text: `…and ${count - 100} more` });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    actions.createEl('button', {
      text: 'Delete selected',
      cls: 'mod-warning',
      attr: { type: 'button' },
    }).addEventListener('click', () => {
      this.close();
      this.onConfirm(replacement.checked);
    });
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }
}

function addReplacementControl(parent: HTMLElement, preview: DeletionPreview): HTMLInputElement {
  const option = parent.createDiv({ cls: 'variable-links-management-center-delete-option' });
  const label = option.createEl('label');
  const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
  label.createSpan({ text: 'Replace active tokens with their current values before deleting' });
  const hint = option.createEl('p', { cls: 'variable-links-hint-text' });
  if (preview.unresolvedNames.length) {
    checkbox.disabled = true;
    const names = preview.unresolvedNames.slice(0, 5).join(', ');
    const remaining = preview.unresolvedNames.length - Math.min(preview.unresolvedNames.length, 5);
    hint.setText(
      `Replacement is unavailable because ${names}${remaining ? ` and ${remaining} more` : ''} cannot currently be resolved.`,
    );
  } else if (!preview.tokenCount) {
    checkbox.disabled = true;
    hint.setText('No active tokens were found to replace.');
  } else {
    hint.setText('Values are inserted as text without variable links appearance, cards, or hyperlinks.');
  }
  return checkbox;
}

function setDeletionImpactText(
  target: HTMLElement,
  preview: DeletionPreview,
  replaceTokens: boolean,
): void {
  if (replaceTokens) {
    target.setText(
      `${preview.tokenCount} active token${preview.tokenCount === 1 ? '' : 's'} in ${preview.fileCount} note${preview.fileCount === 1 ? '' : 's'} will be replaced with current values. They will no longer update dynamically.`,
    );
    return;
  }
  target.setText(
    `${preview.tokenCount} cached token${preview.tokenCount === 1 ? '' : 's'} will become unresolved. Note text will not be changed.`,
  );
}

function readState(state: unknown): ManagementCenterState {
  const record = typeof state === 'object' && state !== null && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return {
    activity: 'variables',
    query: typeof record.query === 'string' ? record.query : '',
    ownership: readOwnershipFilter(record.ownership),
    profileId: typeof record.profileId === 'string' && record.profileId ? record.profileId : 'all',
    variableType: readVariableTypeFilter(record.variableType),
    sort: readVariableSort(record.sort),
    page: typeof record.page === 'number' && Number.isInteger(record.page) && record.page > 0
      ? record.page
      : 1,
    pageSize: readManagementPageSize(record.pageSize),
    selected: Array.isArray(record.selected)
      ? record.selected.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function readOwnershipFilter(value: unknown): OwnershipFilter {
  return value === 'manual' || value === 'managed' ? value : 'all';
}

function readMassRenameMode(value: unknown): MassRenameMode {
  return value === 'suffix' || value === 'replace' || value === 'pattern'
    || value === 'profile-pattern' ? value : 'prefix';
}

function readRenameWordSelection(value: unknown): RenameWordSelection {
  return value === 'first' || value === 'last' || value === 'custom' ? value : 'whole';
}

function readVariableTypeFilter(value: unknown): VariableTypeFilter {
  return value === 'property' || value === 'fixed' ? value : 'all';
}

function readVariableSort(value: unknown): VariableSort {
  return value === 'name-descending' || value === 'type' || value === 'source'
    || value === 'property' || value === 'profile'
    ? value
    : 'name-ascending';
}

function readManagementPageSize(value: unknown): ManagementPageSize {
  if (value === 'all') return 'all';
  if (value === 20 || value === '20') return 20;
  if (value === 50 || value === '50') return 50;
  if (value === 100 || value === '100') return 100;
  if (value === 250 || value === '250') return 250;
  return 50;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

function formatResolvedValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === undefined || value === null) return '';
  if (typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The note changes could not be restored.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
