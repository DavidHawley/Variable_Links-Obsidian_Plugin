import { App, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
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
  caretTracker: any = null;
  private settingTab: VariableLinksSettingTab | null = null;
  private active = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private contextMenuCleanups: Array<() => void> = [];
  private vaultModifyHandler: ((file: any) => void) | null = null;
  private editorMenuHandler: ((menu: any, editor: any) => void) | null = null;
  private contextMenuHandler: ((event: MouseEvent) => void) | null = null;
  private lastContextClick: { x: number; y: number; target: any; time: number } | null = null;

  async onload() {
    this.active = true;
    try {
      await this.loadSettings();
      if (!this.active) return;
      this.settingTab = new VariableLinksSettingTab(this.app, this);
      this.addSettingTab(this.settingTab);

      // Initialize registry/indexer/resolver/renderer with defensive try/catch so one failure doesn't break plugin
      try {
        this.registry = new Registry(this.app, this);
        await this.registry.load();
        if (!this.active) return;
      } catch (e) {
        try { const N = (globalThis as any).Notice; if (typeof N === 'function') new N('Variable Links: registry failed to load.'); } catch (e) { }
      }

      try {
        this.indexer = new Indexer(this.app, this.registry!);
        await this.indexer.build();
        if (!this.active) return;
      } catch (e) {}

      try {
        this.tokenCache = new TokenCache(this.app, this, this.registry!);
        await this.tokenCache.initialize();
        if (!this.active) return;
      } catch (e) {}

      try {
        this.resolver = new Resolver(this.app, this.registry!);
      } catch (e) {}

      try {
        if (typeof this.registerMarkdownPostProcessor !== 'function') {
          throw new Error('registerMarkdownPostProcessor is unavailable.');
        }
        this.renderer = new Renderer(this.app, this.registry!, this.resolver!, this.indexer!);
        this.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => {
          try { return this.renderer?.processElement(el); } catch (err) {}
        });
      } catch (e) {}

      // Use native CodeMirror decorations in Live Preview. Unlike positioned
      // overlays, they replace the text in the editor's normal layout.
      try {
        if (typeof (this as any).registerEditorExtension !== 'function') throw new Error('registerEditorExtension is unavailable.');
        this.livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver!);
        (this as any).registerEditorExtension(this.livePreviewRenderer.createExtension());
        const refreshOpenViews = () => {
          if (this.active) this.livePreviewRenderer?.refresh();
        };
        this.schedule(refreshOpenViews, 0);
      } catch (e) {}

      try {
        // register view
        const panelMod = await import('./panel');
        if (!this.active) return;
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
        if (!this.active) return;
        const ct = new CaretTracker(this.app, this, this.registry!, this.resolver!);
        ct.start();
        this.caretTracker = ct;
      } catch (e) {}

      // register suggest if enabled
      try {
        if (this.settings) {
          if ((this.settings as any).autocomplete !== false) {
                this.suggest = new VariableSuggest(this.app, this.indexer!, this.registry!);
                if (typeof this.registerEditorSuggest === 'function') {
                  try { this.registerEditorSuggest(this.suggest); }
                  catch (e) {}
                }
              }
        }
      } catch (e) {}

      // watch registry reloads to rebuild index
      const reloadIndex = async () => {
        if (this.active && this.indexer) await this.indexer.build();
      };
      // listen to vault modify events so we can update index when registry changed
      try {
        this.vaultModifyHandler = (file: any) => {
          if (!this.active) return;
          try {
            if (this.registry?.registryFile && file.path === this.registry.registryFile.path) {
              this.schedule(() => void reloadIndex(), 100);
            }
          } catch (e) {}
        };
        const modifyRef = this.app.vault.on('modify', this.vaultModifyHandler);
        if (typeof (this as any).registerEvent === 'function') (this as any).registerEvent(modifyRef);
      } catch (e) {}

      // expose helper for panel: when caret tracker notifies, refresh any open panel views
      (this as any).onCaretVariableChanged = (last: any) => {
        if (!this.active) return;
        try {
          import('./panel').then(async (mod) => {
            if (!this.active) return;
            try {
              const leaves = this.app.workspace.getLeavesOfType(mod.VIEW_TYPE_VARIABLE_PANEL);
              if (leaves && leaves.length > 0) {
                for (let i = 0; i < leaves.length; i++) {
                  if (!this.active) return;
                  try {
                    const view = (leaves[i] as any).view;
                    if (view && typeof view.refresh === 'function') {
                      await view.refresh();
                    } else if (view && typeof view.renderContent === 'function') {
                      await view.renderContent();
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
          });
        } catch (e) {}
      };
    } catch (e) {
      try { const N = (globalThis as any).Notice; if (typeof N === 'function') new N('Variable Links failed to load: ' + String(e)); } catch {}
    }
  }

  onunload() {
    this.active = false;
    if (this.vaultModifyHandler) {
      try { this.app.vault.off('modify', this.vaultModifyHandler); } catch (error) {}
      this.vaultModifyHandler = null;
    }
    if (this.editorMenuHandler) {
      try { (this.app.workspace as any).off('editor-menu', this.editorMenuHandler); } catch (error) {}
      this.editorMenuHandler = null;
    }
    if (this.contextMenuHandler) {
      try { document.removeEventListener('contextmenu', this.contextMenuHandler, true); } catch (error) {}
      this.contextMenuHandler = null;
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearContextMenuResources();
    this.settingTab?.dispose();
    this.lastContextClick = null;
    try { this.suggest?.close?.(); } catch (error) {}
    this.caretTracker?.stop();
    this.tokenCache?.stop();
    this.registry?.unload();
    this.renderer?.unload();
    this.livePreviewRenderer?.unload();

    // Explicitly close plugin-owned views. registerView removes the factory,
    // while this removes already-created ItemView instances and their DOM.
    try {
      const viewType = 'variable-links-panel';
      (this.app.workspace as any).detachLeavesOfType?.(viewType);
    } catch (error) {}

    (this as any).onCaretVariableChanged = undefined;
    this.caretTracker = null;
    this.tokenCache = null;
    this.registry = null;
    this.renderer = null;
    this.livePreviewRenderer = null;
    this.resolver = null;
    this.indexer = null;
    this.suggest = null;
    this.settingTab = null;
  }

  private schedule(callback: () => void, delay: number) {
    if (!this.active) return null;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.active) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    const configDir = this.app.vault.configDir;
    const pluginId = (this as any).manifest?.id || 'variable-links';
    const defaultRegistryPath = `${configDir}/plugins/${pluginId}/registry.json`;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, { registryFilePath: defaultRegistryPath }, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async openVariableProperties(variableName?: string) {
    if (!this.active) return;
    const panelMod = await import('./panel');
    if (!this.active) return;
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(panelMod.VIEW_TYPE_VARIABLE_PANEL)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) throw new Error('A sidebar could not be opened.');
      await leaf.setViewState({ type: panelMod.VIEW_TYPE_VARIABLE_PANEL });
    }
    if (variableName && leaf.view instanceof panelMod.VariablePropertiesView) {
      await leaf.view.selectVariable(variableName);
    }
    this.app.workspace.revealLeaf(leaf);
  }

  private registerVariableContextMenu() {
    if (typeof (this as any).registerDomEvent === 'function') {
      this.contextMenuHandler = (event: MouseEvent) => {
        if (!this.active) return;
        this.lastContextClick = {
          x: event.clientX,
          y: event.clientY,
          target: event.target,
          time: Date.now()
        };
      };
      (this as any).registerDomEvent(document, 'contextmenu', this.contextMenuHandler, true);
    }

    this.editorMenuHandler = (menu: any, editor: any) => {
      if (!this.active) return;
      this.clearContextMenuResources();
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
    };
    const eventRef = (this.app.workspace as any).on('editor-menu', this.editorMenuHandler);
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMouseEnter = () => {
      const current = parentMenu?.currentSubmenu;
      if (!current || current === itemSubmenu) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!this.active || !itemElement.isConnected || !itemElement.matches?.(':hover')) return;
        try {
          if (typeof parentMenu.closeSubmenu === 'function') parentMenu.closeSubmenu();
          else if (typeof current.hide === 'function') current.hide();
          try { parentMenu.currentSubmenu = null; } catch (_) {}

          const MouseEventCtor = itemElement.ownerDocument?.defaultView?.MouseEvent || MouseEvent;
          itemElement.dispatchEvent(new MouseEventCtor('mouseover', { bubbles: true, cancelable: true }));
        } catch (error) {}
      }, 300);
    };
    const onMouseLeave = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    };
    itemElement.addEventListener('mouseenter', onMouseEnter);
    itemElement.addEventListener('mouseleave', onMouseLeave);
    this.contextMenuCleanups.push(() => {
      if (timer) clearTimeout(timer);
      timer = null;
      itemElement.removeEventListener('mouseenter', onMouseEnter);
      itemElement.removeEventListener('mouseleave', onMouseLeave);
    });
  }

  private clearContextMenuResources() {
    for (const cleanup of this.contextMenuCleanups.splice(0)) {
      try { cleanup(); } catch (error) {}
    }
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
        if (leaf.view instanceof panelMod.VariablePropertiesView) await leaf.view.refresh();
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
