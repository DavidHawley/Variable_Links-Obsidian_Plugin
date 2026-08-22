import { App, Notice, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import VariableLinksPlugin from './main';

export interface VariableLinksSettings {
  registryFilePath: string;
  enableInfoCards: boolean;
  openInNewPane: boolean;
  suggestionFuzzy: boolean;
  defaultDateFormat: string;
}

type SettingKey = keyof VariableLinksSettings;

export const DEFAULT_SETTINGS: VariableLinksSettings = {
  registryFilePath: '',
  enableInfoCards: true,
  openInNewPane: false,
  suggestionFuzzy: true,
  defaultDateFormat: 'YYYY-MM-DD',
};

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
        name: 'Enable info cards',
        desc: 'Show info cards when hovering over rendered variables.',
        control: { type: 'toggle', key: 'enableInfoCards' },
      },
      {
        name: 'Open source in new pane',
        desc: 'Open the source file in a new pane when clicking a rendered variable.',
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

    if (key === 'registryFilePath' || key === 'defaultDateFormat') {
      if (typeof value !== 'string') return;
      this.variableLinksPlugin.settings[key] = value.trim();
    } else {
      if (typeof value !== 'boolean') return;
      this.variableLinksPlugin.settings[key] = value;
    }

    await this.variableLinksPlugin.saveSettings();
    if (key === 'registryFilePath') {
      try {
        await this.variableLinksPlugin.registry?.load();
      } catch (error) {
        new Notice(`Failed to load registry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private isSettingKey(key: string): key is SettingKey {
    return key in DEFAULT_SETTINGS;
  }
}

export default VariableLinksSettingTab;
