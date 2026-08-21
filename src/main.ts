import { App, Notice, Plugin } from 'obsidian';
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
  private lastContextClick: { x: number; y: number; target: any; time: number } | null = null;

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
          callback: () => this.openVariableProperties()
        });
        this.registerVariableContextMenu();

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

  async openVariableProperties(variableName?: string) {
    const panelMod = await import('./panel');
    let leaf = this.app.workspace.getLeavesOfType(panelMod.VIEW_TYPE_VARIABLE_PANEL)?.[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) throw new Error('A sidebar could not be opened.');
      await leaf.setViewState({ type: panelMod.VIEW_TYPE_VARIABLE_PANEL });
    }
    if (variableName && typeof leaf.view?.selectVariable === 'function') {
      await leaf.view.selectVariable(variableName);
    }
    this.app.workspace.revealLeaf(leaf);
  }

  private registerVariableContextMenu() {
    if (typeof (this as any).registerDomEvent === 'function') {
      (this as any).registerDomEvent(document, 'contextmenu', (event: MouseEvent) => {
        this.lastContextClick = {
          x: event.clientX,
          y: event.clientY,
          target: event.target,
          time: Date.now()
        };
      }, true);
    }

    const eventRef = (this.app.workspace as any).on('editor-menu', (menu: any, editor: any) => {
      const variableName = this.getContextVariableName(editor);
      const insertionPosition = this.getContextEditorPosition(editor);
      const definition = variableName ? this.registry?.getVariable(variableName) : null;
      const isFavorite = definition?.favorite === true;
      const favorites = Array.from(this.registry?.data?.entries?.() || [])
        .filter((entry: any) => entry[1]?.favorite === true)
        .map((entry: any) => String(entry[0]))
        .sort((a, b) => a.localeCompare(b));
      const allLinks = Array.from(this.registry?.data?.keys?.() || [])
        .map((name: any) => String(name))
        .sort((a, b) => a.localeCompare(b));
      menu.addItem((parentItem: any) => {
        parentItem.setTitle('Variable Links').setIcon('braces');
        if (typeof parentItem.setSubmenu === 'function') {
          const submenu = parentItem.setSubmenu();
          submenu.addItem((item: any) => {
            item.setTitle('Properties').setIcon('list').setDisabled(!variableName);
            if (variableName) item.onClick(() => void this.openVariableProperties(variableName));
          });
          submenu.addItem((item: any) => {
            item
              .setTitle(isFavorite ? 'Unfavorite' : 'Favorite')
              .setIcon('star')
              .setDisabled(!definition);
            if (definition && variableName) {
              item.onClick(() => void this.setVariableFavorite(variableName, !isFavorite));
            }
          });
          if (typeof submenu.addSeparator === 'function') submenu.addSeparator();
          submenu.addItem((insertItem: any) => {
            insertItem.setTitle('Insert Favorite').setIcon('text-cursor-input').setDisabled(!favorites.length);
            if (!favorites.length || typeof insertItem.setSubmenu !== 'function') return;
            const favoritesMenu = insertItem.setSubmenu();
            this.enableNestedSubmenuSwitch(submenu, insertItem, favoritesMenu);
            for (const favoriteName of favorites) {
              favoritesMenu.addItem((item: any) => item
                .setTitle(favoriteName)
                .setIcon('star')
                .onClick(() => this.insertVariable(editor, favoriteName, insertionPosition)));
            }
          });
          submenu.addItem((insertItem: any) => {
            insertItem.setTitle('Insert').setIcon('text-cursor-input').setDisabled(!allLinks.length);
            if (!allLinks.length || typeof insertItem.setSubmenu !== 'function') return;
            const linksMenu = insertItem.setSubmenu();
            this.enableNestedSubmenuSwitch(submenu, insertItem, linksMenu);
            for (const linkName of allLinks) {
              linksMenu.addItem((item: any) => item
                .setTitle(linkName)
                .onClick(() => this.insertVariable(editor, linkName, insertionPosition)));
            }
          });
          return;
        }

        // Older Obsidian versions do not expose nested menu items.
        parentItem
          .setTitle('Variable Links: Properties')
          .setDisabled(!variableName);
        if (variableName) parentItem.onClick(() => void this.openVariableProperties(variableName));
      });
    });
    if (typeof (this as any).registerEvent === 'function') (this as any).registerEvent(eventRef);
  }

  private getContextVariableName(editor: any): string | null {
    const click = this.lastContextClick;
    const recentClick = click && Date.now() - click.time < 1000 ? click : null;
    if (recentClick) {
      const tokenElement = recentClick.target?.closest?.('.variable-links-token[data-var]');
      const renderedName = tokenElement?.dataset?.var?.trim();
      if (renderedName) return renderedName;

      return this.getVariableAtPosition(editor, this.getContextEditorPosition(editor));
    }

    return this.getVariableAtPosition(editor, editor?.getCursor?.());
  }

  private getVariableAtPosition(editor: any, position: any): string | null {
    if (!position || typeof position.line !== 'number' || typeof position.ch !== 'number') return null;
    const line = editor?.getLine?.(position.line);
    if (typeof line !== 'string') return null;
    const pattern = /\{\{\s*([^\}\s]+)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (position.ch >= match.index && position.ch <= pattern.lastIndex) return match[1].trim();
    }
    return null;
  }

  private getContextEditorPosition(editor: any): any | null {
    const click = this.lastContextClick;
    const recentClick = click && Date.now() - click.time < 1000 ? click : null;
    if (!recentClick) return editor?.getCursor?.() || null;
    if (!recentClick.target?.closest?.('.cm-editor')) return null;
    const offset = editor?.cm?.posAtCoords?.({ x: recentClick.x, y: recentClick.y });
    if (typeof offset !== 'number') return null;
    return typeof editor.offsetToPos === 'function'
      ? editor.offsetToPos(offset)
      : this.positionFromOffset(editor.getValue(), offset);
  }

  private insertVariable(editor: any, variableName: string, contextPosition?: any) {
    const position = contextPosition || editor?.getCursor?.();
    if (!position || typeof editor?.replaceRange !== 'function') {
      new Notice('Variable Links: the insertion position is unavailable.');
      return;
    }
    editor.replaceRange(`{{${variableName}}}`, position);
  }

  /** Work around Obsidian retaining the first open sibling sub-submenu. */
  private enableNestedSubmenuSwitch(parentMenu: any, item: any, itemSubmenu: any) {
    const itemElement = item?.dom;
    if (!itemElement?.addEventListener) return;
    itemElement.addEventListener('mouseover', () => {
      const current = parentMenu?.currentSubmenu;
      if (!current || current === itemSubmenu) return;
      try {
        if (typeof parentMenu.closeSubmenu === 'function') parentMenu.closeSubmenu();
        else if (typeof current.hide === 'function') current.hide();
      } catch (error) {
        console.warn('Variable Links: failed to switch insert submenu', error);
      }
      try { parentMenu.currentSubmenu = null; } catch (_) {}
    }, { capture: true });
  }

  private async setVariableFavorite(variableName: string, favorite: boolean) {
    const definition = this.registry?.getVariable(variableName);
    if (!definition || !this.registry) {
      new Notice(`Variable Links: {{${variableName}}} is not configured.`);
      return;
    }
    try {
      await this.registry.saveVariable(variableName, { ...definition, favorite });
      const panelMod = await import('./panel');
      for (const leaf of this.app.workspace.getLeavesOfType(panelMod.VIEW_TYPE_VARIABLE_PANEL) || []) {
        if (typeof leaf.view?.refresh === 'function') await leaf.view.refresh();
      }
      new Notice(`Variable Links: ${favorite ? 'favorited' : 'unfavorited'} {{${variableName}}}`);
    } catch (error) {
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private positionFromOffset(text: string, offset: number) {
    const before = text.slice(0, offset).split(/\r?\n/);
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
}
