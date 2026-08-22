import {
  Editor,
  EditorPosition,
  Menu,
  MenuItem,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import CaretTracker, { LastTouched } from './caretTracker';
import {
  normalizeAppearanceColor,
  normalizeAppearanceColors,
  normalizeAppearanceOpacity,
} from './appearance';
import Indexer from './indexer';
import LivePreviewRenderer from './livePreviewRenderer';
import { Registry } from './registry';
import Renderer from './renderer';
import Resolver from './resolver';
import {
  DEFAULT_SETTINGS,
  normalizeLivePreviewHoverDelay,
  normalizeReadingViewHoverDelay,
  VariableLinksSettings,
  VariableLinksSettingTab,
} from './settings';
import VariableSuggest from './suggest';
import TokenCache from './tokenCache';

interface EditorWithCoordinates extends Editor {
  cm?: {
    posAtCoords?: (coordinates: { x: number; y: number }) => number | null;
  };
}

interface MenuItemWithSubmenu extends MenuItem {
  setSubmenu(): Menu;
  dom?: HTMLElement;
}

interface MenuWithSubmenuState extends Menu {
  currentSubmenu?: Menu;
  closeSubmenu?: () => void;
}

interface ContextClick {
  x: number;
  y: number;
  target: Element | null;
  time: number;
}

export default class VariableLinksPlugin extends Plugin {
  settings: VariableLinksSettings = { ...DEFAULT_SETTINGS };
  registry: Registry | null = null;
  indexer: Indexer | null = null;
  resolver: Resolver | null = null;
  renderer: Renderer | null = null;
  livePreviewRenderer: LivePreviewRenderer | null = null;
  tokenCache: TokenCache | null = null;
  suggest: VariableSuggest | null = null;
  caretTracker: CaretTracker | null = null;

  private active = false;
  private timers = new Set<number>();
  private contextMenuCleanups: Array<() => void> = [];
  private lastContextClick: ContextClick | null = null;

  async onload(): Promise<void> {
    this.active = true;
    try {
      await this.loadSettings();
      if (!this.active) return;

      this.addSettingTab(new VariableLinksSettingTab(this.app, this));
      this.registry = new Registry(this.app, this);
      await this.registry.load();
      if (!this.active) return;

      this.indexer = new Indexer(this.app, this.registry);
      await this.indexer.build();
      this.tokenCache = new TokenCache(this.app, this, this.registry);
      await this.tokenCache.initialize();
      if (!this.active) return;

      this.resolver = new Resolver(this.app, this.registry);
      this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
      this.registerMarkdownPostProcessor((element) => {
        if (this.renderer) void this.renderer.processElement(element);
      });

      this.livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver);
      this.registerEditorExtension(this.livePreviewRenderer.createExtension());
      this.schedule(() => this.livePreviewRenderer?.refresh(), 0);

      const panelModule = await import('./panel');
      if (!this.active) return;
      this.registerView(
        panelModule.VIEW_TYPE_VARIABLE_PANEL,
        (leaf) => new panelModule.VariablePropertiesView(leaf, this),
      );
      this.addCommand({
        id: 'open-variable-properties',
        name: 'Open variable properties',
        callback: () => void this.openVariableProperties(),
      });

      this.registerVariableContextMenu();
      this.caretTracker = new CaretTracker(this.app, this, this.registry, this.resolver);
      this.caretTracker.start();
      this.suggest = new VariableSuggest(this.app, this.indexer, this.registry);
      this.registerEditorSuggest(this.suggest);

      this.registerEvent(this.app.vault.on('modify', (file) => {
        if (!this.active || !(file instanceof TFile)) return;
        if (file.path === this.registry?.registryFile?.path) {
          this.schedule(() => void this.indexer?.build(), 100);
        }
      }));
    } catch (error) {
      new Notice(`Variable Links failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onunload(): void {
    this.active = false;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.clearContextMenuResources();
    this.lastContextClick = null;
    this.suggest?.close();
    this.caretTracker?.stop();
    this.tokenCache?.stop();
    this.registry?.unload();
    this.renderer?.unload();
    this.livePreviewRenderer?.unload();
    this.caretTracker = null;
    this.tokenCache = null;
    this.registry = null;
    this.renderer = null;
    this.livePreviewRenderer = null;
    this.resolver = null;
    this.indexer = null;
    this.suggest = null;
  }

  onCaretVariableChanged(_last: LastTouched): void {
    if (this.active) void this.refreshPanelViews();
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const saved = this.isRecord(loaded) ? loaded : {};
    const defaultRegistryPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/registry.json`;
    this.settings = {
      registryFilePath: typeof saved.registryFilePath === 'string'
        ? saved.registryFilePath
        : defaultRegistryPath,
      enableInfoCards: typeof saved.enableInfoCards === 'boolean'
        ? saved.enableInfoCards
        : DEFAULT_SETTINGS.enableInfoCards,
      readingViewHoverDelaySeconds: normalizeReadingViewHoverDelay(
        saved.readingViewHoverDelaySeconds,
      ),
      livePreviewHoverDelaySeconds: normalizeLivePreviewHoverDelay(
        saved.livePreviewHoverDelaySeconds,
      ),
      disableLivePreviewHover: typeof saved.disableLivePreviewHover === 'boolean'
        ? saved.disableLivePreviewHover
        : DEFAULT_SETTINGS.disableLivePreviewHover,
      defaultAppearanceBold: typeof saved.defaultAppearanceBold === 'boolean'
        ? saved.defaultAppearanceBold
        : DEFAULT_SETTINGS.defaultAppearanceBold,
      defaultAppearanceItalic: typeof saved.defaultAppearanceItalic === 'boolean'
        ? saved.defaultAppearanceItalic
        : DEFAULT_SETTINGS.defaultAppearanceItalic,
      defaultAppearanceDecoration: saved.defaultAppearanceDecoration === 'highlight'
        || saved.defaultAppearanceDecoration === 'none'
        ? saved.defaultAppearanceDecoration
        : DEFAULT_SETTINGS.defaultAppearanceDecoration,
      defaultAppearanceUseCustomColor: typeof saved.defaultAppearanceUseCustomColor === 'boolean'
        ? saved.defaultAppearanceUseCustomColor
        : DEFAULT_SETTINGS.defaultAppearanceUseCustomColor,
      defaultAppearanceColor: normalizeAppearanceColor(
        saved.defaultAppearanceColor,
        DEFAULT_SETTINGS.defaultAppearanceColor,
      ),
      defaultAppearanceOpacity: normalizeAppearanceOpacity(saved.defaultAppearanceOpacity),
      savedAppearanceColors: normalizeAppearanceColors(saved.savedAppearanceColors),
      openInNewPane: typeof saved.openInNewPane === 'boolean'
        ? saved.openInNewPane
        : DEFAULT_SETTINGS.openInNewPane,
      suggestionFuzzy: typeof saved.suggestionFuzzy === 'boolean'
        ? saved.suggestionFuzzy
        : DEFAULT_SETTINGS.suggestionFuzzy,
      defaultDateFormat: typeof saved.defaultDateFormat === 'string'
        ? saved.defaultDateFormat
        : DEFAULT_SETTINGS.defaultDateFormat,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async openVariableProperties(variableName?: string): Promise<void> {
    if (!this.active) return;
    const panelModule = await import('./panel');
    if (!this.active) return;
    let leaf: WorkspaceLeaf | null = this.app.workspace
      .getLeavesOfType(panelModule.VIEW_TYPE_VARIABLE_PANEL)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) throw new Error('A sidebar could not be opened.');
      await leaf.setViewState({ type: panelModule.VIEW_TYPE_VARIABLE_PANEL });
    }
    if (variableName && leaf.view instanceof panelModule.VariablePropertiesView) {
      await leaf.view.selectVariable(variableName);
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private schedule(callback: () => void, delay: number): number | null {
    if (!this.active) return null;
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (this.active) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  private registerVariableContextMenu(): void {
    this.registerDomEvent(document, 'contextmenu', (event) => {
      if (!this.active) return;
      this.lastContextClick = {
        x: event.clientX,
        y: event.clientY,
        target: event.target instanceof Element ? event.target : null,
        time: Date.now(),
      };
    }, true);

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      if (!this.active) return;
      this.clearContextMenuResources();
      const variableName = this.getContextVariableName(editor);
      const insertionPosition = this.getContextEditorPosition(editor);
      const insideVariableToken = variableName !== null;
      const definition = variableName ? this.registry?.getVariable(variableName) : null;
      const favorites = Array.from(this.registry?.data.entries() ?? [])
        .filter(([, item]) => item.favorite)
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      const allLinks = Array.from(this.registry?.data.keys() ?? [])
        .sort((left, right) => left.localeCompare(right));

      menu.addItem((parentItem) => {
        parentItem.setTitle('Variable links').setIcon('braces');
        if (!this.hasSubmenu(parentItem)) {
          parentItem.setTitle('Variable links: properties').setDisabled(!variableName);
          if (variableName) {
            parentItem.onClick(() => void this.openVariableProperties(variableName));
          }
          return;
        }

        const submenu = parentItem.setSubmenu();
        submenu.addItem((item) => {
          item.setTitle('Properties').setIcon('list').setDisabled(!variableName);
          if (variableName) item.onClick(() => void this.openVariableProperties(variableName));
        });
        submenu.addItem((item) => {
          const favorite = definition?.favorite === true;
          item.setTitle(favorite ? 'Unfavorite' : 'Favorite').setIcon('star').setDisabled(!definition);
          if (definition && variableName) {
            item.onClick(() => void this.setVariableFavorite(variableName, !favorite));
          }
        });
        submenu.addSeparator();
        this.addInsertMenu(
          submenu,
          'Insert favorite',
          'star',
          favorites,
          editor,
          insertionPosition,
          insideVariableToken,
        );
        this.addInsertMenu(
          submenu,
          'Insert',
          'text-cursor-input',
          allLinks,
          editor,
          insertionPosition,
          insideVariableToken,
        );
      });
    }));
  }

  private addInsertMenu(
    menu: Menu,
    title: string,
    icon: string,
    names: string[],
    editor: Editor,
    position: EditorPosition | null,
    disabled: boolean,
  ): void {
    menu.addItem((item) => {
      item.setTitle(title).setIcon(icon).setDisabled(disabled || names.length === 0);
      if (disabled || !names.length || !this.hasSubmenu(item)) return;
      const submenu = item.setSubmenu();
      this.enableNestedSubmenuSwitch(menu, item, submenu);
      for (const name of names) {
        submenu.addItem((linkItem) => {
          linkItem.setTitle(name).onClick(() => this.insertVariable(editor, name, position));
        });
      }
    });
  }

  private getContextVariableName(editor: Editor): string | null {
    const click = this.getRecentContextClick();
    const tokenElement = click?.target?.closest<HTMLElement>('.variable-links-token[data-var]');
    const renderedName = tokenElement?.dataset.var?.trim();
    if (renderedName) return renderedName;
    return this.getVariableAtPosition(editor, this.getContextEditorPosition(editor));
  }

  private getVariableAtPosition(editor: Editor, position: EditorPosition | null): string | null {
    if (!position) return null;
    const line = editor.getLine(position.line);
    const pattern = /\{\{\s*([^}\s]+)\s*}}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const name = match[1];
      if (name && position.ch >= match.index && position.ch <= pattern.lastIndex) return name.trim();
    }
    return null;
  }

  private getContextEditorPosition(editor: Editor): EditorPosition | null {
    const click = this.getRecentContextClick();
    if (!click) return editor.getCursor();
    if (!click.target?.closest('.cm-editor')) return null;
    const editorWithCoordinates = editor as EditorWithCoordinates;
    const offset = editorWithCoordinates.cm?.posAtCoords?.({ x: click.x, y: click.y });
    return typeof offset === 'number' ? editor.offsetToPos(offset) : editor.getCursor();
  }

  private insertVariable(editor: Editor, variableName: string, position: EditorPosition | null): void {
    if (!position) {
      new Notice('Insertion position unavailable.');
      return;
    }
    const token = `{{${variableName}}}`;
    editor.replaceRange(token, position);
    editor.setCursor({ line: position.line, ch: position.ch + token.length });
    editor.focus();
  }

  private getRecentContextClick(): ContextClick | null {
    return this.lastContextClick && Date.now() - this.lastContextClick.time < 1000
      ? this.lastContextClick
      : null;
  }

  private hasSubmenu(item: MenuItem): item is MenuItemWithSubmenu {
    const candidate = item as Partial<MenuItemWithSubmenu>;
    return typeof candidate.setSubmenu === 'function';
  }

  private enableNestedSubmenuSwitch(
    parentMenu: Menu,
    item: MenuItemWithSubmenu,
    itemSubmenu: Menu,
  ): void {
    const itemElement = item.dom;
    if (!itemElement) return;
    const menuState = parentMenu as MenuWithSubmenuState;
    let timer: number | null = null;
    let cleaned = false;

    const onMouseEnter = (): void => {
      const current = menuState.currentSubmenu;
      if (!current || current === itemSubmenu) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!this.active || !itemElement.isConnected || !itemElement.matches(':hover')) return;
        if (typeof menuState.closeSubmenu === 'function') menuState.closeSubmenu();
        else current.hide();
        menuState.currentSubmenu = undefined;

        const MouseEventConstructor = itemElement.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
        itemElement.dispatchEvent(new MouseEventConstructor('mouseover', {
          bubbles: true,
          cancelable: true,
        }));
      }, 100);
    };
    const onMouseLeave = (): void => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      onMouseLeave();
      itemElement.removeEventListener('mouseenter', onMouseEnter);
      itemElement.removeEventListener('mouseleave', onMouseLeave);
      const index = this.contextMenuCleanups.indexOf(cleanup);
      if (index !== -1) this.contextMenuCleanups.splice(index, 1);
    };

    itemElement.addEventListener('mouseenter', onMouseEnter);
    itemElement.addEventListener('mouseleave', onMouseLeave);
    parentMenu.onHide(cleanup);
    this.contextMenuCleanups.push(cleanup);
  }

  private clearContextMenuResources(): void {
    for (const cleanup of [...this.contextMenuCleanups]) cleanup();
  }

  private async setVariableFavorite(variableName: string, favorite: boolean): Promise<void> {
    const definition = this.registry?.getVariable(variableName);
    if (!definition || !this.registry) {
      new Notice(`Variable Links: {{${variableName}}} is not configured.`);
      return;
    }
    try {
      await this.registry.saveVariable(variableName, { ...definition, favorite });
      await this.refreshPanelViews();
      new Notice(`Variable Links: ${favorite ? 'favorited' : 'unfavorited'} {{${variableName}}}`);
    } catch (error) {
      new Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refreshPanelViews(): Promise<void> {
    const panelModule = await import('./panel');
    if (!this.active) return;
    for (const leaf of this.app.workspace.getLeavesOfType(panelModule.VIEW_TYPE_VARIABLE_PANEL)) {
      if (leaf.view instanceof panelModule.VariablePropertiesView) {
        await leaf.view.refresh();
      }
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
