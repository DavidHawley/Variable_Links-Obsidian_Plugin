import {
  Editor,
  EditorPosition,
  Menu,
  MenuItem,
  Notice,
  Plugin,
  WorkspaceLeaf,
} from 'obsidian';
import CaretTracker, { LastTouched } from './caretTracker';
import {
  getEffectiveVariableAppearance,
  normalizeAppearanceColor,
  normalizeAppearanceColors,
  normalizeAppearanceOpacity,
} from './appearance';
import Indexer from './indexer';
import { filePathFromLink } from './linkSyntax';
import LivePreviewRenderer from './livePreviewRenderer';
import { Registry } from './registry';
import Renderer from './renderer';
import Resolver from './resolver';
import {
  DEFAULT_SETTINGS,
  normalizeInfoCardEditorCollapsedItems,
  normalizeInfoCardEditorDimension,
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

interface VariableTokenContext {
  name: string;
  from: EditorPosition;
  to: EditorPosition;
}

interface CloseableDialog {
  close(): void;
}

interface PluginPanelResource {
  releasePluginResources(): void;
  refreshAppearanceSettings?(): void;
}

interface MarkdownTokenMatch {
  start: number;
  end: number;
  name: string;
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
  private openDialogs = new Set<CloseableDialog>();
  private openPanels = new Set<PluginPanelResource>();

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
      this.registerMarkdownPostProcessor(async (element) => {
        if (this.renderer) await this.renderer.processElement(element);
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
      this.suggest = new VariableSuggest(
        this.app,
        this.indexer,
        this.registry,
        async () => this.refreshPanelViews(),
      );
      this.registerEditorSuggest(this.suggest);
    } catch (error) {
      new Notice(`Variable Links failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onunload(): void {
    this.active = false;
    for (const dialog of [...this.openDialogs]) dialog.close();
    this.openDialogs.clear();
    for (const panel of [...this.openPanels]) panel.releasePluginResources();
    this.openPanels.clear();
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

  trackDialog(dialog: CloseableDialog): void {
    if (!this.active) {
      dialog.close();
      return;
    }
    this.openDialogs.add(dialog);
  }

  releaseDialog(dialog: CloseableDialog): void {
    this.openDialogs.delete(dialog);
  }

  trackPanel(panel: PluginPanelResource): void {
    if (!this.active) {
      panel.releasePluginResources();
      return;
    }
    this.openPanels.add(panel);
  }

  releasePanel(panel: PluginPanelResource): void {
    this.openPanels.delete(panel);
  }

  refreshPanelAppearanceSettings(): void {
    if (!this.active) return;
    for (const panel of this.openPanels) panel.refreshAppearanceSettings?.();
  }

  onCaretVariableChanged(_last: LastTouched): void {
    if (this.active) void this.refreshPanelViews();
  }

  async refreshAfterRegistryReload(): Promise<void> {
    if (!this.active) return;
    await this.indexer?.build();
    if (!this.active) return;
    await this.tokenCache?.rebuild();
    if (!this.active) return;
    this.livePreviewRenderer?.refresh();
    await this.refreshPanelViews();
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
      infoCardEditorWidth: normalizeInfoCardEditorDimension(saved.infoCardEditorWidth),
      infoCardEditorHeight: normalizeInfoCardEditorDimension(saved.infoCardEditorHeight),
      infoCardEditorCollapsedItems: normalizeInfoCardEditorCollapsedItems(
        saved.infoCardEditorCollapsedItems,
      ),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveInfoCardEditorSize(width: number, height: number): Promise<void> {
    const normalizedWidth = normalizeInfoCardEditorDimension(width);
    const normalizedHeight = normalizeInfoCardEditorDimension(height);
    if (normalizedWidth === null || normalizedHeight === null) return;
    if (this.settings.infoCardEditorWidth === normalizedWidth
      && this.settings.infoCardEditorHeight === normalizedHeight) return;
    this.settings.infoCardEditorWidth = normalizedWidth;
    this.settings.infoCardEditorHeight = normalizedHeight;
    await this.saveSettings();
  }

  async saveInfoCardEditorCollapsedItems(
    variableName: string,
    itemIds: string[],
  ): Promise<void> {
    const nextIds = [...new Set(itemIds)].sort((left, right) => left.localeCompare(right));
    const currentIds = this.settings.infoCardEditorCollapsedItems[variableName] ?? [];
    if (currentIds.length === nextIds.length
      && currentIds.every((item, index) => item === nextIds[index])) return;
    const collapsedItems = Object.assign(
      Object.create(null) as Record<string, string[]>,
      this.settings.infoCardEditorCollapsedItems,
    );
    if (nextIds.length) collapsedItems[variableName] = nextIds;
    else delete collapsedItems[variableName];
    this.settings.infoCardEditorCollapsedItems = collapsedItems;
    await this.saveSettings();
  }

  async renameInfoCardEditorCollapsedItems(
    previousName: string,
    nextName: string,
  ): Promise<void> {
    if (previousName === nextName) return;
    const itemIds = this.settings.infoCardEditorCollapsedItems[previousName];
    if (!itemIds) return;
    const collapsedItems = Object.assign(
      Object.create(null) as Record<string, string[]>,
      this.settings.infoCardEditorCollapsedItems,
    );
    collapsedItems[nextName] = itemIds;
    delete collapsedItems[previousName];
    this.settings.infoCardEditorCollapsedItems = collapsedItems;
    await this.saveSettings();
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
      const insertionPosition = this.getContextEditorPosition(editor);
      const tokenContext = this.getContextVariableToken(editor, insertionPosition);
      const selectedMarkdown = editor.somethingSelected() ? editor.getSelection() : null;
      const variableName = tokenContext?.name ?? null;
      const insideVariableToken = tokenContext !== null;
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
        submenu.addItem((item) => {
          const copySource = selectedMarkdown
            ?? (tokenContext ? editor.getRange(tokenContext.from, tokenContext.to) : null);
          item.setTitle('Copy Markdown').setIcon('copy').setDisabled(copySource === null);
          if (copySource !== null) {
            item.onClick(() => void this.copyResolvedMarkdown(copySource));
          }
        });
        this.addSwitchTokenMenu(
          submenu,
          tokenContext,
          favorites,
          allLinks,
          editor,
        );
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

  private addSwitchTokenMenu(
    menu: Menu,
    tokenContext: VariableTokenContext | null,
    favorites: string[],
    allLinks: string[],
    editor: Editor,
  ): void {
    const currentName = tokenContext?.name ?? '';
    const alternatives = allLinks.filter((name) => name !== currentName);
    menu.addItem((item) => {
      const enabled = tokenContext !== null && alternatives.length > 0 && this.hasSubmenu(item);
      item.setTitle('Switch token').setIcon('replace').setDisabled(!enabled);
      if (!enabled || !tokenContext || !this.hasSubmenu(item)) return;

      const submenu = item.setSubmenu();
      this.enableNestedSubmenuSwitch(menu, item, submenu);
      submenu.addItem((currentItem) => {
        currentItem.setTitle(currentName).setIcon('check').setDisabled(true);
      });
      submenu.addSeparator();

      const favoriteNames = favorites.filter((name) => name !== currentName);
      const favoriteSet = new Set(favoriteNames);
      const regularNames = alternatives.filter((name) => !favoriteSet.has(name));
      for (const name of favoriteNames) {
        submenu.addItem((linkItem) => {
          linkItem
            .setTitle(name)
            .setIcon('star')
            .onClick(() => this.switchVariableToken(editor, tokenContext, name));
        });
      }
      if (favoriteNames.length > 0 && regularNames.length > 0) submenu.addSeparator();
      for (const name of regularNames) {
        submenu.addItem((linkItem) => {
          linkItem
            .setTitle(name)
            .onClick(() => this.switchVariableToken(editor, tokenContext, name));
        });
      }
    });
  }

  private getContextVariableToken(
    editor: Editor,
    position: EditorPosition | null,
  ): VariableTokenContext | null {
    const click = this.getRecentContextClick();
    const tokenElement = click?.target?.closest<HTMLElement>('.variable-links-token[data-var]');
    const renderedName = tokenElement?.dataset.var?.trim();
    return this.getVariableAtPosition(editor, position, renderedName || undefined);
  }

  private getVariableAtPosition(
    editor: Editor,
    position: EditorPosition | null,
    expectedName?: string,
  ): VariableTokenContext | null {
    if (!position) return null;
    const line = editor.getLine(position.line);
    const pattern = /\{\{\s*([^}\s]+)\s*}}/g;
    let match: RegExpExecArray | null;
    const matchingTokens: VariableTokenContext[] = [];
    while ((match = pattern.exec(line)) !== null) {
      const name = match[1];
      if (!name) continue;
      const trimmedName = name.trim();
      if (expectedName && trimmedName !== expectedName) continue;
      const token = {
        name: trimmedName,
        from: { line: position.line, ch: match.index },
        to: { line: position.line, ch: pattern.lastIndex },
      };
      if (position.ch >= match.index && position.ch <= pattern.lastIndex) return token;
      if (expectedName) matchingTokens.push(token);
    }
    if (!expectedName || matchingTokens.length === 0) return null;
    return matchingTokens.reduce((closest, token) => {
      const closestDistance = Math.min(
        Math.abs(position.ch - closest.from.ch),
        Math.abs(position.ch - closest.to.ch),
      );
      const tokenDistance = Math.min(
        Math.abs(position.ch - token.from.ch),
        Math.abs(position.ch - token.to.ch),
      );
      return tokenDistance < closestDistance ? token : closest;
    });
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

  private switchVariableToken(
    editor: Editor,
    tokenContext: VariableTokenContext,
    variableName: string,
  ): void {
    const token = `{{${variableName}}}`;
    editor.replaceRange(token, tokenContext.from, tokenContext.to);
    editor.setCursor({
      line: tokenContext.from.line,
      ch: tokenContext.from.ch + token.length,
    });
    editor.focus();
  }

  private async copyResolvedMarkdown(source: string): Promise<void> {
    const resolver = this.resolver;
    const registry = this.registry;
    if (!resolver || !registry) {
      new Notice('Variable links: could not copy Markdown because the registry is unavailable.');
      return;
    }

    const matches = this.findMarkdownTokenMatches(source);
    const cache = new Map<string, Promise<string>>();
    const replacements = await Promise.all(matches.map((match) => {
      let replacement = cache.get(match.name);
      if (!replacement) {
        replacement = this.renderCopiedVariableMarkdown(match.name);
        cache.set(match.name, replacement);
      }
      return replacement;
    }));
    let markdown = '';
    let lastIndex = 0;
    matches.forEach((match, index) => {
      markdown += source.slice(lastIndex, match.start) + replacements[index];
      lastIndex = match.end;
    });
    markdown += source.slice(lastIndex);

    try {
      await window.navigator.clipboard.writeText(markdown);
      new Notice('Variable links: copied Markdown with resolved values.');
    } catch {
      new Notice('Variable links: could not copy Markdown.');
    }
  }

  private findMarkdownTokenMatches(source: string): MarkdownTokenMatch[] {
    const pattern = /\{\{\s*([^}\s]+)\s*}}/g;
    const matches: MarkdownTokenMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1]?.trim();
      if (!name || this.isMarkdownCodePosition(source, match.index)) continue;
      matches.push({ start: match.index, end: pattern.lastIndex, name });
    }
    return matches;
  }

  private isMarkdownCodePosition(source: string, index: number): boolean {
    const before = source.slice(0, index);
    const lines = before.split('\n');
    let fenceCharacter = '';
    let fenceLength = 0;
    for (const line of lines.slice(0, -1)) {
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (!fence?.[1]) continue;
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0] ?? '';
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = '';
        fenceLength = 0;
      }
    }
    if (fenceCharacter) return true;

    const currentLine = lines[lines.length - 1] ?? '';
    let inlineFenceLength = 0;
    const backticks = /`+/g;
    let run: RegExpExecArray | null;
    while ((run = backticks.exec(currentLine)) !== null) {
      if (run.index > 0 && currentLine[run.index - 1] === '\\') continue;
      if (inlineFenceLength === 0) inlineFenceLength = run[0].length;
      else if (run[0].length === inlineFenceLength) inlineFenceLength = 0;
    }
    return inlineFenceLength > 0;
  }

  private async renderCopiedVariableMarkdown(variableName: string): Promise<string> {
    const definition = this.registry?.getVariable(variableName);
    const result = await this.resolver?.resolve(variableName).catch(() => null);
    const value = result?.ok
      ? this.formatCopiedValue(result.value)
      : `[Missing: ${variableName}]`;
    const explicitLink = filePathFromLink(definition?.link ?? '');
    const resolvedLink = result?.sourceFile?.path.replace(/\.md$/i, '') ?? '';
    const link = explicitLink || resolvedLink;
    let markdown = link
      ? `[[${this.escapeWikiLinkPart(link)}|${this.escapeWikiLinkPart(value)}]]`
      : this.escapeMarkdownText(value);
    const appearance = getEffectiveVariableAppearance(
      definition?.appearance,
      this.settings,
    );
    if (appearance.bold && appearance.italic) markdown = `***${markdown}***`;
    else if (appearance.bold) markdown = `**${markdown}**`;
    else if (appearance.italic) markdown = `*${markdown}*`;
    const decoration = appearance.decoration ?? 'underline';
    if (decoration === 'highlight') markdown = `==${markdown}==`;
    else if (decoration === 'underline') markdown = `<u>${markdown}</u>`;
    return markdown;
  }

  private formatCopiedValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join(', ');
    return String(value);
  }

  private escapeMarkdownText(value: string): string {
    return value.replace(/([\\`*_[\]{}()#+\-.!|>~=])/g, '\\$1');
  }

  private escapeWikiLinkPart(value: string): string {
    return value.replace(/([\\|\]])/g, '\\$1');
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
