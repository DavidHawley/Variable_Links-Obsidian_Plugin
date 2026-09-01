import { App, Modal, Notice, TFile } from 'obsidian';
import type VariableLinksPlugin from './main';
import type Registry from './registry';
import {
  DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES,
  normalizeVaultPath,
  normalizeAutolinkProfiles,
  profileMatchesPath,
  type AutolinkCardPreset,
  type AutolinkProfile,
} from './autolink';
import { toFileLink } from './linkSyntax';
import { createAutolinkCardSnapshot } from './cardPresets';
import { getTokenSyntax } from './tokenSyntax';
import { parseVariableTextCaseMarker } from './textCase';
import { renderNamePattern } from './namePattern';

interface AutolinkPreviewItem {
  file: TFile;
  profile: AutolinkProfile;
  name: string;
  valueProperty: string;
  cardPreset: AutolinkCardPreset;
  cardProperties: string[];
  overrideSummary: string;
  warnings: string[];
  existingNameCollision: boolean;
  managedUpdateCandidate: boolean;
  precedenceNote: string;
}

export type AutolinkPreviewScope =
  | { type: 'all' }
  | { type: 'file'; path: string }
  | { type: 'folder'; path: string };

export function openAutolinkProfilePreview(
  app: App,
  plugin: VariableLinksPlugin,
  registry: Registry,
  profile: AutolinkProfile,
): void {
  new AutolinkPreviewModal(app, plugin, registry, profile).open();
}

export function openCombinedAutolinkPreview(
  app: App,
  plugin: VariableLinksPlugin,
  registry: Registry,
  scope: AutolinkPreviewScope,
): void {
  new CombinedAutolinkPreviewModal(app, plugin, registry, scope).open();
}

class CombinedAutolinkPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: VariableLinksPlugin,
    private readonly registry: Registry,
    private readonly previewScope: AutolinkPreviewScope,
  ) {
    super(app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-autolink-combined-preview-modal');
    this.contentEl.createEl('h3', { text: getCombinedPreviewTitle(this.previewScope) });
    const profiles = this.registry.autolinkProfiles.filter(({ enabled }) => enabled);
    const scopedFiles = getScopedFiles(this.app, this.previewScope);
    const scopedPaths = new Set(scopedFiles.map(({ path }) => normalizeVaultPath(path).toLocaleLowerCase()));
    const items = profiles.flatMap((profile) => buildAutolinkItems(
      this.app,
      this.plugin,
      this.registry,
      profile,
      scopedPaths,
    ));
    applyCrossProfilePrecedence(items, profiles);
    const unmatched = scopedFiles.filter((file) => !profiles.some((profile) =>
      profileMatchesPath(profile, file.path)
    ));
    const outOfScope = getOutOfScopeManagedEntries(this.app, this.registry, profiles);

    this.contentEl.createEl('p', {
      text: profiles.length
        ? `${items.length} generated candidate${items.length === 1 ? '' : 's'} from ${profiles.length} enabled profile${profiles.length === 1 ? '' : 's'}. This combined preview is read-only.`
        : 'There are no enabled Autolink profiles. This combined preview is read-only.',
    });
    this.contentEl.createEl('p', {
      text: 'When profiles overlap, exact-file profiles are listed first, followed by the closest folder and then broader folders. Different generated names remain separate candidates.',
      cls: 'variable-links-hint-text',
    });
    if (items.length) this.renderItems(items);
    else this.contentEl.createEl('p', {
      text: scopedFiles.length ? 'No enabled profile matches the selected scope.' : 'The selected scope contains no Markdown files.',
      cls: 'mod-muted',
    });
    this.renderPathDetails('Notes without a matching enabled profile', unmatched.map(({ path }) => path));
    this.renderPathDetails(
      'Managed links outside their profile scope',
      outOfScope.map(({ name, path }) => `${name} — ${path}`),
    );
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Close', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }

  private renderItems(items: readonly AutolinkPreviewItem[]): void {
    const table = this.contentEl.createEl('table', { cls: 'variable-links-autolink-preview-table' });
    const header = table.createEl('thead').createEl('tr');
    for (const label of ['Note', 'Profile', 'Variable name', 'Value property', 'Card', 'Overrides', 'Status']) {
      header.createEl('th', { text: label });
    }
    const body = table.createEl('tbody');
    for (const item of items) {
      const row = body.createEl('tr');
      row.createEl('td', { text: item.file.path });
      row.createEl('td', { text: item.profile.name });
      row.createEl('td', { text: item.name });
      row.createEl('td', { text: item.valueProperty || 'Missing' });
      row.createEl('td', { text: formatCardSummary(item) });
      row.createEl('td', { text: item.overrideSummary });
      const status = [...item.warnings];
      if (item.precedenceNote) status.push(item.precedenceNote);
      row.createEl('td', {
        text: status.length ? status.join(' ') : 'Ready',
        cls: item.warnings.length ? 'mod-warning' : '',
      });
    }
  }

  private renderPathDetails(title: string, paths: readonly string[]): void {
    if (!paths.length) return;
    const details = this.contentEl.createEl('details', { cls: 'variable-links-autolink-preview-details' });
    details.createEl('summary', { text: `${title} (${paths.length})` });
    const list = details.createEl('ul');
    for (const path of paths) list.createEl('li', { text: path });
  }
}

class AutolinkPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: VariableLinksPlugin,
    private readonly registry: Registry,
    private readonly profile: AutolinkProfile,
  ) {
    super(app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: `Autolink preview: ${this.profile.name}` });
    const items = this.buildItems();
    const safeItems = items.filter(isSafeAddition);
    const allApplicableItems = items.filter(isApplicableWithOverwrite);
    const overwriteCount = allApplicableItems.filter((item) => item.existingNameCollision).length;
    const savedProfile = this.registry.autolinkProfiles.find(({ id }) => id === this.profile.id);
    const profileIsSaved = savedProfile !== undefined && profilesEqual(savedProfile, this.profile);
    const canApply = this.profile.enabled && profileIsSaved && safeItems.length > 0;
    this.contentEl.createEl('p', {
      text: items.length
        ? `${items.length} matching note${items.length === 1 ? '' : 's'}; ${safeItems.length} safe addition${safeItems.length === 1 ? '' : 's'} and ${overwriteCount} overwrite candidate${overwriteCount === 1 ? '' : 's'}. Nothing changes until you confirm an action.`
        : 'No matching notes. Preview only; no Variable Links will be changed.',
    });
    if (!this.profile.enabled) {
      this.contentEl.createEl('p', {
        text: 'Enable and save this profile before applying additions.',
        cls: 'variable-links-hint-text',
      });
    } else if (!profileIsSaved) {
      this.contentEl.createEl('p', {
        text: 'Save this profile before applying additions. The preview may still show unsaved settings.',
        cls: 'variable-links-hint-text',
      });
    } else if (safeItems.length) {
      this.contentEl.createEl('p', {
        text: 'New additions receive the previewed built-in card as a snapshot. Existing links, warnings, updates, and removals remain unchanged.',
        cls: 'variable-links-hint-text',
      });
    }
    if (items.length) {
      const table = this.contentEl.createEl('table', { cls: 'variable-links-autolink-preview-table' });
      const header = table.createEl('thead').createEl('tr');
      for (const label of ['Note', 'Variable name', 'Value property', 'Card', 'Overrides', 'Status']) {
        header.createEl('th', { text: label });
      }
      const body = table.createEl('tbody');
      for (const item of items) {
        const row = body.createEl('tr');
        row.createEl('td', { text: item.file.path });
        row.createEl('td', { text: item.name });
        row.createEl('td', { text: item.valueProperty || 'Missing' });
        row.createEl('td', { text: formatCardSummary(item) });
        row.createEl('td', { text: item.overrideSummary });
        row.createEl('td', {
          text: item.warnings.length ? item.warnings.join(' ') : 'Ready',
          cls: item.warnings.length ? 'mod-warning' : '',
        });
      }
    }
    const actions = this.contentEl.createDiv({ cls: 'variable-links-autolink-preview-actions' });
    const overwriteLabel = actions.createEl('label', {
      cls: 'variable-links-autolink-overwrite-control',
    });
    const allowOverwrite = overwriteLabel.createEl('input', { type: 'checkbox' });
    overwriteLabel.createSpan({
      text: 'Allow to overwrite existing Variable Links with the same name.',
      cls: 'variable-links-hint-text',
    });
    const buttons = actions.createDiv({ cls: 'variable-links-autolink-preview-buttons' });
    const applyAll = buttons.createEl('button', {
      text: 'Apply all',
      cls: 'mod-warning',
      attr: { type: 'button' },
    });
    const applySafe = buttons.createEl('button', {
      text: 'Apply safe additions',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    applyAll.disabled = true;
    applySafe.disabled = !canApply;
    allowOverwrite.addEventListener('change', () => {
      applyAll.disabled = !allowOverwrite.checked
        || !this.profile.enabled
        || !profileIsSaved
        || allApplicableItems.length === 0;
    });
    applyAll.addEventListener('click', () => {
      if (!allowOverwrite.checked) return;
      new ConfirmAutolinkAdditionsModal(
        this.app,
        this.plugin,
        this.registry,
        this.profile,
        allApplicableItems,
        () => this.buildItems().filter(isApplicableWithOverwrite),
        true,
        () => this.close(),
      ).open();
    });
    applySafe.addEventListener('click', () => {
      new ConfirmAutolinkAdditionsModal(
        this.app,
        this.plugin,
        this.registry,
        this.profile,
        safeItems,
        () => this.buildItems().filter(isSafeAddition),
        false,
        () => this.close(),
      ).open();
    });
    buttons.createEl('button', { text: 'Close', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }

  private buildItems(): AutolinkPreviewItem[] {
    return buildAutolinkItems(this.app, this.plugin, this.registry, this.profile);
  }
}

class ConfirmAutolinkAdditionsModal extends Modal {
  private applying = false;

  constructor(
    app: App,
    private readonly plugin: VariableLinksPlugin,
    private readonly registry: Registry,
    private readonly profile: AutolinkProfile,
    private readonly items: readonly AutolinkPreviewItem[],
    private readonly rebuildSafeItems: () => AutolinkPreviewItem[],
    private readonly allowOverwrite: boolean,
    private readonly onApplied: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', {
      text: this.allowOverwrite ? 'Apply all autolink changes?' : 'Apply safe autolink additions?',
    });
    const overwriteCount = this.items.filter((item) => item.existingNameCollision).length;
    const additionCount = this.items.length - overwriteCount;
    this.contentEl.createEl('p', {
      text: this.allowOverwrite
        ? `Add ${additionCount} and overwrite ${overwriteCount} property-backed Variable Link${this.items.length === 1 ? '' : 's'} from “${this.profile.name}”?`
        : `Add ${additionCount} property-backed Variable Link${additionCount === 1 ? '' : 's'} from “${this.profile.name}”?`,
    });
    if (overwriteCount) {
      this.contentEl.createEl('p', {
        text: 'Overwritten variable links keep their GUID, but their mapping, card, appearance, favorite, and other definition settings are replaced by the generated profile result.',
        cls: 'mod-warning',
      });
    }
    const cardCount = this.items.filter(({ cardPreset }) => cardPreset !== 'none').length;
    if (cardCount) {
      this.contentEl.createEl('p', {
        text: `${cardCount} applied result${cardCount === 1 ? '' : 's'} will include a new built-in Card snapshot using the listed properties.`,
      });
    }
    this.contentEl.createEl('p', {
      text: this.allowOverwrite
        ? 'Other warnings remain excluded. The entire batch is cancelled if the preview is no longer current.'
        : 'This adds new registry entries only. If any name is no longer available, the entire batch is cancelled without changing the registry.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    const apply = actions.createEl('button', {
      text: this.allowOverwrite ? 'Apply all' : 'Apply additions',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    cancel.addEventListener('click', () => this.close());
    apply.addEventListener('click', () => {
      if (this.applying) return;
      this.applying = true;
      cancel.disabled = true;
      apply.disabled = true;
      apply.textContent = 'Applying…';
      void this.apply().catch((error: unknown) => {
        this.applying = false;
        cancel.disabled = false;
        apply.disabled = false;
        apply.textContent = this.allowOverwrite ? 'Apply all' : 'Apply additions';
        new Notice(`Variable Links: could not apply Autolink additions: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }

  private async apply(): Promise<void> {
    const currentProfile = this.registry.autolinkProfiles.find(({ id }) => id === this.profile.id);
    if (!currentProfile || !currentProfile.enabled || !profilesEqual(currentProfile, this.profile)) {
      throw new Error('the saved profile changed after the preview. Preview it again.');
    }
    const currentItems = this.rebuildSafeItems();
    if (!previewItemsEqual(this.items, currentItems)) {
      throw new Error('the matching notes changed after the preview. Preview them again.');
    }
    const result = await this.registry.applyManagedAutolinkVariables(currentItems.map((item) => ({
      name: item.name,
      definition: {
        type: 'property',
        file: toFileLink(item.file.path),
        property: item.valueProperty,
        card: createAutolinkCardSnapshot(item.name, item.cardPreset, item.cardProperties),
        managed: {
          profileId: this.profile.id,
          sourcePath: item.file.path,
          managedFields: ['file', 'property'],
        },
      },
    })), this.allowOverwrite);
    new Notice(`Variable Links: added ${result.added} and overwritten ${result.overwritten} Autolink Variable Link${result.added + result.overwritten === 1 ? '' : 's'}.`);
    this.close();
    this.onApplied();
  }
}

function profilesEqual(left: AutolinkProfile, right: AutolinkProfile): boolean {
  const normalizedLeft = normalizeAutolinkProfiles([left])[0];
  const normalizedRight = normalizeAutolinkProfiles([right])[0];
  return normalizedLeft !== undefined
    && normalizedRight !== undefined
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function previewItemsEqual(
  left: readonly AutolinkPreviewItem[],
  right: readonly AutolinkPreviewItem[],
): boolean {
  const summarize = (item: AutolinkPreviewItem): string => JSON.stringify({
    path: item.file.path,
    name: item.name,
    valueProperty: item.valueProperty,
    cardPreset: item.cardPreset,
    cardProperties: item.cardProperties,
    existingNameCollision: item.existingNameCollision,
  });
  return left.length === right.length
    && left.every((item, index) => summarize(item) === summarize(right[index]));
}

function isSafeAddition(item: AutolinkPreviewItem): boolean {
  return item.warnings.length === 0;
}

function isApplicableWithOverwrite(item: AutolinkPreviewItem): boolean {
  return item.warnings.length === (item.existingNameCollision ? 1 : 0);
}

function buildAutolinkItems(
  app: App,
  plugin: VariableLinksPlugin,
  registry: Registry,
  profile: AutolinkProfile,
  includedPaths?: ReadonlySet<string>,
): AutolinkPreviewItem[] {
  const allItems = app.vault.getMarkdownFiles()
    .filter((file) => profileMatchesPath(profile, file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file, index) => buildAutolinkItem(app, profile, file, index + 1));
  const names = new Map<string, number>();
  for (const item of allItems) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  const tokenSyntax = getTokenSyntax(plugin.settings);
  for (const item of allItems) {
    if (!item.name) item.warnings.push('A Variable Link name could not be determined.');
    else {
      if ((names.get(item.name) ?? 0) > 1) item.warnings.push('Name collides with another matched note.');
      if (item.name.includes(tokenSyntax.prefix) || item.name.includes(tokenSyntax.suffix)) {
        item.warnings.push('Name contains the active token prefix or suffix.');
      }
      if (/\s/.test(item.name)) {
        item.warnings.push('Name contains whitespace. Use underscores so its token can be recognized.');
      }
      if (parseVariableTextCaseMarker(item.name)) {
        item.warnings.push('Name resembles token text-case syntax and must be created manually.');
      }
    }
    const existing = item.name ? registry.getVariable(item.name) : null;
    if (existing) {
      item.existingNameCollision = true;
      item.managedUpdateCandidate = existing.managed?.profileId === profile.id
        && sameVaultPath(existing.managed.sourcePath, item.file.path);
      item.warnings.push(item.managedUpdateCandidate
        ? 'Existing managed Variable Link is an update candidate.'
        : 'Name already belongs to an existing Variable Link.');
    }
  }
  const scopedItems = includedPaths
    ? allItems.filter(({ file }) => includedPaths.has(normalizeVaultPath(file.path).toLocaleLowerCase()))
    : allItems;
  return scopedItems.sort((left, right) => left.file.path.localeCompare(right.file.path));
}

function buildAutolinkItem(
  app: App,
  profile: AutolinkProfile,
  file: TFile,
  counter: number,
): AutolinkPreviewItem {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const metadata = isRecord(frontmatter) ? frontmatter : {};
  const warnings: string[] = [];
  const overrideProperties = profile.customOverridePropertyNames
    ? profile.overrideProperties
    : DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES;
  const overrideEntries: Array<{ label: string; property: string }> = [
    { label: 'name', property: overrideProperties.name },
    { label: 'value property', property: overrideProperties.valueProperty },
    { label: 'template', property: overrideProperties.template },
    { label: 'Card properties', property: overrideProperties.cardProperties },
  ];
  const presentOverrides = overrideEntries.filter(({ property }) =>
    Object.prototype.hasOwnProperty.call(metadata, property)
  );
  const allowOverrides = profile.allowOverrides;
  const explicitName = allowOverrides
    ? readString(metadata[overrideProperties.name], overrideProperties.name, warnings)
    : '';
  const explicitValueProperty = readString(
    allowOverrides ? metadata[overrideProperties.valueProperty] : undefined,
    overrideProperties.valueProperty,
    warnings,
  );
  const template = readString(
    allowOverrides ? metadata[overrideProperties.template] : undefined,
    overrideProperties.template,
    warnings,
  );
  if (allowOverrides
    && overrideProperties.template === DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.template
    && Object.prototype.hasOwnProperty.call(metadata, 'variablelink_templete')) {
    warnings.push('Use variablelink_template instead of variablelink_templete.');
  }
  const cardPreset = normalizePreset(template, profile.cardPreset, warnings);
  const cardProperties = readStringList(
    allowOverrides ? metadata[overrideProperties.cardProperties] : undefined,
    profile.cardProperties,
    warnings,
  );
  const valueProperty = explicitValueProperty || profile.valueProperty;
  let name = explicitName;
  if (!name) {
    const rendered = renderNamePattern(
      profile.namePattern || '{filename}',
      {
        filename: file.basename,
        folder: file.parent?.name || undefined,
        path: file.path.replace(/\.md$/i, ''),
        profile: profile.name,
        properties: metadata,
        property: valueProperty || undefined,
        value: valueProperty ? metadata[valueProperty] : undefined,
      },
      counter,
    );
    warnings.push(...rendered.errors);
    name = rendered.value.trim().replace(/\s+/g, '_');
  }
  if (!valueProperty) warnings.push('No value property is configured.');
  else if (!Object.prototype.hasOwnProperty.call(metadata, valueProperty)) {
    warnings.push(`Missing value property “${valueProperty}”.`);
  }
  for (const property of cardProperties) {
    if (!Object.prototype.hasOwnProperty.call(metadata, property)) {
      warnings.push(`Missing Card property “${property}”.`);
    }
  }
  const overrideSummary = allowOverrides
    ? presentOverrides.length
      ? `Applied: ${presentOverrides.map(({ label }) => label).join(', ')}`
      : 'Allowed; none present'
    : presentOverrides.length
      ? `Ignored: ${presentOverrides.map(({ label }) => label).join(', ')}`
      : 'Disabled';
  return {
    file,
    profile,
    name,
    valueProperty,
    cardPreset,
    cardProperties,
    overrideSummary,
    warnings,
    existingNameCollision: false,
    managedUpdateCandidate: false,
    precedenceNote: '',
  };
}

function applyCrossProfilePrecedence(
  items: AutolinkPreviewItem[],
  profiles: readonly AutolinkProfile[],
): void {
  const profileOrder = new Map(profiles.map((profile, index) => [profile.id, index]));
  items.sort((left, right) => left.file.path.localeCompare(right.file.path)
    || compareProfilePrecedence(left.profile, right.profile, profileOrder));
  const byName = new Map<string, AutolinkPreviewItem[]>();
  for (const item of items) {
    if (!item.name) continue;
    const matches = byName.get(item.name) ?? [];
    matches.push(item);
    byName.set(item.name, matches);
  }
  for (const matches of byName.values()) {
    if (matches.length < 2) continue;
    matches.sort((left, right) => compareProfilePrecedence(
      left.profile,
      right.profile,
      profileOrder,
    ) || left.file.path.localeCompare(right.file.path));
    const winner = matches[0];
    if (!winner) continue;
    const lowerProfileMatches = matches.filter(({ profile }) => profile.id !== winner.profile.id);
    if (!lowerProfileMatches.length) continue;
    winner.precedenceNote = `Higher priority than ${lowerProfileMatches.length} other profile candidate${lowerProfileMatches.length === 1 ? '' : 's'} with this name.`;
    for (const item of matches.slice(1)) {
      if (item.profile.id === winner.profile.id) continue;
      item.warnings.push(`Name is claimed first by the higher-priority profile “${winner.profile.name}”.`);
    }
  }
}

function compareProfilePrecedence(
  left: AutolinkProfile,
  right: AutolinkProfile,
  profileOrder: ReadonlyMap<string, number>,
): number {
  if (left.scopeType !== right.scopeType) return left.scopeType === 'file' ? -1 : 1;
  if (left.scopeType === 'folder' && right.scopeType === 'folder') {
    const depthDifference = getPathDepth(right.path) - getPathDepth(left.path);
    if (depthDifference) return depthDifference;
  }
  return (profileOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (profileOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
}

function getPathDepth(path: string): number {
  const normalized = normalizeVaultPath(path);
  return normalized ? normalized.split('/').length : 0;
}

function getScopedFiles(app: App, scope: AutolinkPreviewScope): TFile[] {
  const files = app.vault.getMarkdownFiles();
  if (scope.type === 'all') return files.sort((left, right) => left.path.localeCompare(right.path));
  const target = normalizeVaultPath(scope.path).toLocaleLowerCase();
  if (scope.type === 'folder' && !target) {
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
  return files.filter((file) => {
    const path = normalizeVaultPath(file.path).toLocaleLowerCase();
    if (scope.type === 'file') return path === target;
    return path.startsWith(`${target}/`);
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function getCombinedPreviewTitle(scope: AutolinkPreviewScope): string {
  if (scope.type === 'file') return `Autolink preview for ${scope.path}`;
  if (scope.type === 'folder') return `Autolink preview for ${scope.path}`;
  return 'Autolink preview for all enabled profiles';
}

function getOutOfScopeManagedEntries(
  app: App,
  registry: Registry,
  profiles: readonly AutolinkProfile[],
): Array<{ name: string; path: string }> {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const outOfScope: Array<{ name: string; path: string }> = [];
  for (const [name, definition] of registry.data) {
    const managed = definition.managed;
    if (!managed) continue;
    const profile = profilesById.get(managed.profileId);
    if (!profile) continue;
    const file = app.vault.getFileByPath(normalizeVaultPath(managed.sourcePath));
    if (!(file instanceof TFile) || !profileMatchesPath(profile, file.path)) {
      outOfScope.push({ name, path: managed.sourcePath });
    }
  }
  return outOfScope.sort((left, right) => left.name.localeCompare(right.name));
}

function sameVaultPath(left: string, right: string): boolean {
  return normalizeVaultPath(left).toLocaleLowerCase() === normalizeVaultPath(right).toLocaleLowerCase();
}

function formatCardSummary(item: AutolinkPreviewItem): string {
  return item.cardPreset === 'none'
    ? 'None'
    : `${item.cardPreset} · ${item.cardProperties.length ? item.cardProperties.join(', ') : 'No properties'}`;
}

function normalizePreset(
  value: string,
  fallback: AutolinkCardPreset,
  warnings: string[],
): AutolinkCardPreset {
  if (!value) return fallback;
  const normalized = value.toLocaleLowerCase();
  if (normalized === 'none' || normalized === 'classic'
    || normalized === 'compact' || normalized === 'profile') return normalized;
  warnings.push(`Unknown Card preset “${value}”.`);
  return fallback;
}

function readString(value: unknown, property: string, warnings: string[]): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  warnings.push(`${property} must contain text.`);
  return '';
}

function readStringList(value: unknown, fallback: string[], warnings: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) {
    warnings.push('variablelink_card_properties must be a YAML list.');
    return fallback;
  }
  const values = value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim()).filter(Boolean);
  if (values.length !== value.length) warnings.push('Card property names must contain text.');
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
