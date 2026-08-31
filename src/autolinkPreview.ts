import { App, Modal, Notice, TFile } from 'obsidian';
import type VariableLinksPlugin from './main';
import type Registry from './registry';
import {
  DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES,
  normalizeAutolinkProfiles,
  profileMatchesPath,
  type AutolinkCardPreset,
  type AutolinkProfile,
} from './autolink';
import { toFileLink } from './linkSyntax';
import { getTokenSyntax } from './tokenSyntax';
import { parseVariableTextCaseMarker } from './textCase';

interface AutolinkPreviewItem {
  file: TFile;
  name: string;
  valueProperty: string;
  cardPreset: AutolinkCardPreset;
  cardProperties: string[];
  overrideSummary: string;
  warnings: string[];
}

export function openAutolinkProfilePreview(
  app: App,
  plugin: VariableLinksPlugin,
  registry: Registry,
  profile: AutolinkProfile,
): void {
  new AutolinkPreviewModal(app, plugin, registry, profile).open();
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
    const safeItems = items.filter((item) => item.warnings.length === 0);
    const savedProfile = this.registry.autolinkProfiles.find(({ id }) => id === this.profile.id);
    const profileIsSaved = savedProfile !== undefined && profilesEqual(savedProfile, this.profile);
    const canApply = this.profile.enabled && profileIsSaved && safeItems.length > 0;
    this.contentEl.createEl('p', {
      text: items.length
        ? `${items.length} matching note${items.length === 1 ? '' : 's'}; ${safeItems.length} safe addition${safeItems.length === 1 ? '' : 's'}. Nothing changes until you confirm Apply safe additions.`
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
        text: 'This checkpoint adds source-note and value-property links only. Existing links, warnings, updates, removals, and card settings are left unchanged.',
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
        row.createEl('td', {
          text: `${item.cardPreset}${item.cardProperties.length ? ` · ${item.cardProperties.join(', ')}` : ''}`,
        });
        row.createEl('td', { text: item.overrideSummary });
        row.createEl('td', {
          text: item.warnings.length ? item.warnings.join(' ') : 'Ready',
          cls: item.warnings.length ? 'mod-warning' : '',
        });
      }
    }
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const apply = actions.createEl('button', {
      text: 'Apply safe additions',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    apply.disabled = !canApply;
    apply.addEventListener('click', () => {
      new ConfirmAutolinkAdditionsModal(
        this.app,
        this.plugin,
        this.registry,
        this.profile,
        safeItems,
        () => this.buildItems().filter((item) => item.warnings.length === 0),
        () => this.close(),
      ).open();
    });
    actions.createEl('button', { text: 'Close', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
  }

  private buildItems(): AutolinkPreviewItem[] {
    const items = this.app.vault.getMarkdownFiles()
      .filter((file) => profileMatchesPath(this.profile, file.path))
      .map((file) => this.buildItem(file));
    const names = new Map<string, number>();
    for (const item of items) names.set(item.name, (names.get(item.name) ?? 0) + 1);
    const tokenSyntax = getTokenSyntax(this.plugin.settings);
    for (const item of items) {
      if (!item.name) item.warnings.push('A Variable Link name could not be determined.');
      else {
        if ((names.get(item.name) ?? 0) > 1) item.warnings.push('Name collides with another matched note.');
        if (item.name.includes(tokenSyntax.prefix) || item.name.includes(tokenSyntax.suffix)) {
          item.warnings.push('Name contains the active token prefix or suffix.');
        }
        if (parseVariableTextCaseMarker(item.name)) {
          item.warnings.push('Name resembles token text-case syntax and must be created manually.');
        }
      }
      const existing = item.name ? this.registry.getVariable(item.name) : null;
      if (existing) item.warnings.push('Name already belongs to an existing Variable Link.');
    }
    return items.sort((left, right) => left.file.path.localeCompare(right.file.path));
  }

  private buildItem(file: TFile): AutolinkPreviewItem {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const metadata = isRecord(frontmatter) ? frontmatter : {};
    const warnings: string[] = [];
    const overrideProperties = this.profile.customOverridePropertyNames
      ? this.profile.overrideProperties
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
    const allowOverrides = this.profile.allowOverrides;
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
    const cardPreset = normalizePreset(template, this.profile.cardPreset, warnings);
    const cardProperties = readStringList(
      allowOverrides ? metadata[overrideProperties.cardProperties] : undefined,
      this.profile.cardProperties,
      warnings,
    );
    const name = explicitName || applyNamePattern(this.profile.namePattern, file);
    const valueProperty = explicitValueProperty || this.profile.valueProperty;
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
      name,
      valueProperty,
      cardPreset,
      cardProperties,
      overrideSummary,
      warnings,
    };
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
    private readonly onApplied: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: 'Apply safe autolink additions?' });
    this.contentEl.createEl('p', {
      text: `Add ${this.items.length} property-backed Variable Link${this.items.length === 1 ? '' : 's'} from “${this.profile.name}”?`,
    });
    this.contentEl.createEl('p', {
      text: 'This adds new registry entries only. If any name is no longer available, the entire batch is cancelled without changing the registry.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    const apply = actions.createEl('button', {
      text: 'Apply additions',
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
        apply.textContent = 'Apply additions';
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
    const count = await this.registry.addManagedAutolinkVariables(currentItems.map((item) => ({
      name: item.name,
      definition: {
        type: 'property',
        file: toFileLink(item.file.path),
        property: item.valueProperty,
        managed: {
          profileId: this.profile.id,
          sourcePath: item.file.path,
          managedFields: ['file', 'property'],
        },
      },
    })));
    new Notice(`Variable Links: added ${count} Autolink Variable Link${count === 1 ? '' : 's'}.`);
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
  });
  return left.length === right.length
    && left.every((item, index) => summarize(item) === summarize(right[index]));
}

function applyNamePattern(pattern: string, file: TFile): string {
  if (!pattern.trim()) return file.basename;
  return pattern
    .replace(/\{file}/gi, file.basename)
    .replace(/\{path}/gi, file.path.replace(/\.md$/i, ''))
    .trim();
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
