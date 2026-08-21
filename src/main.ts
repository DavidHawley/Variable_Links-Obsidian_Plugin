import { App, Plugin } from 'obsidian';
import { VariableLinksSettingTab, VariableLinksSettings, DEFAULT_SETTINGS } from './settings';
import { Registry } from './registry';
import Indexer from './indexer';
import Resolver from './resolver';
import Renderer from './renderer';
import VariableSuggest from './suggest';
import LivePreviewRenderer from './livePreviewRenderer';
import TokenCache from './tokenCache';

export default class VariableLinksPlugin extends Plugin {
  settings!: VariableLinksSettings;
  registry: Registry | null = null;
  indexer: Indexer | null = null;
  resolver: Resolver | null = null;
  renderer: Renderer | null = null;
  livePreviewRenderer: LivePreviewRenderer | null = null;
  tokenCache: TokenCache | null = null;
  suggest: any = null;

  async onload() {
    console.log('Variable Links: onload start');
    try {
      await this.loadSettings();
      console.log('Variable Links: settings loaded', this.settings);
      this.addSettingTab(new VariableLinksSettingTab(this.app, this));

      // Initialize registry/indexer/resolver/renderer with defensive try/catch so one failure doesn't break plugin
      try {
        this.registry = new Registry(this.app, this);
        await this.registry.load();
        console.log('Variable Links: registry loaded');
      } catch (e) {
        console.error('Variable Links: registry failed to load', e);
        try { const N = (globalThis as any).Notice; if (typeof N === 'function') new N('Variable Links: registry failed to load. See console for details.'); } catch (e) { }
      }

      try {
        this.indexer = new Indexer(this.app, this.registry!);
        await this.indexer.build();
        console.log('Variable Links: index built');
      } catch (e) {
        console.error('Variable Links: indexer failed', e);
      }

      try {
        this.tokenCache = new TokenCache(this.app, this, this.registry!);
        await this.tokenCache.initialize();
        console.log('Variable Links: token cache initialized');
      } catch (e) {
        console.error('Variable Links: token cache failed to initialize', e);
      }

      try {
        this.resolver = new Resolver(this.app, this.registry!);
        console.log('Variable Links: resolver initialized');
      } catch (e) {
        console.error('Variable Links: resolver failed', e);
      }

      try {
        this.renderer = new Renderer(this.app, this.registry!, this.resolver!, this.indexer!);
        // register markdown post processor using plugin API so it actually runs
        if (typeof this.registerMarkdownPostProcessor === 'function') {
          this.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => {
            try { return this.renderer?.processElement(el); } catch (err) { console.error('renderer.processElement error', err); }
          });
        } else {
          // fallback: try renderer's own register (older code)
          try { this.renderer.register(); } catch (e) { console.warn('renderer.register fallback failed', e); }
        }
        console.log('Variable Links: renderer registered');
      } catch (e) {
        console.error('Variable Links: renderer failed', e);
      }

      // Use native CodeMirror decorations in Live Preview. Unlike positioned
      // overlays, they replace the text in the editor's normal layout.
      try {
        if (typeof (this as any).registerEditorExtension !== 'function') throw new Error('registerEditorExtension is unavailable.');
        this.livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver!);
        (this as any).registerEditorExtension(this.livePreviewRenderer.createExtension());
        const refreshOpenViews = () => this.livePreviewRenderer?.refresh();
        if (typeof (this.app.workspace as any).onLayoutReady === 'function') {
          (this.app.workspace as any).onLayoutReady(refreshOpenViews);
        }
        setTimeout(refreshOpenViews, 0);
        console.log('Variable Links: live preview renderer attached');
      } catch (e) {
        console.warn('Variable Links: failed to attach live preview renderer', e);
      }

      try {
        // register view
        const panelMod = await import('./panel');
        (this as any).registerView(panelMod.VIEW_TYPE_VARIABLE_PANEL, (leaf: any) =>
          new panelMod.VariablePropertiesView(leaf, this)
        );
        (this as any).addCommand({
          id: 'open-variable-properties',
          name: 'Open Variable Properties',
          callback: async () => {
            const right = this.app.workspace.getRightLeaf(false);
            await right.setViewState({ type: panelMod.VIEW_TYPE_VARIABLE_PANEL });
            this.app.workspace.revealLeaf(right);
          }
        });

        // start caret tracker
        const CaretTracker = (await import('./caretTracker')).default;
        const ct = new CaretTracker(this.app, this, this.registry!, this.resolver!);
        ct.start();
        (this as any).caretTracker = ct;
        console.log('Variable Links: caret tracker started and panel registered');
      } catch (e) {
        console.warn('Variable Links: failed to initialize caret tracker/panel', e);
      }

      // register suggest if enabled
      try {
        if (this.settings) {
          if ((this.settings as any).autocomplete !== false) {
                this.suggest = new VariableSuggest(this.app, this.indexer!, this.registry!);
                if (typeof this.registerEditorSuggest === 'function') {
                  try { this.registerEditorSuggest(this.suggest); console.log('Variable Links: suggest registered via registerEditorSuggest'); }
                  catch (e) { console.warn('registerEditorSuggest failed', e); }
                }
                else {
                  console.log('Variable Links: registerEditorSuggest missing; suggest not registered');
                }
              }
        }
      } catch (e) { console.error('Variable Links: suggest failed', e); }

      // watch registry reloads to rebuild index
      const reloadIndex = async () => { if (this.indexer) await this.indexer.build(); };
      // listen to vault modify events so we can update index when registry changed
      try {
        this.app.vault.on('modify', (file: any) => {
          try {
            if (this.registry?.registryFile && file.path === this.registry.registryFile.path) {
              setTimeout(reloadIndex, 100);
            }
          } catch (e) { console.error('modify handler error', e); }
        });
      } catch (e) { console.error('Failed to register vault.modify handler', e); }

      // expose helper for panel: when caret tracker notifies, refresh any open panel views
      (this as any).onCaretVariableChanged = (last: any) => {
        // TypeScript hint: ensure caretTracker typed access available in this scope
        const _self = (this as any);
        try {
          console.log('Variable Links: onCaretVariableChanged', last?.name);
          import('./panel').then(async (mod) => {
            try {
              const leaves = this.app.workspace.getLeavesOfType(mod.VIEW_TYPE_VARIABLE_PANEL);
              console.log('Variable Links: panel leaves found', leaves?.length);
              if (leaves && leaves.length > 0) {
                for (let i = 0; i < leaves.length; i++) {
                  try {
                    const view = (leaves[i] as any).view;
                    console.log('Variable Links: refreshing panel leaf', i, 'view present', !!view, 'has refresh', typeof view?.refresh === 'function');
                    if (view && typeof view.refresh === 'function') {
                      await view.refresh();
                    } else if (view && typeof view.renderContent === 'function') {
                      await view.renderContent();
                    } else {
                      // Fallback: try to directly render into the leaf/container element
                      try {
                        const container = leaves[i].containerEl || (view && view.containerEl) || (view && view.containerElInner) || null;
                        let inner = null;
                        if (container) {
                          inner = container.querySelector?.('.variable-links-panel-inner') || container.querySelector?.('.variable-links-panel') || null;
                          if (!inner) {
                            // create an inner container
                            inner = document.createElement('div');
                            inner.className = 'variable-links-panel-inner';
                            if (container.appendChild) container.appendChild(inner);
                          }
                        }
                        if (inner) {
                          // render simple content mirroring renderContent()
                          const last = _self.caretTracker ? _self.caretTracker.lastTouched : null;
                          if (!last) {
                            inner.textContent = 'No variable selected.';
                          } else {
                            inner.innerHTML = '';
                            const h = document.createElement('h4'); h.textContent = `{{${last.name}}}`; inner.appendChild(h);
                            const valDiv = document.createElement('div'); valDiv.className = 'variable-links-panel-value'; inner.appendChild(valDiv);
                            const valueText = last.value === undefined ? '[Missing]' : String(last.value);
                            try { await this.app.markdownRenderer?.renderMarkdown(valueText, valDiv, '', this); }
                            catch (e) {
                              try { await (this.app as any).markdownRenderer?.renderMarkdown(valueText, valDiv, '', this); }
                              catch (e2) { valDiv.textContent = valueText; }
                            }
                          }
                        }
                      } catch (e) { console.error('Variable Links: DOM fallback render failed for leaf', i, e); }
                    }
                  } catch (e) { console.error('Variable Links: error refreshing leaf', i, e); }
                }
              }
            } catch (e) { console.error('Variable Links: error notifying panel', e); }
          });
        } catch (e) { console.error('Variable Links: onCaretVariableChanged top-level error', e); }
      };

      console.log('Variable Links: onload complete');
    } catch (e) {
      console.error('Variable Links: onload top-level error', e);
      try { const N = (globalThis as any).Notice; if (typeof N === 'function') new N('Variable Links failed to load: ' + String(e)); } catch {}
    }
  }

  onunload() {
    this.tokenCache?.stop();
    this.registry?.unload();
    console.log('Variable Links unloaded');
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    const configDir = (this.app.vault as any).configDir || '.obsidian';
    const pluginId = (this as any).manifest?.id || 'variable-links';
    const defaultRegistryPath = `${configDir}/plugins/${pluginId}/registry.json`;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, { registryFilePath: defaultRegistryPath }, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
