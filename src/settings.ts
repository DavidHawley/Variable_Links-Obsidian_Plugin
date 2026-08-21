import { App, PluginSettingTab, Setting, TFile, FuzzySuggestModal, Notice } from 'obsidian';
import VariableLinksPlugin from './main';

export interface VariableLinksSettings {
  registryFilePath: string;
  enableInfoCards: boolean;
  openInNewPane: boolean;
  suggestionFuzzy: boolean;
  defaultDateFormat: string;
}

export const DEFAULT_SETTINGS: VariableLinksSettings = {
  registryFilePath: '.obsidian/plugins/variable-links/registry.json',
  enableInfoCards: true,
  openInNewPane: false,
  suggestionFuzzy: true,
  defaultDateFormat: 'YYYY-MM-DD'
};

class FilePickerModal extends FuzzySuggestModal<TFile> {
  app: App;
  onChoose: (file: TFile) => void;
  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.app = app;
    this.onChoose = onChoose;
    this.setPlaceholder('Select a file to use as the registry');
  }
  getItems(): TFile[] {
    return (this.app.vault as any).getFiles();
  }
  getItemText(item: TFile): string {
    return item.path;
  }
  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

export class VariableLinksSettingTab extends PluginSettingTab {
  plugin: VariableLinksPlugin;
  private activeModal: FilePickerModal | null = null;
  private disposed = false;

  constructor(app: App, plugin: VariableLinksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    if (this.disposed) return;
    const containerEl: any = (this as any).containerEl;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Variable Links — Settings' });

    new Setting(containerEl)
      .setName('Registry file')
      .setDesc('JSON, YAML, or Markdown registry. The default is a hidden registry.json in this plugin folder.')
      .addText((text: any) =>
        text
          .setPlaceholder('.obsidian/plugins/variable-links/registry.json')
          .setValue(this.plugin.settings.registryFilePath)
          .onChange(async (value: string) => {
            this.plugin.settings.registryFilePath = value.trim();
            await this.plugin.saveSettings();
            // attempt to reload registry
            try {
              await this.plugin.registry?.load();
            } catch (e) {
              new Notice('Failed to load registry: ' + String(e));
            }
          })
      )
      .addButton((btn: any) =>
        btn.setButtonText('Choose...').onClick(() => {
          if (this.disposed) return;
          this.activeModal?.close();
          const modal = new FilePickerModal((this as any).app, async (file) => {
            this.activeModal = null;
            if (this.disposed) return;
            this.plugin.settings.registryFilePath = file.path;
            await this.plugin.saveSettings();
            modal.close();
            try {
              await this.plugin.registry?.load();
              new Notice('Registry loaded: ' + file.path);
            } catch (e) {
              new Notice('Failed to load registry: ' + String(e));
            }
            this.display();
          });
          this.activeModal = modal;
          modal.open();
        })
      );

    new Setting(containerEl)
      .setName('Enable info cards')
      .setDesc('Show info cards on hover over rendered variables')
      .addToggle((t: any) => t.setValue(this.plugin.settings.enableInfoCards).onChange(async (v: any)=>{ this.plugin.settings.enableInfoCards = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Open source in new pane')
      .setDesc('Open the source file in a new pane when clicking rendered variables')
      .addToggle((t: any) => t.setValue(this.plugin.settings.openInNewPane).onChange(async (v: any)=>{ this.plugin.settings.openInNewPane = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Suggestion fuzzy matching')
      .setDesc('Allow fuzzy matching for suggestions (variable name, display, source file, property)')
      .addToggle((t: any) => t.setValue(this.plugin.settings.suggestionFuzzy).onChange(async (v: any)=>{ this.plugin.settings.suggestionFuzzy = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Default date format')
      .setDesc('Format used for date properties if not specified per-variable')
      .addText((t: any) => t.setValue(this.plugin.settings.defaultDateFormat).onChange(async (v: any)=>{ this.plugin.settings.defaultDateFormat = v; await this.plugin.saveSettings(); }));
  }

  dispose() {
    this.disposed = true;
    this.activeModal?.close();
    this.activeModal = null;
    try { (this as any).containerEl?.empty?.(); } catch (error) {}
  }
}

export default VariableLinksSettingTab;
