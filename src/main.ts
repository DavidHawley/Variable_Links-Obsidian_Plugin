import { App, Plugin } from 'obsidian';
import { VariableLinksSettingTab, VariableLinksSettings, DEFAULT_SETTINGS } from './settings';
import { Registry } from './registry';
import Indexer from './indexer';
import Resolver from './resolver';
import Renderer from './renderer';
import VariableSuggest from './suggest';

export default class VariableLinksPlugin extends Plugin {
  settings!: VariableLinksSettings;
  registry: Registry | null = null;
  indexer: Indexer | null = null;
  resolver: Resolver | null = null;
  renderer: Renderer | null = null;
  suggest: any = null;

  async onload() {
    console.log('Loading Variable Links plugin...');
    await this.loadSettings();

    this.addSettingTab(new VariableLinksSettingTab(this.app, this));

    this.registry = new Registry(this.app, this);
    await this.registry.load();

    this.indexer = new Indexer(this.app, this.registry);
    await this.indexer.build();

    this.resolver = new Resolver(this.app, this.registry);

    this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
    // register markdown post processor using plugin API so it actually runs
    if (typeof this.registerMarkdownPostProcessor === 'function') {
      this.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => {
        return this.renderer?.processElement(el);
      });
    } else {
      // fallback: try renderer's own register (older code)
      try { this.renderer.register(); } catch (e) { /* ignore */ }
    }

    // register suggest if enabled
    if (this.settings) {
      if ((this.settings as any).autocomplete !== false) {
        this.suggest = new VariableSuggest(this.app, this.indexer, this.registry);
        // register EditorSuggest using plugin API if available
        if (typeof this.registerEditorSuggest === 'function') {
          try { this.registerEditorSuggest(this.suggest); } catch (e) { /* ignore */ }
        }
      }
    }

    // watch registry reloads to rebuild index
    const reloadIndex = async () => { if (this.indexer) await this.indexer.build(); };
    // listen to vault modify events so we can update index when registry changed
    this.app.vault.on('modify', (file: any) => {
      if (this.registry?.registryFile && file.path === this.registry.registryFile.path) {
        setTimeout(reloadIndex, 100);
      }
    });

    console.log('Variable Links loaded');
  }

  onunload() {
    this.registry?.unload();
    console.log('Variable Links unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
