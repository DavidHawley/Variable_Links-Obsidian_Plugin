import { App, Notice, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import {
  DEFAULT_APPEARANCE_COLORS,
  normalizeAppearanceColor,
  normalizeAppearanceOpacity,
  type VariableDecoration,
} from './appearance';
import VariableLinksPlugin from './main';

export interface VariableLinksSettings {
  registryFilePath: string;
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
  infoCardEditorWidth: number | null;
  infoCardEditorHeight: number | null;
  infoCardEditorCollapsedItems: Record<string, string[]>;
}

type SettingKey = keyof VariableLinksSettings;

export const DEFAULT_SETTINGS: VariableLinksSettings = {
  registryFilePath: '',
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
  infoCardEditorWidth: null,
  infoCardEditorHeight: null,
  infoCardEditorCollapsedItems: {},
};

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
        type: 'group',
        heading: 'Default variable appearance',
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
        name: 'Default date format',
        desc: 'Format used for date properties when a variable does not specify one.',
        control: {
          type: 'text',
          key: 'defaultDateFormat',
          placeholder: 'YYYY-MM-DD',
        },
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
      || key === 'infoCardEditorCollapsedItems') return;

    if (key === 'registryFilePath' || key === 'defaultDateFormat') {
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
}

export default VariableLinksSettingTab;
