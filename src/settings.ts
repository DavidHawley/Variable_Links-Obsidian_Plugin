import { App, Modal, Notice, PluginSettingTab, Setting, SettingDefinitionItem, setIcon } from 'obsidian';
import {
  DEFAULT_APPEARANCE_COLORS,
  normalizeAppearanceColor,
  normalizeAppearanceOpacity,
  type VariableDecoration,
} from './appearance';
import {
  createAutolinkProfile,
  DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES,
  type AutolinkCardPreset,
  type AutolinkProfile,
  type AutolinkScopeType,
} from './autolink';
import { openAutolinkProfilePreview } from './autolinkPreview';
import { addContextHelpButton, openContextHelp } from './contextHelp';
import { formatCapturedDateTime } from './dateTime';
import VariableLinksPlugin from './main';
import type { TokenSyntaxMigrationPlan } from './tokenCache';
import {
  DEFAULT_TOKEN_SYNTAX,
  MAX_TOKEN_DELIMITER_LENGTH,
  formatVariableToken,
  getTokenSyntax,
  normalizeLegacyTokenSyntaxes,
  tokenSyntaxEquals,
  type TokenSyntax,
} from './tokenSyntax';

export interface VariableLinksSettings {
  registryFilePath: string;
  tokenPrefix: string;
  tokenSuffix: string;
  legacyTokenSyntaxes: TokenSyntax[];
  enableInfoCards: boolean;
  readingViewHoverDelaySeconds: number;
  livePreviewHoverDelaySeconds: number;
  disableLivePreviewHover: boolean;
  defaultAppearanceBold: boolean;
  defaultAppearanceItalic: boolean;
  defaultAppearanceDecoration: VariableDecoration;
  defaultAppearanceUseCustomColor: boolean;
  defaultAppearanceColor: string;
  defaultAppearanceOpacity: number;
  savedAppearanceColors: string[];
  openInNewPane: boolean;
  suggestionFuzzy: boolean;
  defaultDateFormat: string;
  defaultTimeFormat: string;
  defaultDateTimeFormat: string;
  infoCardEditorWidth: number | null;
  infoCardEditorHeight: number | null;
  infoCardEditorCollapsedItems: Record<string, string[]>;
}

type SettingKey = keyof VariableLinksSettings;
type TokenSyntaxChangeAction = 'cancel' | 'new-only' | 'migrate';

export const DEFAULT_SETTINGS: VariableLinksSettings = {
  registryFilePath: '',
  tokenPrefix: DEFAULT_TOKEN_SYNTAX.prefix,
  tokenSuffix: DEFAULT_TOKEN_SYNTAX.suffix,
  legacyTokenSyntaxes: [],
  enableInfoCards: true,
  readingViewHoverDelaySeconds: 0.5,
  livePreviewHoverDelaySeconds: 3,
  disableLivePreviewHover: false,
  defaultAppearanceBold: false,
  defaultAppearanceItalic: false,
  defaultAppearanceDecoration: 'underline',
  defaultAppearanceUseCustomColor: false,
  defaultAppearanceColor: DEFAULT_APPEARANCE_COLORS[0],
  defaultAppearanceOpacity: 100,
  savedAppearanceColors: [...DEFAULT_APPEARANCE_COLORS],
  openInNewPane: false,
  suggestionFuzzy: true,
  defaultDateFormat: 'YYYY-MM-DD',
  defaultTimeFormat: 'HH:mm:ss',
  defaultDateTimeFormat: 'YYYY-MM-DD HH:mm:ss',
  infoCardEditorWidth: null,
  infoCardEditorHeight: null,
  infoCardEditorCollapsedItems: {},
};

class TokenSyntaxChangeModal extends Modal {
  private settled = false;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly current: TokenSyntax,
    private readonly proposed: TokenSyntax,
    private readonly plan: TokenSyntaxMigrationPlan,
    private readonly settle: (action: TokenSyntaxChangeAction) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: 'Change variable link token format?' });
    const comparison = this.contentEl.createDiv({ cls: 'variable-links-token-syntax-comparison' });
    this.addFormatRow(comparison, 'Current format', this.current);
    this.addFormatRow(comparison, 'Proposed format', this.proposed);
    this.addFormatRow(comparison, 'Example', this.proposed, 'Variable');
    this.contentEl.createEl('p', {
      text: this.plan.tokenCount === 0
        ? 'No existing Variable Link tokens using the current format were found.'
        : `Found ${this.plan.tokenCount} existing token${this.plan.tokenCount === 1 ? '' : 's'} in ${this.plan.fileCount} note${this.plan.fileCount === 1 ? '' : 's'}.`,
    });
    this.contentEl.createEl('p', {
      text: 'Using the format for new tokens only keeps the current format recognized. Migrating updates verified tokens in notes and stops recognizing the old format.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.choose('cancel'));
    actions.createEl('button', { text: 'Use for new tokens only' })
      .addEventListener('click', () => this.choose('new-only'));
    actions.createEl('button', { text: 'Migrate existing tokens', cls: 'mod-cta' })
      .addEventListener('click', () => this.choose('migrate'));
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
    if (!this.settled) this.finish('cancel');
  }

  private addFormatRow(
    parent: HTMLElement,
    label: string,
    syntax: TokenSyntax,
    name = 'Name',
  ): void {
    const row = parent.createDiv({ cls: 'variable-links-token-syntax-comparison-row' });
    row.createSpan({ text: `${label}:` });
    row.createEl('code', { text: formatVariableToken(name, syntax) });
  }

  private choose(action: TokenSyntaxChangeAction): void {
    this.finish(action);
    this.close();
  }

  private finish(action: TokenSyntaxChangeAction): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(action);
  }
}

class DeleteAutolinkProfileModal extends Modal {
  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly profileName: string,
    private readonly managedVariableCount: number,
    private readonly onConfirm: () => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: 'Delete autolink profile?' });
    this.contentEl.createEl('p', { text: `Delete “${this.profileName}”?` });
    this.contentEl.createEl('p', {
      text: this.managedVariableCount
        ? `${this.managedVariableCount} Variable Link${this.managedVariableCount === 1 ? '' : 's'} created by this profile will remain in the registry and continue to work.`
        : 'Deleting the profile does not remove any Variable Links.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
    actions.createEl('button', {
      text: 'Delete profile',
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

export function normalizeInfoCardEditorDimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

export function normalizeInfoCardEditorCollapsedItems(
  value: unknown,
): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const normalized = Object.create(null) as Record<string, string[]>;
  for (const [name, itemIds] of Object.entries(value)) {
    if (!name || name.length > 200 || !Array.isArray(itemIds)) continue;
    const ids = itemIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 200);
    if (ids.length) normalized[name] = [...new Set(ids)].slice(0, 500);
  }
  return normalized;
}

function normalizeQuarterSecondDelay(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(30, Math.max(minimum, Math.round(value * 4) / 4));
}

export function normalizeReadingViewHoverDelay(value: unknown): number {
  return normalizeQuarterSecondDelay(
    value,
    DEFAULT_SETTINGS.readingViewHoverDelaySeconds,
    0,
  );
}

export function normalizeLivePreviewHoverDelay(value: unknown): number {
  return normalizeQuarterSecondDelay(
    value,
    DEFAULT_SETTINGS.livePreviewHoverDelaySeconds,
    1,
  );
}

export class VariableLinksSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly variableLinksPlugin: VariableLinksPlugin) {
    super(app, variableLinksPlugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    return [
      {
        name: 'Registry file',
        desc: 'JSON, YAML, or Markdown registry. The default is a hidden registry.json in this plugin folder.',
        control: {
          type: 'file',
          key: 'registryFilePath',
          placeholder: 'Select a registry file',
        },
      },
      {
        name: 'Management center',
        desc: 'Open Variable Links management tools in a main workspace tab.',
        render: (setting) => {
          const button = setting.controlEl.createEl('button', {
            text: 'Open',
            attr: { type: 'button' },
          });
          const onClick = (): void => void this.variableLinksPlugin.openManagementCenter();
          button.addEventListener('click', onClick);
          return () => button.removeEventListener('click', onClick);
        },
      },
      {
        type: 'group',
        heading: 'Autolink profiles',
        extraButtons: [(button) => {
          button
            .setIcon('circle-help')
            .setTooltip('Autolink profiles help')
            .onClick(() => openContextHelp(
              this.variableLinksPlugin,
              'Autolink profiles',
              button.extraSettingsEl,
              (parent) => this.renderAutolinkProfilesHelp(parent),
            ));
          button.extraSettingsEl.setAttribute('aria-label', 'Autolink profiles help');
        }],
        items: [
          {
            name: 'Profiles',
            desc: 'Configure reusable file or folder scopes, preview their matches, and safely add non-conflicting Variable Links.',
            render: (setting) => {
              setting.settingEl.addClass('variable-links-autolink-setting-item');
              return this.renderAutolinkProfiles(setting.controlEl);
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Variable Link syntax',
        items: [
          {
            name: 'Token prefix and suffix',
            desc: 'Choose the literal characters around Variable Link names, then keep the current format recognized or migrate existing tokens.',
            render: (setting) => {
              const disposeHelp = addContextHelpButton(
                setting.nameEl,
                this.variableLinksPlugin,
                'Variable link token format',
                (parent) => this.renderTokenSyntaxHelp(parent),
              );
              const disposeEditor = this.renderTokenSyntaxEditor(setting.controlEl);
              return () => {
                disposeHelp();
                disposeEditor();
              };
            },
          },
        ],
      },
      {
        name: 'Update token cache',
        desc: 'Rescan every Markdown file and update the recorded Variable Link locations.',
        render: (setting) => this.renderTokenCacheUpdateButton(setting.controlEl),
      },
      {
        type: 'group',
        heading: 'Default variable appearance',
        extraButtons: [(button) => {
          button
            .setIcon('circle-help')
            .setTooltip('Default variable appearance help')
            .onClick(() => openContextHelp(
              this.variableLinksPlugin,
              'Default variable appearance',
              button.extraSettingsEl,
              (parent) => this.renderDefaultAppearanceHelp(parent),
            ));
          button.extraSettingsEl.setAttribute('aria-label', 'Default variable appearance help');
        }],
        items: [
          {
            name: 'Bold',
            desc: 'Display variables in bold unless they have an individual appearance override.',
            control: { type: 'toggle', key: 'defaultAppearanceBold' },
          },
          {
            name: 'Italic',
            desc: 'Display variables in italics unless they have an individual appearance override.',
            control: { type: 'toggle', key: 'defaultAppearanceItalic' },
          },
          {
            name: 'Decoration',
            desc: 'Default decoration for variables without an individual appearance override.',
            control: {
              type: 'dropdown',
              key: 'defaultAppearanceDecoration',
              options: {
                underline: 'Underline',
                highlight: 'Highlight',
                none: 'None',
              },
            },
          },
          {
            name: 'Custom decoration color',
            desc: 'Replace the active Obsidian theme color with a custom default color.',
            control: {
              type: 'toggle',
              key: 'defaultAppearanceUseCustomColor',
              disabled: () => this.variableLinksPlugin.settings.defaultAppearanceDecoration === 'none',
            },
          },
          {
            name: 'Default decoration color',
            desc: 'Color used by the default underline or highlight.',
            control: {
              type: 'color',
              key: 'defaultAppearanceColor',
              disabled: () => !this.variableLinksPlugin.settings.defaultAppearanceUseCustomColor
                || this.variableLinksPlugin.settings.defaultAppearanceDecoration === 'none',
            },
          },
          {
            name: 'Decoration opacity',
            desc: 'Transparency of the default underline or highlight.',
            control: {
              type: 'slider',
              key: 'defaultAppearanceOpacity',
              min: 0,
              max: 100,
              step: 1,
              displayFormat: (value) => `${value}%`,
              disabled: () => this.variableLinksPlugin.settings.defaultAppearanceDecoration === 'none',
            },
          },
          {
            name: 'Saved colors',
            desc: 'Reusable colors shown in each variable’s appearance controls.',
            render: (setting) => this.renderSavedAppearanceColors(setting.controlEl),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Info card hover',
        extraButtons: [(button) => {
          button
            .setIcon('circle-help')
            .setTooltip('Info card hover help')
            .onClick(() => openContextHelp(
              this.variableLinksPlugin,
              'Info card hover',
              button.extraSettingsEl,
              (parent) => this.renderInfoCardHoverHelp(parent),
            ));
          button.extraSettingsEl.setAttribute('aria-label', 'Info card hover help');
        }],
        items: [
          {
            name: 'Enable info cards',
            desc: 'Show info cards when hovering over rendered variables.',
            control: { type: 'toggle', key: 'enableInfoCards' },
          },
          {
            name: 'Reading View hover delay',
            desc: 'Seconds to hover over a rendered variable before its info card appears in Reading View.',
            control: {
              type: 'number',
              key: 'readingViewHoverDelaySeconds',
              min: 0,
              max: 30,
              step: 0.25,
            },
          },
          {
            name: 'Live Preview hover delay',
            desc: 'Seconds to hover over a rendered variable before its info card appears in Live Preview.',
            control: {
              type: 'number',
              key: 'livePreviewHoverDelaySeconds',
              min: 1,
              max: 30,
              step: 0.25,
            },
          },
          {
            name: 'Disable Live Preview hover',
            desc: 'Prevent info cards from opening in Live Preview. Reading View is unaffected.',
            control: { type: 'toggle', key: 'disableLivePreviewHover' },
          },
        ],
      },
      {
        name: 'Open file links in new pane',
        desc: 'Open the configured file link in a new pane when clicking a rendered variable.',
        control: { type: 'toggle', key: 'openInNewPane' },
      },
      {
        name: 'Suggestion fuzzy matching',
        desc: 'Match suggestions by variable name, display name, source file, or property.',
        control: { type: 'toggle', key: 'suggestionFuzzy' },
      },
      {
        type: 'group',
        heading: 'Captured date and time',
        items: [
          {
            name: 'Default date format',
            desc: 'Format used by DATE shortcuts without an inline format.',
            render: (setting) => this.renderDateTimeFormatSetting(
              setting,
              'defaultDateFormat',
              'YYYY-MM-DD',
            ),
          },
          {
            name: 'Default time format',
            desc: 'Format used by TIME shortcuts without an inline format.',
            render: (setting) => this.renderDateTimeFormatSetting(
              setting,
              'defaultTimeFormat',
              'HH:mm:ss',
            ),
          },
          {
            name: 'Default date-time format',
            desc: 'Format used by DATETIME shortcuts without an inline format.',
            render: (setting) => this.renderDateTimeFormatSetting(
              setting,
              'defaultDateTimeFormat',
              'YYYY-MM-DD HH:mm:ss',
            ),
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (!this.isSettingKey(key)) return undefined;
    return this.variableLinksPlugin.settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!this.isSettingKey(key)) return;
    if (key === 'infoCardEditorWidth'
      || key === 'infoCardEditorHeight'
      || key === 'infoCardEditorCollapsedItems'
      || key === 'tokenPrefix'
      || key === 'tokenSuffix'
      || key === 'legacyTokenSyntaxes') return;

    if (key === 'registryFilePath'
      || key === 'defaultDateFormat'
      || key === 'defaultTimeFormat'
      || key === 'defaultDateTimeFormat') {
      if (typeof value !== 'string') return;
      this.variableLinksPlugin.settings[key] = value.trim();
    } else if (key === 'readingViewHoverDelaySeconds') {
      this.variableLinksPlugin.settings[key] = normalizeReadingViewHoverDelay(value);
    } else if (key === 'livePreviewHoverDelaySeconds') {
      this.variableLinksPlugin.settings[key] = normalizeLivePreviewHoverDelay(value);
    } else if (key === 'defaultAppearanceOpacity') {
      this.variableLinksPlugin.settings[key] = normalizeAppearanceOpacity(value);
    } else if (key === 'defaultAppearanceDecoration') {
      if (value !== 'underline' && value !== 'highlight' && value !== 'none') return;
      this.variableLinksPlugin.settings[key] = value;
    } else if (key === 'defaultAppearanceColor') {
      this.variableLinksPlugin.settings[key] = normalizeAppearanceColor(
        value,
        DEFAULT_SETTINGS.defaultAppearanceColor,
      );
    } else if (key === 'savedAppearanceColors') {
      return;
    } else {
      if (typeof value !== 'boolean') return;
      this.variableLinksPlugin.settings[key] = value;
    }

    await this.variableLinksPlugin.saveSettings();
    if (this.isAppearanceSettingKey(key)) {
      this.variableLinksPlugin.livePreviewRenderer?.refresh();
      this.refreshDomState();
      this.variableLinksPlugin.refreshPanelAppearanceSettings();
    }
    if (key === 'registryFilePath') {
      try {
        await this.variableLinksPlugin.registry?.load();
        await this.variableLinksPlugin.refreshAfterRegistryReload();
      } catch (error) {
        new Notice(`Failed to load registry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private isSettingKey(key: string): key is SettingKey {
    return key in DEFAULT_SETTINGS;
  }

  private isAppearanceSettingKey(key: SettingKey): boolean {
    return key.startsWith('defaultAppearance') || key === 'savedAppearanceColors';
  }

  private renderDateTimeFormatSetting(
    setting: Setting,
    key: 'defaultDateFormat' | 'defaultTimeFormat' | 'defaultDateTimeFormat',
    placeholder: string,
  ): () => void {
    const error = setting.settingEl.createDiv({
      cls: 'variable-links-setting-validation variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    let input: HTMLInputElement;
    setting.addText((component) => {
      input = component.inputEl;
      component
        .setValue(this.variableLinksPlugin.settings[key])
        .setPlaceholder(placeholder)
        .onChange((value) => {
          const normalized = value.trim();
          const result = formatCapturedDateTime(new Date(), normalized);
          error.toggleClass('is-visible', !result.ok);
          error.setText(result.ok ? '' : result.error);
          if (result.ok) {
            void this.setControlValue(key, normalized).catch((caught: unknown) => {
              new Notice(`Variable Links: could not save the format: ${getErrorMessage(caught)}`);
            });
          }
        });
    });
    const initial = formatCapturedDateTime(new Date(), this.variableLinksPlugin.settings[key]);
    error.toggleClass('is-visible', !initial.ok);
    error.setText(initial.ok ? '' : initial.error);
    const disposeHelp = addContextHelpButton(
      setting.nameEl,
      this.variableLinksPlugin,
      'Date and time format',
      (parent) => this.renderDateTimeFormatHelp(parent, input.value),
    );
    return disposeHelp;
  }

  private renderDateTimeFormatHelp(parent: HTMLElement, initialFormat: string): () => void {
    parent.createEl('p', {
      text: 'Date, time, and datetime use the same case-sensitive format language. Their settings only provide different defaults.',
    });
    const previewSetting = parent.createDiv({ cls: 'variable-links-date-format-preview-setting' });
    const previewLabel = previewSetting.createEl('label');
    previewLabel.createSpan({ text: 'Format to preview' });
    const format = previewLabel.createEl('input', {
      attr: {
        type: 'text',
        value: initialFormat,
        spellcheck: 'false',
      },
    });
    const preview = parent.createDiv({ cls: 'variable-links-date-format-preview' });
    preview.createSpan({ text: 'Current local result:' });
    const previewValue = preview.createEl('code', { attr: { 'aria-live': 'polite' } });
    const previewError = parent.createDiv({
      cls: 'variable-links-setting-validation variable-links-hint-text',
      attr: { 'aria-live': 'polite' },
    });
    const renderPreview = (): void => {
      const result = formatCapturedDateTime(new Date(), format.value);
      previewValue.setText(result.ok ? result.value : 'Invalid format');
      previewError.toggleClass('is-visible', !result.ok);
      previewError.setText(result.ok ? '' : result.error);
    };
    format.addEventListener('input', renderPreview);
    renderPreview();

    parent.createEl('p', {
      text: 'Put literal words in [brackets], or use a backslash before one literal character. Token letters are case-sensitive: MM is month, while mm is minutes.',
    });
    const table = parent.createEl('table', { cls: 'variable-links-date-format-table' });
    const header = table.createEl('thead').createEl('tr');
    header.createEl('th', { text: 'Tokens' });
    header.createEl('th', { text: 'Meaning' });
    const body = table.createEl('tbody');
    for (const [tokens, meaning] of [
      ['YYYY, YY', 'Four- or two-digit year'],
      ['MMMM, MMM, MM, M', 'Full, short, padded, or numeric month'],
      ['DD, D', 'Padded or numeric day'],
      ['WW, www, w', 'Full, short, or single-letter weekday'],
      ['HH, H', '24-hour clock'],
      ['hh, h', '12-hour clock'],
      ['mm, m', 'Minutes'],
      ['ss, s', 'Seconds'],
      ['SSS', 'Milliseconds'],
      ['A, a', 'Uppercase or lowercase AM/PM'],
    ] as const) {
      const row = body.createEl('tr');
      row.createEl('td').createEl('code', { text: tokens });
      row.createEl('td', { text: meaning });
    }

    new Setting(parent).setName('Examples').setHeading();
    const examples = parent.createDiv({ cls: 'variable-links-date-format-examples' });
    for (const example of [
      'YYYY-MM-DD',
      'HH:mm:ss',
      'YYYY-MM-DD HH:mm:ss',
      'WW, MMMM D, YYYY',
      'hh:mm A',
      'YYYY-MM-DD [at] hh:mm A',
    ]) {
      const row = examples.createDiv();
      row.createEl('code', { text: example });
      const copy = row.createEl('button', {
        cls: 'clickable-icon',
        attr: { type: 'button', 'aria-label': `Copy ${example}`, title: 'Copy format' },
      });
      setIcon(copy, 'copy');
      copy.addEventListener('click', () => {
        const clipboard = parent.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard) {
          new Notice('Variable links: clipboard access is unavailable.');
          return;
        }
        void clipboard.writeText(example).then(
          () => new Notice('Variable links: format copied.'),
          (caught: unknown) => new Notice(
            `Variable links: could not copy the format: ${getErrorMessage(caught)}`,
          ),
        );
      });
    }
    const hostWindow = parent.ownerDocument.defaultView;
    const timer = hostWindow?.setInterval(renderPreview, 1000);
    return () => {
      format.removeEventListener('input', renderPreview);
      if (timer !== undefined) hostWindow?.clearInterval(timer);
    };
  }

  private renderTokenSyntaxHelp(parent: HTMLElement): void {
    const active = getTokenSyntax(this.variableLinksPlugin.settings);
    parent.createEl('p', {
      text: 'The prefix and suffix are literal characters placed around every permanent variable link name.',
    });
    const example = parent.createDiv({ cls: 'variable-links-context-help-example' });
    example.createSpan({ text: 'Current example:' });
    example.createEl('code', { text: formatVariableToken('Variable', active) });
    const choices = parent.createEl('ul');
    for (const choice of [
      'Use for new tokens only changes future tokens and keeps the previous format recognized in existing notes.',
      'Migrate existing tokens updates verified cached tokens, then stops recognizing the old format.',
      'Cancel leaves the active format and every note unchanged.',
      'Stop recognizing removes an old format only after you have migrated or manually cleaned up its remaining tokens.',
    ]) choices.createEl('li', { text: choice });
    parent.createEl('p', {
      text: 'Formats that overlap Markdown or Obsidian syntax may not render reliably. Review warnings and test a new format before migrating existing notes.',
      cls: 'variable-links-hint-text',
    });
  }

  private renderDefaultAppearanceHelp(parent: HTMLElement): void {
    parent.createEl('p', {
      text: 'These settings define the appearance inherited by variable links that have use default appearance enabled.',
    });
    const details = parent.createEl('ul');
    details.createEl('li', {
      text: 'Inherited variables update when these defaults change.',
    });
    details.createEl('li', {
      text: 'Turning off use default appearance restores that variable’s saved custom appearance.',
    });
    details.createEl('li', {
      text: 'Saved colors are reusable swatches; changing a swatch does not recolor variables that already saved its earlier color.',
    });
  }

  private renderInfoCardHoverHelp(parent: HTMLElement): void {
    parent.createEl('p', {
      text: 'Info card hover behavior is configured separately for reading view and live preview.',
    });
    const details = parent.createEl('ul');
    details.createEl('li', {
      text: 'Enable info cards is the master switch for both editor modes.',
    });
    details.createEl('li', {
      text: 'Delays use quarter-second steps. Reading view allows an immediate 0-second delay; Live preview starts at 1 second.',
    });
    details.createEl('li', {
      text: 'Disable live preview hover prevents every card from opening in live preview but does not affect reading view.',
    });
    details.createEl('li', {
      text: 'An individual card can disable only its own live preview hover from the card properties panel.',
    });
  }

  private renderAutolinkProfilesHelp(parent: HTMLElement): void {
    const details = parent.createEl('ul');
    details.createEl('li', {
      text: 'A profile matches one exact file or a folder, optionally including its subfolders. More specific matching profiles take priority.',
    });
    details.createEl('li', {
      text: 'Value property chooses the note property displayed by each generated variable. Name pattern controls its permanent variable name.',
    });
    details.createEl('li', {
      text: 'Preview matches reads notes without changing the registry. Apply safe additions creates only non-conflicting entries.',
    });
    details.createEl('li', {
      text: 'Allow overwrite and apply all are required before same-name entries can be replaced; other warnings remain excluded.',
    });
    details.createEl('li', {
      text: 'Allow note overrides lets matching notes replace profile defaults through standard or custom property names.',
    });
    details.createEl('li', {
      text: 'Card presets are saved as snapshots, so later profile changes do not silently replace a customized card.',
    });
    parent.createEl('p', {
      text: 'Deleting a profile does not delete the managed variable links it already created.',
      cls: 'variable-links-hint-text',
    });
  }

  private renderAutolinkProfiles(controlEl: HTMLElement): () => void {
    const host = controlEl.createDiv({ cls: 'variable-links-autolink-profiles' });
    let active = true;
    let cleanups: Array<() => void> = [];
    const listen = <K extends keyof HTMLElementEventMap>(
      element: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
    ): void => {
      element.addEventListener(type, listener as EventListener);
      cleanups.push(() => element.removeEventListener(type, listener as EventListener));
    };
    const render = (): void => {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      host.empty();
      const registry = this.variableLinksPlugin.registry;
      if (!registry) {
        host.createEl('p', { text: 'The registry is not available.', cls: 'mod-warning' });
        return;
      }
      const profiles = registry.autolinkProfiles;
      for (const profile of profiles) this.renderAutolinkProfile(host, profile, profiles, render, listen);
      if (!profiles.length) {
        host.createEl('p', { text: 'No autolink profiles configured.', cls: 'mod-muted' });
      }
      const add = host.createEl('button', { text: 'Add profile', attr: { type: 'button' } });
      listen(add, 'click', () => {
        add.disabled = true;
        void registry.saveAutolinkProfiles([...profiles, createAutolinkProfile()])
          .then(() => { if (active) render(); })
          .catch((error: unknown) => {
            add.disabled = false;
            new Notice(`Variable Links: could not add the profile: ${error instanceof Error ? error.message : String(error)}`);
          });
      });
    };
    render();
    return () => {
      active = false;
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
    };
  }

  private renderAutolinkProfile(
    host: HTMLElement,
    profile: AutolinkProfile,
    profiles: readonly AutolinkProfile[],
    rerender: () => void,
    listen: <K extends keyof HTMLElementEventMap>(
      element: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
    ) => void,
  ): void {
    const details = host.createEl('details', { cls: 'variable-links-autolink-profile' });
    details.open = true;
    const summary = details.createEl('summary');
    summary.createSpan({ text: profile.name, cls: 'variable-links-autolink-profile-title' });
    const body = details.createDiv({ cls: 'variable-links-autolink-profile-fields' });
    const field = (labelText: string): HTMLLabelElement => {
      const label = body.createEl('label', { cls: 'variable-links-autolink-profile-field' });
      label.createSpan({ text: labelText });
      return label;
    };
    const checkboxField = (
      labelText: string,
      checked: boolean,
    ): { label: HTMLLabelElement; input: HTMLInputElement } => {
      const label = body.createEl('label', {
        cls: 'variable-links-autolink-profile-field variable-links-autolink-profile-checkbox',
      });
      const input = label.createEl('input', { type: 'checkbox' });
      input.checked = checked;
      label.createSpan({ text: labelText });
      return { label, input };
    };
    const { input: enabled } = checkboxField('Enabled', profile.enabled);
    const name = field('Profile name').createEl('input', { type: 'text' });
    name.value = profile.name;
    const scope = field('Scope').createEl('select');
    scope.createEl('option', { text: 'Folder', value: 'folder' });
    scope.createEl('option', { text: 'Exact file', value: 'file' });
    scope.value = profile.scopeType;
    const path = field('Vault path').createEl('input', { type: 'text' });
    path.value = profile.path;
    path.placeholder = profile.scopeType === 'file' ? 'Folder/Note.md' : 'Folder';
    const { label: subfoldersLabel, input: subfolders } = checkboxField(
      'Include subfolders',
      profile.includeSubfolders,
    );
    const valueProperty = field('Value property').createEl('input', { type: 'text' });
    valueProperty.value = profile.valueProperty;
    valueProperty.placeholder = 'Status';
    const namePattern = field('Name pattern').createEl('input', { type: 'text' });
    namePattern.value = profile.namePattern;
    namePattern.placeholder = 'Blank uses the note filename';
    const cardPreset = field('Card preset').createEl('select');
    const presetOptions: Array<{ value: AutolinkCardPreset; label: string }> = [
      { value: 'none', label: 'None' },
      { value: 'classic', label: 'Classic stack' },
      { value: 'compact', label: 'Compact grid' },
      { value: 'profile', label: 'Profile card' },
    ];
    for (const option of presetOptions) {
      cardPreset.createEl('option', { value: option.value, text: option.label });
    }
    cardPreset.value = profile.cardPreset;
    const cardPropertiesLabel = field('Card properties');
    const cardProperties = cardPropertiesLabel.createEl('textarea');
    cardProperties.rows = 3;
    cardProperties.value = profile.cardProperties.join('\n');
    cardProperties.placeholder = 'One note property per line';
    const { input: allowOverrides } = checkboxField(
      'Allow note overrides',
      profile.allowOverrides,
    );
    const { label: customOverridesLabel, input: customOverrides } = checkboxField(
      'Use custom override property names',
      profile.customOverridePropertyNames,
    );
    const overrideNameLabel = field('Variable name override');
    const overrideName = overrideNameLabel.createEl('input', { type: 'text' });
    overrideName.value = profile.overrideProperties.name;
    const overrideValueLabel = field('Value property override');
    const overrideValue = overrideValueLabel.createEl('input', { type: 'text' });
    overrideValue.value = profile.overrideProperties.valueProperty;
    const overrideTemplateLabel = field('Card template override');
    const overrideTemplate = overrideTemplateLabel.createEl('input', { type: 'text' });
    overrideTemplate.value = profile.overrideProperties.template;
    const overrideCardPropertiesLabel = field('Card properties override');
    const overrideCardProperties = overrideCardPropertiesLabel.createEl('input', { type: 'text' });
    overrideCardProperties.value = profile.overrideProperties.cardProperties;
    const status = body.createDiv({ cls: 'variable-links-hint-text' });
    const actions = body.createDiv({ cls: 'variable-links-autolink-profile-actions' });
    const preview = actions.createEl('button', { text: 'Preview matches', attr: { type: 'button' } });
    const save = actions.createEl('button', { text: 'Save profile', attr: { type: 'button' } });
    const restoreOverrideNames = actions.createEl('button', {
      text: 'Restore standard names',
      attr: { type: 'button' },
    });
    const remove = actions.createEl('button', {
      text: 'Delete',
      cls: 'mod-warning',
      attr: { type: 'button' },
    });
    const updateState = (): void => {
      const folder = scope.value === 'folder';
      subfoldersLabel.hidden = !folder;
      customOverridesLabel.hidden = !allowOverrides.checked;
      const showOverrideNames = allowOverrides.checked && customOverrides.checked;
      overrideNameLabel.hidden = !showOverrideNames;
      overrideValueLabel.hidden = !showOverrideNames;
      overrideTemplateLabel.hidden = !showOverrideNames;
      overrideCardPropertiesLabel.hidden = !showOverrideNames;
      restoreOverrideNames.hidden = !showOverrideNames;
      path.placeholder = folder ? 'Folder' : 'Folder/Note.md';
      const overrideNames = [
        overrideName.value.trim(),
        overrideValue.value.trim(),
        overrideTemplate.value.trim(),
        overrideCardProperties.value.trim(),
      ];
      const overrideError = showOverrideNames && overrideNames.some((value) => !value)
        ? 'Custom override property names cannot be blank.'
        : showOverrideNames && new Set(overrideNames).size !== overrideNames.length
          ? 'Custom override property names must be different from each other.'
          : '';
      const error = overrideError || (enabled.checked && !path.value.trim()
        ? 'An enabled profile requires a vault path.'
        : enabled.checked && !valueProperty.value.trim()
          ? 'An enabled profile requires a value property.'
          : '');
      status.textContent = error || 'Preview matches first, then separately confirm any safe additions.';
      status.classList.toggle('is-error', Boolean(error));
      save.disabled = Boolean(error);
      preview.disabled = Boolean(error);
    };
    const currentProfile = (): AutolinkProfile => ({
      id: profile.id,
      name: name.value.trim() || 'Unnamed profile',
      enabled: enabled.checked,
      scopeType: scope.value as AutolinkScopeType,
      path: path.value,
      includeSubfolders: scope.value === 'folder' && subfolders.checked,
      valueProperty: valueProperty.value,
      namePattern: namePattern.value,
      cardPreset: cardPreset.value as AutolinkCardPreset,
      cardProperties: cardProperties.value.split(/\r?\n|,/),
      allowOverrides: allowOverrides.checked,
      customOverridePropertyNames: customOverrides.checked,
      overrideProperties: {
        name: overrideName.value,
        valueProperty: overrideValue.value,
        template: overrideTemplate.value,
        cardProperties: overrideCardProperties.value,
      },
    });
    listen(scope, 'change', updateState);
    listen(enabled, 'change', updateState);
    listen(allowOverrides, 'change', updateState);
    listen(customOverrides, 'change', updateState);
    listen(path, 'input', updateState);
    listen(valueProperty, 'input', updateState);
    for (const input of [overrideName, overrideValue, overrideTemplate, overrideCardProperties]) {
      listen(input, 'input', updateState);
    }
    listen(restoreOverrideNames, 'click', () => {
      overrideName.value = DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.name;
      overrideValue.value = DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.valueProperty;
      overrideTemplate.value = DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.template;
      overrideCardProperties.value = DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.cardProperties;
      updateState();
    });
    listen(preview, 'click', () => {
      const registry = this.variableLinksPlugin.registry;
      if (registry) openAutolinkProfilePreview(
        this.app,
        this.variableLinksPlugin,
        registry,
        currentProfile(),
      );
    });
    listen(save, 'click', () => {
      const updated = currentProfile();
      save.disabled = true;
      void this.variableLinksPlugin.registry?.saveAutolinkProfiles(
        profiles.map((candidate) => candidate.id === profile.id ? updated : candidate),
      ).then(() => rerender()).catch((error: unknown) => {
        save.disabled = false;
        new Notice(`Variable Links: could not save the profile: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    listen(remove, 'click', () => {
      const registry = this.variableLinksPlugin.registry;
      if (!registry) return;
      const managedVariableCount = [...registry.data.values()]
        .filter((definition) => definition.managed?.profileId === profile.id).length;
      new DeleteAutolinkProfileModal(
        this.variableLinksPlugin,
        profile.name,
        managedVariableCount,
        () => {
          remove.disabled = true;
          void registry.saveAutolinkProfiles(
            profiles.filter((candidate) => candidate.id !== profile.id),
          ).then(() => rerender()).catch((error: unknown) => {
            remove.disabled = false;
            new Notice(`Variable Links: could not delete the profile: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      ).open();
    });
    updateState();
  }

  private renderTokenSyntaxEditor(controlEl: HTMLElement): () => void {
    const editor = controlEl.createDiv({ cls: 'variable-links-token-syntax-editor' });
    const fields = editor.createDiv({ cls: 'variable-links-token-syntax-fields' });
    const prefixLabel = fields.createEl('label', { text: 'Prefix' });
    const prefixInput = prefixLabel.createEl('input', {
      type: 'text',
      attr: {
        maxlength: String(MAX_TOKEN_DELIMITER_LENGTH),
        'aria-label': 'Variable link token prefix',
      },
    });
    const suffixLabel = fields.createEl('label', { text: 'Suffix' });
    const suffixInput = suffixLabel.createEl('input', {
      type: 'text',
      attr: {
        maxlength: String(MAX_TOKEN_DELIMITER_LENGTH),
        'aria-label': 'Variable link token suffix',
      },
    });
    const active = getTokenSyntax(this.variableLinksPlugin.settings);
    prefixInput.value = active.prefix;
    suffixInput.value = active.suffix;

    const preview = editor.createDiv({ cls: 'variable-links-token-syntax-preview' });
    const status = editor.createDiv({ cls: 'variable-links-token-syntax-status' });
    const applyButton = editor.createEl('button', {
      text: 'Use for new tokens',
      attr: { type: 'button' },
    });
    const legacy = editor.createDiv({ cls: 'variable-links-token-syntax-legacy' });
    const cleanups: Array<() => void> = [];
    let editorActive = true;

    const proposedSyntax = (): TokenSyntax => ({
      prefix: prefixInput.value,
      suffix: suffixInput.value,
    });
    const validationMessage = (syntax: TokenSyntax): { error?: string; warning?: string } => {
      if (!syntax.prefix.length || !syntax.suffix.length) {
        return { error: 'Prefix and suffix are required.' };
      }
      if (!syntax.prefix.trim().length || !syntax.suffix.trim().length) {
        return { error: 'Prefix and suffix cannot contain only whitespace.' };
      }
      if (/[\r\n]/.test(syntax.prefix + syntax.suffix)) {
        return { error: 'Prefix and suffix cannot contain line breaks.' };
      }
      if (syntax.prefix.length > MAX_TOKEN_DELIMITER_LENGTH
        || syntax.suffix.length > MAX_TOKEN_DELIMITER_LENGTH) {
        return { error: `Prefix and suffix can contain at most ${MAX_TOKEN_DELIMITER_LENGTH} characters.` };
      }
      if (syntax.prefix === syntax.suffix) {
        const mathWarning = syntax.prefix.includes('$')
          ? ' Dollar signs are also reserved for Markdown math.'
          : '';
        return { error: `Prefix and suffix must be different.${mathWarning}` };
      }
      const conflictingName = Array.from(this.variableLinksPlugin.registry?.data.keys() ?? [])
        .find((name) => name.includes(syntax.prefix) || name.includes(syntax.suffix));
      if (conflictingName) {
        return { error: `The existing variable “${conflictingName}” contains the proposed prefix or suffix.` };
      }

      const combined = syntax.prefix + syntax.suffix;
      if (combined.includes('$')) {
        return { warning: 'Dollar signs delimit inline and block math in Obsidian, so this token format will not work reliably.' };
      }
      if (/\[\[|\]\]|!\[|`|<!--|-->|\*|_|#/.test(combined)) {
        return { warning: 'This format may conflict with Markdown or Obsidian syntax. Test it carefully before migrating existing tokens.' };
      }
      if (/^\s|\s$/.test(syntax.prefix) || /^\s|\s$/.test(syntax.suffix)) {
        return { warning: 'Leading or trailing spaces are treated as literal parts of the token format.' };
      }
      if (syntax.prefix.includes(syntax.suffix) || syntax.suffix.includes(syntax.prefix)) {
        return { warning: 'Overlapping prefix and suffix text may make tokens difficult to recognize.' };
      }
      return {};
    };
    const updatePreview = (): void => {
      const syntax = proposedSyntax();
      const validation = validationMessage(syntax);
      preview.textContent = `Example: ${formatVariableToken('Variable', syntax)}`;
      status.textContent = validation.error ?? validation.warning ?? '';
      status.classList.toggle('is-error', Boolean(validation.error));
      status.classList.toggle('is-warning', !validation.error && Boolean(validation.warning));
      applyButton.disabled = Boolean(validation.error) || tokenSyntaxEquals(active, syntax);
    };

    const renderLegacyFormats = (): void => {
      legacy.empty();
      legacy.createEl('strong', { text: 'Previous formats' });
      const formats = this.variableLinksPlugin.settings.legacyTokenSyntaxes;
      if (!formats.length) {
        legacy.createSpan({ text: 'None', cls: 'mod-muted' });
        return;
      }
      for (const syntax of formats) {
        const row = legacy.createDiv({ cls: 'variable-links-token-syntax-legacy-row' });
        row.createEl('code', { text: formatVariableToken('Variable', syntax) });
        const removeButton = row.createEl('button', {
          text: 'Stop recognizing',
          attr: {
            type: 'button',
            'aria-label': `Stop recognizing ${formatVariableToken('Variable', syntax)}`,
          },
        });
        const remove = async (): Promise<void> => {
          removeButton.disabled = true;
          this.variableLinksPlugin.settings.legacyTokenSyntaxes = formats.filter(
            (candidate) => !tokenSyntaxEquals(candidate, syntax),
          );
          await this.variableLinksPlugin.saveSettings();
          await this.variableLinksPlugin.refreshAfterTokenSyntaxChange();
          if (editorActive) this.update();
        };
        const onRemove = (): void => void remove().catch((error: unknown) => {
          removeButton.disabled = false;
          new Notice(`Variable Links: could not remove the previous format: ${error instanceof Error ? error.message : String(error)}`);
        });
        removeButton.addEventListener('click', onRemove);
        cleanups.push(() => removeButton.removeEventListener('click', onRemove));
      }
    };

    const apply = async (): Promise<void> => {
      const next = proposedSyntax();
      const validation = validationMessage(next);
      if (validation.error || tokenSyntaxEquals(active, next)) return;
      const tokenCache = this.variableLinksPlugin.tokenCache;
      if (!tokenCache) throw new Error('The token cache is unavailable.');
      applyButton.disabled = true;
      applyButton.textContent = 'Preparing…';
      const plan = await tokenCache.prepareSyntaxMigration(active, next);
      const action = await new Promise<TokenSyntaxChangeAction>((resolve) => {
        new TokenSyntaxChangeModal(
          this.variableLinksPlugin,
          active,
          next,
          plan,
          resolve,
        ).open();
      });
      if (action === 'cancel' || !editorActive) {
        applyButton.disabled = false;
        applyButton.textContent = 'Use for new tokens';
        return;
      }

      const previousPrefix = this.variableLinksPlugin.settings.tokenPrefix;
      const previousSuffix = this.variableLinksPlugin.settings.tokenSuffix;
      const previousHistory = this.variableLinksPlugin.settings.legacyTokenSyntaxes.map(
        (syntax) => ({ ...syntax }),
      );
      let migrated = false;
      try {
        if (action === 'migrate') {
          await plan.apply();
          migrated = true;
        }
        const history = normalizeLegacyTokenSyntaxes(
          action === 'new-only'
            ? [active, ...previousHistory]
            : previousHistory,
          next,
        );
        this.variableLinksPlugin.settings.tokenPrefix = next.prefix;
        this.variableLinksPlugin.settings.tokenSuffix = next.suffix;
        this.variableLinksPlugin.settings.legacyTokenSyntaxes = history;
        await this.variableLinksPlugin.saveSettings();
        await this.variableLinksPlugin.refreshAfterTokenSyntaxChange();
      } catch (error) {
        if (migrated) await plan.rollback();
        this.variableLinksPlugin.settings.tokenPrefix = previousPrefix;
        this.variableLinksPlugin.settings.tokenSuffix = previousSuffix;
        this.variableLinksPlugin.settings.legacyTokenSyntaxes = previousHistory;
        try {
          await this.variableLinksPlugin.saveSettings();
          await this.variableLinksPlugin.refreshAfterTokenSyntaxChange();
        } catch {
          // Preserve the original migration error for the user.
        }
        throw error;
      }
      if (!editorActive) return;
      new Notice(action === 'migrate'
        ? `Variable Links: migrated ${plan.tokenCount} token${plan.tokenCount === 1 ? '' : 's'} to ${formatVariableToken('Variable', next)}.`
        : `Variable Links: new tokens now use ${formatVariableToken('Variable', next)}.`);
      this.update();
    };
    const onInput = (): void => updatePreview();
    const onApply = (): void => void apply().catch((error: unknown) => {
      applyButton.disabled = false;
      new Notice(`Variable Links: could not change the token format: ${error instanceof Error ? error.message : String(error)}`);
    });
    prefixInput.addEventListener('input', onInput);
    suffixInput.addEventListener('input', onInput);
    applyButton.addEventListener('click', onApply);
    cleanups.push(
      () => prefixInput.removeEventListener('input', onInput),
      () => suffixInput.removeEventListener('input', onInput),
      () => applyButton.removeEventListener('click', onApply),
    );
    updatePreview();
    renderLegacyFormats();
    return () => {
      editorActive = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }

  private renderSavedAppearanceColors(controlEl: HTMLElement): () => void {
    const palette = controlEl.createDiv({ cls: 'variable-links-settings-color-palette' });
    const cleanups: Array<() => void> = [];
    for (const [index, color] of this.variableLinksPlugin.settings.savedAppearanceColors.entries()) {
      const input = palette.createEl('input', {
        type: 'color',
        attr: { 'aria-label': `Saved color ${index + 1}` },
      });
      input.value = color;
      const onChange = (): void => {
        const next = [...this.variableLinksPlugin.settings.savedAppearanceColors];
        next[index] = normalizeAppearanceColor(input.value, color);
        this.variableLinksPlugin.settings.savedAppearanceColors = next;
        void this.variableLinksPlugin.saveSettings().then(() => {
          this.variableLinksPlugin.refreshPanelAppearanceSettings();
        });
      };
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }

  private renderTokenCacheUpdateButton(controlEl: HTMLElement): () => void {
    const button = controlEl.createEl('button', {
      text: 'Update',
      attr: { type: 'button' },
    });
    let active = true;
    const updateTokenCache = async (): Promise<void> => {
      const tokenCache = this.variableLinksPlugin.tokenCache;
      if (!tokenCache) {
        new Notice('Variable links: token cache is unavailable.');
        return;
      }
      button.disabled = true;
      button.textContent = 'Updating…';
      try {
        await tokenCache.rebuild();
        if (active) new Notice('Variable links: token cache updated.');
      } catch (error) {
        if (active) {
          new Notice(`Variable links: token cache update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (active) {
          button.disabled = false;
          button.textContent = 'Update';
        }
      }
    };
    const onClick = (): void => {
      void updateTokenCache();
    };
    button.addEventListener('click', onClick);
    return () => {
      active = false;
      button.removeEventListener('click', onClick);
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unknown error occurred.';
}

export default VariableLinksSettingTab;
