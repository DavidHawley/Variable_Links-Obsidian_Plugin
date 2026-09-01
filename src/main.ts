import {
  Editor,
  EditorPosition,
  Menu,
  MenuItem,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from 'obsidian';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CaretTracker, { LastTouched } from './caretTracker';
import {
  getEffectiveVariableAppearance,
  normalizeAppearanceColor,
  normalizeAppearanceColors,
  normalizeAppearanceOpacity,
} from './appearance';
import Indexer from './indexer';
import { parseCapturedTimeCreationQuery } from './dateTime';
import { filePathFromLink } from './linkSyntax';
import LivePreviewRenderer, { isProtectedMarkdownRange } from './livePreviewRenderer';
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
import VariableSuggest, { type VariableCreationHandoff } from './suggest';
import TokenCache from './tokenCache';
import {
  canRepresentVariableTextCase,
  findVariableTokens,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  getTokenSyntax,
  normalizeLegacyTokenSyntaxes,
  normalizeTokenDelimiter,
  type TokenSyntax,
} from './tokenSyntax';
import {
  applyVariableTextCase,
  getVariableTextCaseLabel,
  parseVariableTextCaseQuery,
  VARIABLE_TEXT_CASE_OPTIONS,
  wrapVariableNameWithTextCase,
  type VariableTextCase,
} from './textCase';

interface EditorWithCoordinates extends Editor {
  cm?: EditorView;
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
  syntax: TokenSyntax;
  textCase?: VariableTextCase;
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
  textCase?: VariableTextCase;
}

interface CapturedTimeEditorExpression {
  from: EditorPosition;
  to: EditorPosition;
  originalText: string;
  expression: string;
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
  private pendingCapturedTimeExpressions = new Set<string>();
  private lastCapturedTimeExpressionAttempt = new WeakMap<Editor, string>();

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
      this.registerEvent(this.app.workspace.on('file-open', (file) => {
        if (file) void this.updateOpenedFileTokenCache(file);
      }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.updateMovedFileReferences(file, oldPath);
      }));

      this.resolver = new Resolver(this.app, this.registry);
      this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
      this.registerMarkdownPostProcessor(async (element) => {
        if (this.renderer) await this.renderer.processElement(element);
      });

      this.livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver);
      this.registerEditorExtension(this.livePreviewRenderer.createExtension());
      this.schedule(() => this.livePreviewRenderer?.refresh(), 0);

      const panelModule = await import('./panel');
      const managementModule = await import('./managementCenter');
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
      this.registerView(
        managementModule.VIEW_TYPE_MANAGEMENT_CENTER,
        (leaf) => new managementModule.ManagementCenterView(leaf, this),
      );
      this.addCommand({
        id: 'open-management-center',
        name: 'Open management center',
        callback: () => void this.openManagementCenter(),
      });
      this.addRibbonIcon('database', 'Open variable links management center', () => {
        void this.openManagementCenter();
      });
      this.addCommand({
        id: 'preview-autolinks-current-file',
        name: 'Preview autolinks for current file',
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension.toLocaleLowerCase() !== 'md') return false;
          if (!checking) void this.openCombinedAutolinkPreview({ type: 'file', path: file.path });
          return true;
        },
      });
      this.addCommand({
        id: 'preview-all-enabled-autolinks',
        name: 'Preview all enabled autolink profiles',
        checkCallback: (checking) => {
          if (!this.registry?.autolinkProfiles.some(({ enabled }) => enabled)) return false;
          if (!checking) void this.openCombinedAutolinkPreview({ type: 'all' });
          return true;
        },
      });
      this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) => item
          .setTitle('Preview autolinks for folder')
          .setIcon('scan-search')
          .onClick(() => void this.openCombinedAutolinkPreview({
            type: 'folder',
            path: file.path,
          })));
      }));

      this.registerVariableContextMenu();
      this.caretTracker = new CaretTracker(this.app, this, this.registry, this.resolver);
      this.caretTracker.start();
      this.suggest = new VariableSuggest(
        this.app,
        this.indexer,
        this.registry,
        this.resolver,
        async () => this.refreshPanelViews(),
        async (request) => this.openNamedVariableCreation(request),
      );
      this.registerEditorSuggest(this.suggest);
      this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
        if (info.file) this.handleCompletedCapturedTimeExpression(editor, info.file);
      }));
      this.registerEditorExtension(Prec.highest(keymap.of([
        { key: 'Tab', run: (view) => this.handleCapturedTimeCompletionCommand(view) },
        { key: 'Enter', run: (view) => this.handleCapturedTimeCompletionCommand(view) },
      ])));
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
    this.pendingCapturedTimeExpressions.clear();
    this.lastCapturedTimeExpressionAttempt = new WeakMap<Editor, string>();
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
    await this.refreshManagementCenterViews();
  }

  async refreshAfterTokenSyntaxChange(): Promise<void> {
    if (!this.active) return;
    await this.tokenCache?.rebuild();
    if (!this.active) return;
    this.livePreviewRenderer?.refresh();
    await this.refreshPanelViews();
    await this.refreshManagementCenterViews();
  }

  private async updateOpenedFileTokenCache(file: TFile): Promise<void> {
    if (!this.active) return;
    try {
      await this.tokenCache?.updateFile(file);
    } catch {
      // A later file-open or vault event will retry the cache update.
    }
  }

  private async updateMovedFileReferences(file: TFile, oldPath: string): Promise<void> {
    if (!this.active || !this.registry || oldPath === this.registry.registryPath) return;
    try {
      const updated = await this.registry.updateFileReferences(oldPath, file.path);
      if (!this.active || !updated) return;
      await this.indexer?.build();
      if (!this.active) return;
      this.livePreviewRenderer?.refresh();
      await this.refreshPanelViews();
      await this.refreshManagementCenterViews();
    } catch (error) {
      if (this.active) {
        new Notice(`Variable links: could not update moved note references: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const saved = this.isRecord(loaded) ? loaded : {};
    const defaultRegistryPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/registry.json`;
    let tokenPrefix = normalizeTokenDelimiter(
      saved.tokenPrefix,
      DEFAULT_SETTINGS.tokenPrefix,
    );
    let tokenSuffix = normalizeTokenDelimiter(
      saved.tokenSuffix,
      DEFAULT_SETTINGS.tokenSuffix,
    );
    if (tokenPrefix === tokenSuffix) {
      tokenPrefix = DEFAULT_SETTINGS.tokenPrefix;
      tokenSuffix = DEFAULT_SETTINGS.tokenSuffix;
    }
    const activeTokenSyntax = { prefix: tokenPrefix, suffix: tokenSuffix };
    this.settings = {
      registryFilePath: typeof saved.registryFilePath === 'string'
        ? saved.registryFilePath
        : defaultRegistryPath,
      tokenPrefix,
      tokenSuffix,
      legacyTokenSyntaxes: normalizeLegacyTokenSyntaxes(
        saved.legacyTokenSyntaxes,
        activeTokenSyntax,
      ),
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
      defaultTimeFormat: typeof saved.defaultTimeFormat === 'string'
        ? saved.defaultTimeFormat
        : DEFAULT_SETTINGS.defaultTimeFormat,
      defaultDateTimeFormat: typeof saved.defaultDateTimeFormat === 'string'
        ? saved.defaultDateTimeFormat
        : DEFAULT_SETTINGS.defaultDateTimeFormat,
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

  async renameInfoCardEditorCollapsedItemsBatch(
    renames: readonly { previousName: string; nextName: string }[],
  ): Promise<void> {
    const current = this.settings.infoCardEditorCollapsedItems;
    const moved = new Map<string, string[]>();
    for (const { previousName, nextName } of renames) {
      const itemIds = current[previousName];
      if (previousName !== nextName && itemIds) moved.set(nextName, itemIds);
    }
    if (!moved.size) return;
    const collapsedItems = Object.assign(
      Object.create(null) as Record<string, string[]>,
      current,
    );
    for (const { previousName, nextName } of renames) {
      if (previousName !== nextName) delete collapsedItems[previousName];
    }
    for (const [nextName, itemIds] of moved) collapsedItems[nextName] = itemIds;
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

  async openManagementCenter(): Promise<void> {
    if (!this.active) return;
    const managementModule = await import('./managementCenter');
    if (!this.active) return;
    let leaf = this.app.workspace
      .getLeavesOfType(managementModule.VIEW_TYPE_MANAGEMENT_CENTER)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({
        type: managementModule.VIEW_TYPE_MANAGEMENT_CENTER,
        active: true,
        state: { activity: 'variables' },
      });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async openCombinedAutolinkPreview(
    scope: { type: 'all' } | { type: 'file' | 'folder'; path: string },
  ): Promise<void> {
    if (!this.active || !this.registry) return;
    const previewModule = await import('./autolinkPreview');
    if (!this.active || !this.registry) return;
    previewModule.openCombinedAutolinkPreview(
      this.app,
      this,
      this.registry,
      scope,
    );
  }

  async refreshManagementCenterViews(): Promise<void> {
    const managementModule = await import('./managementCenter');
    if (!this.active) return;
    for (const leaf of this.app.workspace.getLeavesOfType(
      managementModule.VIEW_TYPE_MANAGEMENT_CENTER,
    )) {
      if (leaf.view instanceof managementModule.ManagementCenterView) leaf.view.refresh();
    }
  }

  private async openNamedVariableCreation(request: VariableCreationHandoff): Promise<void> {
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
    if (!(leaf.view instanceof panelModule.VariablePropertiesView)) {
      throw new Error('The Variable Link properties panel is unavailable.');
    }
    await leaf.view.beginVariableCreation(request.type, request.name, async (savedName) => {
      const current = request.editor.getRange(request.from, request.to);
      if (current !== request.originalText) {
        throw new Error('The creation expression changed while the properties panel was open.');
      }
      const token = formatVariableToken(
        savedName,
        getTokenSyntax(this.settings),
        request.textCase,
      );
      request.editor.replaceRange(token, request.from, request.to);
      request.editor.setCursor({
        line: request.from.line,
        ch: request.from.ch + token.length,
      });
      request.editor.focus();
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private handleCompletedCapturedTimeExpression(editor: Editor, file: TFile): void {
    if (!this.active || !this.suggest || !this.registry) return;
    const candidate = this.findCompletedCapturedTimeExpression(editor);
    if (!candidate) {
      this.lastCapturedTimeExpressionAttempt.delete(editor);
      return;
    }
    this.beginCapturedTimeCompletion(editor, file, candidate, false);
  }

  private handleCapturedTimeCompletionCommand(view: EditorView): boolean {
    if (!this.active) return false;
    const activeEditor = this.app.workspace.activeEditor;
    const editor = activeEditor?.editor;
    const file = activeEditor?.file;
    if (!editor || !file || (editor as EditorWithCoordinates).cm !== view) return false;
    const candidate = this.findCapturedTimeExpressionAtCaret(editor);
    if (!candidate) return false;
    this.suggest?.close();
    this.beginCapturedTimeCompletion(editor, file, candidate, true);
    return true;
  }

  private beginCapturedTimeCompletion(
    editor: Editor,
    file: TFile,
    candidate: CapturedTimeEditorExpression,
    force: boolean,
  ): void {
    if (!this.suggest) return;
    const signature = `${file.path}\u0000${candidate.from.line}\u0000${candidate.from.ch}\u0000${candidate.originalText}`;
    if ((!force && this.lastCapturedTimeExpressionAttempt.get(editor) === signature)
      || this.pendingCapturedTimeExpressions.has(signature)) return;
    this.lastCapturedTimeExpressionAttempt.set(editor, signature);
    this.pendingCapturedTimeExpressions.add(signature);
    void this.suggest.completeTypedCapturedTimeExpression(
      editor,
      file,
      candidate.from,
      candidate.to,
      candidate.originalText,
      candidate.expression,
    ).finally(() => {
      this.pendingCapturedTimeExpressions.delete(signature);
    });
  }

  private findCompletedCapturedTimeExpression(editor: Editor): CapturedTimeEditorExpression | null {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const tokenEnds = [cursor.ch];
    let beforeWhitespace = cursor.ch;
    while (beforeWhitespace > 0 && /\s/.test(line[beforeWhitespace - 1])) beforeWhitespace--;
    if (beforeWhitespace !== cursor.ch) tokenEnds.push(beforeWhitespace);

    let best: CapturedTimeEditorExpression | null = null;
    for (const tokenEnd of tokenEnds) {
      for (const syntax of getRecognizedTokenSyntaxes(this.settings)) {
        const closeStart = tokenEnd - syntax.suffix.length;
        if (closeStart < 0 || !line.startsWith(syntax.suffix, closeStart)) continue;
        const openStart = line.lastIndexOf(syntax.prefix, closeStart - 1);
        if (openStart === -1) continue;
        const closingRange = this.expandRepeatedPunctuationSuffix(
          line,
          openStart + syntax.prefix.length,
          closeStart,
          tokenEnd,
          syntax.suffix,
        );
        const expression = line.slice(
          openStart + syntax.prefix.length,
          closingRange.contentEnd,
        ).trim();
        const caseQuery = parseVariableTextCaseQuery(expression);
        if (this.registry?.getVariable(caseQuery.query)) continue;
        const creation = parseCapturedTimeCreationQuery(caseQuery.query);
        if (!creation?.type) continue;
        const from = { line: cursor.line, ch: openStart };
        const to = { line: cursor.line, ch: closingRange.tokenEnd };
        const state = (editor as EditorWithCoordinates).cm?.state;
        if (state && isProtectedMarkdownRange(
          state,
          editor.posToOffset(from),
          editor.posToOffset(to),
        )) continue;
        if (!best || openStart > best.from.ch) {
          best = {
            from,
            to,
            originalText: line.slice(openStart, closingRange.tokenEnd),
            expression,
          };
        }
      }
    }
    return best;
  }

  private findCapturedTimeExpressionAtCaret(editor: Editor): CapturedTimeEditorExpression | null {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    let best: CapturedTimeEditorExpression | null = null;
    for (const syntax of getRecognizedTokenSyntaxes(this.settings)) {
      const openStart = line.lastIndexOf(syntax.prefix, cursor.ch);
      if (openStart === -1) continue;
      const contentStart = openStart + syntax.prefix.length;
      if (cursor.ch < contentStart) continue;
      const closeStart = line.indexOf(syntax.suffix, contentStart);
      const hasCloser = closeStart !== -1 && cursor.ch <= closeStart + syntax.suffix.length;
      let contentEnd = hasCloser ? closeStart : cursor.ch;
      let tokenEnd = hasCloser ? closeStart + syntax.suffix.length : cursor.ch;
      if (hasCloser) {
        const closingRange = this.expandRepeatedPunctuationSuffix(
          line,
          contentStart,
          contentEnd,
          tokenEnd,
          syntax.suffix,
        );
        contentEnd = closingRange.contentEnd;
        tokenEnd = closingRange.tokenEnd;
      }
      if (!hasCloser) {
        const partialBefore = this.partialSuffixBeforeCursor(line, cursor.ch, syntax.suffix);
        if (partialBefore > 0) {
          contentEnd -= partialBefore;
        } else {
          tokenEnd += this.partialSuffixAfterCursor(line, cursor.ch, syntax.suffix);
        }
      }
      const expression = line.slice(contentStart, contentEnd).trim();
      const caseQuery = parseVariableTextCaseQuery(expression);
      if (this.registry?.getVariable(caseQuery.query)) continue;
      const creation = parseCapturedTimeCreationQuery(caseQuery.query);
      if (!creation?.type) continue;
      const from = { line: cursor.line, ch: openStart };
      const to = { line: cursor.line, ch: tokenEnd };
      const state = (editor as EditorWithCoordinates).cm?.state;
      if (state && isProtectedMarkdownRange(
        state,
        editor.posToOffset(from),
        editor.posToOffset(to),
      )) continue;
      if (!best || openStart > best.from.ch) {
        best = {
          from,
          to,
          originalText: line.slice(openStart, tokenEnd),
          expression,
        };
      }
    }
    return best;
  }

  private partialSuffixBeforeCursor(line: string, cursor: number, suffix: string): number {
    for (let length = suffix.length - 1; length > 0; length--) {
      const partial = suffix.slice(0, length);
      if (/[\p{L}\p{N}]/u.test(partial)) continue;
      if (cursor >= length
        && line.slice(cursor - length, cursor) === partial) return length;
    }
    return 0;
  }

  private expandRepeatedPunctuationSuffix(
    line: string,
    contentStart: number,
    contentEnd: number,
    tokenEnd: number,
    suffix: string,
  ): { contentEnd: number; tokenEnd: number } {
    const delimiter = suffix[0];
    if (!delimiter
      || /[\p{L}\p{N}]/u.test(delimiter)
      || Array.from(suffix).some((character) => character !== delimiter)) {
      return { contentEnd, tokenEnd };
    }
    while (contentEnd > contentStart && line[contentEnd - 1] === delimiter) contentEnd--;
    while (tokenEnd < line.length && line[tokenEnd] === delimiter) tokenEnd++;
    return { contentEnd, tokenEnd };
  }

  private partialSuffixAfterCursor(line: string, cursor: number, suffix: string): number {
    for (let length = suffix.length - 1; length > 0; length--) {
      const partial = suffix.slice(0, length);
      if (/[\p{L}\p{N}]/u.test(partial)) continue;
      if (line.startsWith(partial, cursor)) return length;
    }
    return 0;
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
        this.addTextCaseMenu(submenu, tokenContext, editor);
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

  private addTextCaseMenu(
    menu: Menu,
    tokenContext: VariableTokenContext | null,
    editor: Editor,
  ): void {
    menu.addItem((item) => {
      const enabled = tokenContext !== null && this.hasSubmenu(item);
      item.setTitle('Text case').setIcon('case-sensitive').setDisabled(!enabled);
      if (!enabled || !tokenContext || !this.hasSubmenu(item)) return;
      const submenu = item.setSubmenu();
      this.enableNestedSubmenuSwitch(menu, item, submenu);
      submenu.addItem((caseItem) => {
        caseItem
          .setTitle('Use variable default')
          .setIcon(tokenContext.textCase === undefined ? 'check' : 'rotate-ccw')
          .onClick(() => this.switchVariableTokenTextCase(editor, tokenContext, undefined));
      });
      submenu.addSeparator();
      for (const option of VARIABLE_TEXT_CASE_OPTIONS) {
        if (!option.value) continue;
        const textCase = option.value;
        const hasNameConflict = !canRepresentVariableTextCase(
          tokenContext.name,
          textCase,
          (name) => Boolean(this.registry?.getVariable(name)),
        );
        submenu.addItem((caseItem) => {
          caseItem
            .setTitle(hasNameConflict
              ? `${getVariableTextCaseLabel(textCase)} (name conflict)`
              : getVariableTextCaseLabel(textCase))
            .setIcon(tokenContext.textCase === textCase ? 'check' : 'case-sensitive')
            .setDisabled(hasNameConflict)
            .onClick(() => this.switchVariableTokenTextCase(editor, tokenContext, textCase));
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
    const syntaxes = getRecognizedTokenSyntaxes(this.settings);
    const matchingTokens: VariableTokenContext[] = [];
    for (const match of findVariableTokens(
      line,
      syntaxes,
      (name) => Boolean(this.registry?.getVariable(name)),
    )) {
      if (expectedName && match.name !== expectedName) continue;
      const token = {
        name: match.name,
        from: { line: position.line, ch: match.start },
        to: { line: position.line, ch: match.end },
        syntax: match.syntax,
        textCase: match.textCase,
      };
      if (position.ch >= match.start && position.ch <= match.end) return token;
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
    const token = formatVariableToken(variableName, getTokenSyntax(this.settings));
    editor.replaceRange(token, position);
    editor.setCursor({ line: position.line, ch: position.ch + token.length });
    editor.focus();
  }

  private switchVariableToken(
    editor: Editor,
    tokenContext: VariableTokenContext,
    variableName: string,
  ): void {
    const token = formatVariableToken(
      variableName,
      getTokenSyntax(this.settings),
      tokenContext.textCase,
    );
    editor.replaceRange(token, tokenContext.from, tokenContext.to);
    editor.setCursor({
      line: tokenContext.from.line,
      ch: tokenContext.from.ch + token.length,
    });
    editor.focus();
  }

  private switchVariableTokenTextCase(
    editor: Editor,
    tokenContext: VariableTokenContext,
    textCase: VariableTextCase | undefined,
  ): void {
    const representable = !textCase || canRepresentVariableTextCase(
      tokenContext.name,
      textCase,
      (name) => Boolean(this.registry?.getVariable(name)),
    );
    if (!representable) {
      const conflictingName = wrapVariableNameWithTextCase(tokenContext.name, textCase);
      new Notice(`Variable links: cannot apply this text case because ${conflictingName} conflicts with an existing variable name.`);
      return;
    }
    const token = formatVariableToken(tokenContext.name, tokenContext.syntax, textCase);
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
      const cacheKey = `${match.name}\u0000${match.textCase ?? ''}`;
      let replacement = cache.get(cacheKey);
      if (!replacement) {
        replacement = this.renderCopiedVariableMarkdown(match.name, match.textCase);
        cache.set(cacheKey, replacement);
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
    const matches: MarkdownTokenMatch[] = [];
    for (const match of findVariableTokens(
      source,
      getRecognizedTokenSyntaxes(this.settings),
      (name) => Boolean(this.registry?.getVariable(name)),
    )) {
      if (this.isMarkdownCodePosition(source, match.start)) continue;
      matches.push(match);
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

  private async renderCopiedVariableMarkdown(
    variableName: string,
    tokenTextCase?: VariableTextCase,
  ): Promise<string> {
    const definition = this.registry?.getVariable(variableName);
    const result = await this.resolver?.resolve(variableName).catch(() => null);
    const rawValue = result?.ok
      ? this.formatCopiedValue(result.value)
      : `[Missing: ${variableName}]`;
    const value = result?.ok
      ? applyVariableTextCase(rawValue, tokenTextCase ?? definition?.textCase)
      : rawValue;
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
      new Notice(`Variable Links: ${formatVariableToken(variableName, getTokenSyntax(this.settings))} is not configured.`);
      return;
    }
    try {
      await this.registry.saveVariable(variableName, { ...definition, favorite });
      await this.refreshPanelViews();
      new Notice(`Variable Links: ${favorite ? 'favorited' : 'unfavorited'} ${formatVariableToken(variableName, getTokenSyntax(this.settings))}`);
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
