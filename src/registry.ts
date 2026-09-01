import { App, EventRef, Modal, Notice, TFile, parseYaml, stringifyYaml } from 'obsidian';
import {
  normalizeVariableAppearance,
  type VariableAppearance,
} from './appearance';
import type { CardConfig } from './card';
import {
  normalizeAutolinkProfiles,
  normalizeManagedAutolinkEntry,
  type AutolinkProfile,
  type ManagedAutolinkEntry,
} from './autolink';
import {
  deriveLegacyCardFields,
  normalizeCardBlocks,
  normalizeCardStyle,
  normalizeGridColumns,
  normalizeLayoutGap,
} from './cardBlocks';
import type VariableLinksPlugin from './main';
import type { VariableLinksSettings } from './settings';
import { filePathFromLink } from './linkSyntax';
import { getTokenSyntax } from './tokenSyntax';
import {
  normalizeVariableTextCase,
  parseVariableTextCaseMarker,
  type VariableTextCase,
} from './textCase';

export type VariableType = 'property' | 'fixed';

const REGISTRY_POLL_INTERVAL_MS = 1000;

class ReservedTextCaseNameModal extends Modal {
  private settled = false;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly variableName: string,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.contentEl.createEl('h3', { text: 'Use a reserved-looking variable name?' });
    this.contentEl.createEl('p', {
      text: `“${this.variableName}” begins and ends like token text-case syntax. Exact-name compatibility means it can take priority over a formatted token with the same text.`,
    });
    this.contentEl.createEl('p', {
      text: 'Use a different name unless this punctuation is intentional.',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.choose(false));
    actions.createEl('button', { text: 'Use name anyway', cls: 'mod-warning' })
      .addEventListener('click', () => this.choose(true));
  }

  onClose(): void {
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
    if (!this.settled) this.finish(false);
  }

  private choose(confirmed: boolean): void {
    this.finish(confirmed);
    this.close();
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(confirmed);
  }
}

export interface VariableDefinition {
  guid?: string;
  type?: VariableType;
  file: string; // vault path or wiki-link raw
  property: string;
  value?: string;
  link?: string;
  display?: string;
  textCase?: VariableTextCase;
  favorite?: boolean;
  appearance?: VariableAppearance;
  customAppearance?: VariableAppearance;
  card?: CardConfig;
  format?: string;
  managed?: ManagedAutolinkEntry;
}

export interface ManagedAutolinkAddition {
  name: string;
  definition: VariableDefinition;
}

export interface ManagedAutolinkApplyResult {
  added: number;
  overwritten: number;
}

export interface VariableRename {
  guid: string;
  newName: string;
  oldName: string;
}

export interface VariableRenameResult {
  fileCount: number;
  renamed: number;
  tokenCount: number;
}

export function getVariableType(definition: VariableDefinition): VariableType {
  return definition.type === 'fixed' ? 'fixed' : 'property';
}

export class Registry {
  app: App;
  plugin: VariableLinksPlugin;
  settings: VariableLinksSettings;
  data: Map<string, VariableDefinition> = new Map();
  autolinkProfiles: AutolinkProfile[] = [];
  registryFile: TFile | null = null;
  registryPath: string = '';
  private modifyEvent: EventRef | null = null;
  private reloadTimer: number | null = null;
  private pollTimer: number | null = null;
  private watchedPath = '';
  private watchedContent: string | null = null;
  private pollInProgress = false;
  private active = true;
  private generation = 0;

  constructor(app: App, plugin: VariableLinksPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  private initialContent(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.json')) return JSON.stringify({ 'variable-links': {} }, null, 2) + '\n';
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'variable-links: {}\n';
    return '---\nvariable-links: {}\n---\n';
  }

  private async ensureAdapterFolders(path: string) {
    const adapter = this.app.vault.adapter;
    const parts = path.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await adapter.exists(current)) await adapter.mkdir(current);
    }
  }

  private async createRegistry(path: string): Promise<TFile | null> {
    const vault = this.app.vault;
    const configDir = vault.configDir;
    const hidden = path === configDir || path.startsWith(`${configDir}/`);
    const content = this.initialContent(path);
    if (hidden) {
      await this.ensureAdapterFolders(path);
      await vault.adapter.write(path, content);
      return null;
    }

    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !vault.getAbstractFileByPath(parent)) {
      const parts = parent.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
      }
    }
    return await vault.create(path, content);
  }

  async load() {
    if (!this.active) return;
    const generation = ++this.generation;
    this.settings = this.plugin.settings;
    const path = this.settings.registryFilePath.replace(/\\/g, '/');
    if (!path) {
      this.stopWatchingRegistry();
      new Notice('Registry file path is not set.');
      return;
    }

    this.registryPath = path;
    const adapter = this.app.vault.adapter;
    let abstractFile = this.app.vault.getAbstractFileByPath(path);
    let file = abstractFile instanceof TFile ? abstractFile : null;
    if (!file && !await adapter.exists(path)) {
      file = await this.createRegistry(path);
      new Notice('Variable Links: created registry at ' + path);
    }
    this.registryFile = file;
    const content = file ? await this.app.vault.read(file) : await adapter.read(path);
    if (!this.isCurrent(generation)) return;
    this.watchRegistry(path, content);

    // Try to parse registry using intelligent handling based on extension and content
    const parsed = this.parseRegistryFromContent(content, path);
    if (!parsed) {
      new Notice('Variable Links: failed to parse registry from file: ' + path);
      this.data.clear();
      return;
    }

    const variableLinks = parsed['variable-links'];
    if (!this.isRecord(variableLinks)) {
      new Notice('Registry file has no "variable-links" section.');
      this.data.clear();
      return;
    }

    this.autolinkProfiles = normalizeAutolinkProfiles(parsed['autolink-profiles']);

    this.data.clear();
    const generatedGuids = new Map<string, string>();
    const usedGuids = new Set<string>();
    for (const [key, raw] of Object.entries(variableLinks)) {
      if (this.isRecord(raw)) {
        let guid = typeof raw.guid === 'string' ? raw.guid.trim() : '';
        if (!guid || usedGuids.has(guid)) {
          do { guid = this.createGuid(); } while (usedGuids.has(guid));
          generatedGuids.set(String(key), guid);
        }
        usedGuids.add(guid);
        const def: VariableDefinition = {
          guid,
          type: raw.type === 'fixed' ? 'fixed' : 'property',
          file: typeof raw.file === 'string' ? raw.file : '',
          property: typeof raw.property === 'string' ? raw.property : '',
          value: this.toFixedValue(raw.value),
          link: typeof raw.link === 'string' ? raw.link : undefined,
          display: typeof raw.display === 'string' ? raw.display : undefined,
          textCase: normalizeVariableTextCase(raw.textCase),
          favorite: raw.favorite === true,
          appearance: normalizeVariableAppearance(raw.appearance),
          customAppearance: normalizeVariableAppearance(raw.customAppearance),
          card: this.toCardConfig(raw.card),
          format: typeof raw.format === 'string' ? raw.format : undefined,
          managed: normalizeManagedAutolinkEntry(raw.managed),
        };
        this.data.set(String(key), def);
      }
    }
    if (generatedGuids.size) {
      await this.mutateRegistryLinks((links) => {
        for (const [name, guid] of generatedGuids) {
          const definition = links[name];
          if (this.isRecord(definition)) definition.guid = guid;
        }
      });
      if (!this.isCurrent(generation)) return;
    }

  }

  unload() {
    this.active = false;
    this.generation++;
    if (this.reloadTimer) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.stopWatchingRegistry();
  }

  private isCurrent(generation: number) {
    return this.active && this.generation === generation;
  }

  private watchRegistry(path: string, content: string): void {
    if (this.watchedPath === path) {
      this.watchedContent = content;
      return;
    }

    this.stopWatchingRegistry();
    if (!this.active) return;
    this.watchedPath = path;
    this.watchedContent = content;
    this.modifyEvent = this.app.vault.on('modify', (file) => {
      if (!this.active || file.path !== this.watchedPath) return;
      this.scheduleRegistryCheck();
    });
    this.pollTimer = window.setInterval(() => {
      void this.reloadIfRegistryChanged();
    }, REGISTRY_POLL_INTERVAL_MS);
  }

  private stopWatchingRegistry(): void {
    if (this.modifyEvent) {
      this.app.vault.offref(this.modifyEvent);
      this.modifyEvent = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watchedPath = '';
    this.watchedContent = null;
    this.pollInProgress = false;
  }

  private scheduleRegistryCheck(): void {
    if (!this.active) return;
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reloadIfRegistryChanged();
    }, 50);
  }

  private async reloadIfRegistryChanged(): Promise<void> {
    const path = this.watchedPath;
    if (!this.active || !path || this.pollInProgress) return;
    this.pollInProgress = true;
    try {
      const adapter = this.app.vault.adapter;
      if (!await adapter.exists(path)) return;
      const content = await adapter.read(path);
      if (!this.active || this.watchedPath !== path || content === this.watchedContent) return;
      this.watchedContent = content;
      await this.reloadAfterFileChange();
    } catch {
      // A later poll or vault event retries transient adapter failures.
    } finally {
      this.pollInProgress = false;
    }
  }

  private async reloadAfterFileChange(): Promise<void> {
    if (!this.active) return;
    try {
      await this.load();
      if (this.active) await this.plugin.refreshAfterRegistryReload();
    } catch (error) {
      if (this.active) {
        new Notice(`Variable Links: could not reload the registry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  getVariable(name: string) {
    return this.data.get(name) ?? null;
  }

  async updateFileReferences(oldPath: string, newPath: string): Promise<number> {
    if (!this.active) return 0;
    const updates = new Map<string, { file?: string; link?: string; managedSourcePath?: string }>();
    for (const [name, definition] of this.data) {
      const update: { file?: string; link?: string; managedSourcePath?: string } = {};
      if (getVariableType(definition) === 'property') {
        const file = this.movedFileLink(definition.file, oldPath, newPath);
        if (file !== null) update.file = file;
      }
      const link = this.movedFileLink(definition.link ?? '', oldPath, newPath);
      if (link !== null) update.link = link;
      if (definition.managed?.managedFields.includes('file')
        && this.sameFilePath(definition.managed.sourcePath, oldPath)) {
        update.managedSourcePath = newPath.replace(/\\/g, '/');
      }
      if (Object.keys(update).length) updates.set(name, update);
    }
    if (!updates.size) return 0;

    await this.mutateRegistryLinks((links) => {
      for (const [name, update] of updates) {
        const stored = links[name];
        if (!this.isRecord(stored)) continue;
        if (update.file !== undefined) stored.file = update.file;
        if (update.link !== undefined) stored.link = update.link;
        if (update.managedSourcePath !== undefined && this.isRecord(stored.managed)) {
          stored.managed.sourcePath = update.managedSourcePath;
        }
      }
    });
    await this.load();
    return updates.size;
  }

  private createGuid(): string {
    if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.random() * 16 | 0;
      return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
    });
  }

  private movedFileLink(value: string, oldPath: string, newPath: string): string | null {
    const currentPath = filePathFromLink(value);
    const previousPath = filePathFromLink(oldPath);
    const nextPath = filePathFromLink(newPath);
    if (!currentPath || !previousPath || !nextPath
      || currentPath.toLowerCase() !== previousPath.toLowerCase()) return null;

    const trimmed = value.trim();
    const wikiLink = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (wikiLink?.[1]) {
      const inner = wikiLink[1];
      const aliasIndex = inner.indexOf('|');
      const linkedPath = (aliasIndex === -1 ? inner : inner.slice(0, aliasIndex)).trim();
      const alias = aliasIndex === -1 ? '' : inner.slice(aliasIndex);
      const extension = /\.md$/i.test(linkedPath) ? '.md' : '';
      return `[[${nextPath}${extension}${alias}]]`;
    }
    return /\.md$/i.test(trimmed) ? `${nextPath}.md` : nextPath;
  }

  private async mutateRegistryDocument(
    mutator: (registry: Record<string, unknown>) => void,
  ): Promise<void> {
    const file = this.registryFile;
    const adapter = this.app.vault.adapter;
    const path = this.registryPath;
    const lowerPath = path.toLowerCase();
    if ((lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx'))
      && file) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        mutator(frontmatter);
      });
      return;
    }

    const content = file ? await this.app.vault.read(file) : await adapter.read(path);
    const registry = this.parseRegistryFromContent(content, path);
    if (!registry) throw new Error('The registry must contain valid JSON or YAML.');
    mutator(registry);
    let updatedContent: string;
    if (lowerPath.endsWith('.json')) updatedContent = JSON.stringify(registry, null, 2) + '\n';
    else {
      const yaml = stringifyYaml(registry).trimEnd();
      if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx')) {
        const closing = content.indexOf('\n---', 3);
        if (closing === -1) throw new Error('The registry frontmatter is not closed.');
        const bodyStart = content.indexOf('\n', closing + 4);
        const body = bodyStart === -1 ? '' : content.slice(bodyStart + 1);
        updatedContent = `---\n${yaml}\n---${body ? `\n${body}` : '\n'}`;
      } else updatedContent = yaml + '\n';
    }
    if (file) await this.app.vault.modify(file, updatedContent);
    else await adapter.write(path, updatedContent);
  }

  private sameFilePath(left: string, right: string): boolean {
    return filePathFromLink(left).toLocaleLowerCase() === filePathFromLink(right).toLocaleLowerCase();
  }

  private async mutateRegistryLinks(mutator: (links: Record<string, unknown>) => void): Promise<void> {
    await this.mutateRegistryDocument((registry) => {
      const links = this.isRecord(registry['variable-links']) ? registry['variable-links'] : {};
      registry['variable-links'] = links;
      mutator(links);
    });
  }

  async saveAutolinkProfiles(profiles: readonly AutolinkProfile[]): Promise<void> {
    if (!this.registryFile && !this.registryPath) throw new Error('The registry file is not loaded.');
    const normalized = normalizeAutolinkProfiles(profiles);
    await this.mutateRegistryDocument((registry) => {
      registry['autolink-profiles'] = normalized;
      if (!this.isRecord(registry['variable-links'])) registry['variable-links'] = {};
    });
    await this.load();
    await this.plugin.refreshManagementCenterViews();
  }

  async applyManagedAutolinkVariables(
    additions: readonly ManagedAutolinkAddition[],
    allowOverwrite = false,
  ): Promise<ManagedAutolinkApplyResult> {
    if (!additions.length) return { added: 0, overwritten: 0 };
    if (!this.registryFile && !this.registryPath) throw new Error('The registry file is not loaded.');
    const tokenSyntax = getTokenSyntax(this.plugin.settings);
    const normalized = additions.map(({ name, definition }) => {
      const variableName = name.trim();
      const managed = normalizeManagedAutolinkEntry(definition.managed);
      if (!variableName) throw new Error('Every generated Variable Link requires a name.');
      if (variableName.includes(tokenSyntax.prefix) || variableName.includes(tokenSyntax.suffix)) {
        throw new Error(`“${variableName}” contains the active token prefix or suffix.`);
      }
      if (getVariableType(definition) !== 'property') {
        throw new Error(`“${variableName}” is not a property-backed Variable Link.`);
      }
      if (!definition.file.trim() || !definition.property.trim()) {
        throw new Error(`“${variableName}” requires a source note and property.`);
      }
      if (!managed) throw new Error(`“${variableName}” is missing its Autolink ownership record.`);
      const generatedDefinition: VariableDefinition = {
        guid: this.createGuid(),
        type: 'property',
        file: definition.file.trim(),
        property: definition.property.trim(),
        managed,
      };
      if (definition.card) generatedDefinition.card = definition.card;
      return { name: variableName, definition: generatedDefinition };
    });
    const names = new Set<string>();
    for (const { name } of normalized) {
      if (names.has(name)) throw new Error(`The generated name “${name}” occurs more than once.`);
      names.add(name);
    }

    let added = 0;
    let overwritten = 0;
    await this.mutateRegistryLinks((links) => {
      for (const { name } of normalized) {
        if (!allowOverwrite && Object.prototype.hasOwnProperty.call(links, name)) {
          throw new Error(`“${name}” now belongs to an existing Variable Link. No additions were saved.`);
        }
      }
      for (const { name, definition } of normalized) {
        const current = links[name];
        if (Object.prototype.hasOwnProperty.call(links, name)) {
          const guid = this.isRecord(current) && typeof current.guid === 'string'
            ? current.guid.trim()
            : '';
          links[name] = { ...definition, guid: guid || definition.guid };
          overwritten++;
        } else {
          links[name] = definition;
          added++;
        }
      }
    });
    try {
      await this.load();
    } catch {
      new Notice('Autolink additions were saved, but the registry view could not be refreshed. Reload Obsidian.');
      return { added, overwritten };
    }
    try {
      await this.plugin.refreshAfterRegistryReload();
    } catch {
      new Notice('Autolink additions were saved, but some derived views could not be refreshed. Reload Obsidian.');
    }
    return { added, overwritten };
  }

  /** Persist a mapping. A rename keeps the GUID and updates verified token references. */
  async saveVariable(name: string, definition: VariableDefinition, previousName?: string) {
    const variableName = name.trim();
    const oldName = previousName?.trim();
    const type = getVariableType(definition);
    if (!variableName) throw new Error('Variable name is required.');
    const tokenSyntax = getTokenSyntax(this.plugin.settings);
    if (variableName.includes(tokenSyntax.prefix) || variableName.includes(tokenSyntax.suffix)) {
      throw new Error('Variable names cannot contain the active token prefix or suffix.');
    }
    if (type === 'property' && !definition.file?.trim()) throw new Error('A source note is required.');
    if (type === 'property' && !definition.property?.trim()) {
      throw new Error('A property name is required.');
    }
    if (!this.registryFile && !this.registryPath) throw new Error('The registry file is not loaded.');
    if (oldName && oldName !== variableName && this.data.has(variableName)) {
      throw new Error(`A Variable Link named “${variableName}” already exists.`);
    }

    const existing = this.data.get(oldName || variableName);
    if (!this.data.has(variableName)
      && variableName !== oldName
      && parseVariableTextCaseMarker(variableName)
      && !await this.confirmReservedTextCaseName(variableName)) {
      throw new Error('The variable name change was cancelled.');
    }
    const guid = existing?.guid || definition.guid || this.createGuid();
    const normalized: Partial<VariableDefinition> = {
      guid,
      type,
      file: definition.file.trim(),
      property: definition.property.trim()
    };
    if (type === 'fixed') normalized.value = definition.value ?? '';
    else if (Object.prototype.hasOwnProperty.call(definition, 'value')) {
      normalized.value = definition.value;
    }
    if (Object.prototype.hasOwnProperty.call(definition, 'link')) {
      normalized.link = definition.link?.trim() || undefined;
    }
    if (Object.prototype.hasOwnProperty.call(definition, 'textCase')) {
      normalized.textCase = normalizeVariableTextCase(definition.textCase);
    }
    if (Object.prototype.hasOwnProperty.call(definition, 'card')) normalized.card = definition.card;
    if (Object.prototype.hasOwnProperty.call(definition, 'appearance')) {
      normalized.appearance = normalizeVariableAppearance(definition.appearance);
    }
    if (Object.prototype.hasOwnProperty.call(definition, 'customAppearance')) {
      normalized.customAppearance = normalizeVariableAppearance(definition.customAppearance);
    }
    if (Object.prototype.hasOwnProperty.call(definition, 'favorite')) normalized.favorite = definition.favorite === true;
    if (Object.prototype.hasOwnProperty.call(definition, 'managed')) {
      normalized.managed = normalizeManagedAutolinkEntry(definition.managed);
    }
    const rename = !!oldName && oldName !== variableName;
    const tokenCache = this.plugin.tokenCache;
    if (rename && !tokenCache) {
      throw new Error('The token cache is unavailable, so the rename was cancelled.');
    }
    const renamePlan = rename && tokenCache ? await tokenCache.prepareRename(guid, oldName, variableName) : null;

    if (renamePlan) await renamePlan.apply();
    try {
      await this.mutateRegistryLinks((links) => {
        const current = links[oldName || variableName];
        const stored: Record<string, unknown> = this.isRecord(current) ? current : {};
        const updated: Record<string, unknown> = { ...stored, ...normalized };
        if (definition.display?.trim()) updated.display = definition.display.trim();
        else delete updated.display;
        if (Object.prototype.hasOwnProperty.call(definition, 'link') && !definition.link?.trim()) {
          delete updated.link;
        }
        if (Object.prototype.hasOwnProperty.call(definition, 'textCase') && !normalized.textCase) {
          delete updated.textCase;
        }
        if (Object.prototype.hasOwnProperty.call(definition, 'value')
          && definition.value === undefined) delete updated.value;
        if (Object.prototype.hasOwnProperty.call(definition, 'favorite') && !definition.favorite) delete updated.favorite;
        if (Object.prototype.hasOwnProperty.call(definition, 'card') && !definition.card) delete updated.card;
        if (Object.prototype.hasOwnProperty.call(definition, 'appearance') && !normalized.appearance) {
          delete updated.appearance;
        }
        if (Object.prototype.hasOwnProperty.call(definition, 'customAppearance')
          && !normalized.customAppearance) delete updated.customAppearance;
        if (Object.prototype.hasOwnProperty.call(definition, 'managed') && !normalized.managed) {
          delete updated.managed;
        }
        links[variableName] = updated;
        if (rename) delete links[oldName];
      });
    } catch (error) {
      if (renamePlan) await renamePlan.rollback();
      throw error;
    }

    if (rename && oldName) {
      try {
        await this.plugin.renameInfoCardEditorCollapsedItems(oldName, variableName);
      } catch {
        new Notice('The variable was renamed, but its card designer collapse state could not be moved.');
      }
    }

    // Once the registry write succeeds, the rename is authoritative. Derived
    // indexes may be rebuilt, but must never roll note text back independently.
    try {
      await this.load();
    } catch {
      new Notice('The rename was saved, but the registry view could not be refreshed. Reload Obsidian.');
      return;
    }
    try {
      await this.plugin.indexer?.build();
    } catch {
      // The registry remains authoritative; derived indexes can rebuild later.
    }

    if (renamePlan) {
      try {
        await renamePlan.commit();
      } catch {
        try { await tokenCache?.rebuild(); }
        catch {
          // A later vault event will retry the cache rebuild.
        }
      }
    } else if (!existing && tokenCache) {
      try { await tokenCache.rebuild(); }
      catch {
        // A later vault event will retry the cache rebuild.
      }
    }
    this.plugin.livePreviewRenderer?.refresh();
    await this.plugin.refreshManagementCenterViews();
  }

  async renameVariables(renames: readonly VariableRename[]): Promise<VariableRenameResult> {
    if (!this.registryFile && !this.registryPath) throw new Error('The registry file is not loaded.');
    const normalized = renames
      .map(({ guid, oldName, newName }) => ({
        guid: guid.trim(),
        oldName: oldName.trim(),
        newName: newName.trim(),
      }))
      .filter(({ oldName, newName }) => oldName !== newName);
    if (!normalized.length) return { renamed: 0, fileCount: 0, tokenCount: 0 };
    const oldNames = new Set<string>();
    const newNames = new Set<string>();
    const tokenSyntax = getTokenSyntax(this.plugin.settings);
    for (const rename of normalized) {
      if (!rename.guid || !rename.oldName || !rename.newName) {
        throw new Error('Every mass rename requires a GUID, current name, and new name.');
      }
      if (oldNames.has(rename.oldName)) throw new Error(`“${rename.oldName}” is selected more than once.`);
      if (newNames.has(rename.newName)) throw new Error(`More than one variable would be named “${rename.newName}”.`);
      oldNames.add(rename.oldName);
      newNames.add(rename.newName);
      const definition = this.data.get(rename.oldName);
      if (!definition || definition.guid !== rename.guid) {
        throw new Error(`“${rename.oldName}” changed after the preview was prepared.`);
      }
      if (rename.newName.includes(tokenSyntax.prefix) || rename.newName.includes(tokenSyntax.suffix)) {
        throw new Error(`“${rename.newName}” contains the active token prefix or suffix.`);
      }
      if (parseVariableTextCaseMarker(rename.newName)) {
        throw new Error(`“${rename.newName}” resembles reserved token text-case syntax. Rename it individually instead.`);
      }
    }
    for (const { newName } of normalized) {
      if (this.data.has(newName) && !oldNames.has(newName)) {
        throw new Error(`A Variable Link named “${newName}” already exists.`);
      }
    }
    const tokenCache = this.plugin.tokenCache;
    if (!tokenCache) throw new Error('The token cache is unavailable, so the mass rename was cancelled.');
    const renamePlan = await tokenCache.prepareBulkRename(normalized);
    await renamePlan.apply();
    const definitions = new Map(
      normalized.map(({ oldName }) => [oldName, this.data.get(oldName)]),
    );
    try {
      await this.mutateRegistryLinks((links) => {
        const stored = new Map<string, unknown>();
        for (const { guid, oldName } of normalized) {
          const current = links[oldName];
          if (!this.isRecord(current) || current.guid !== guid) {
            throw new Error(`“${oldName}” changed after the preview was prepared.`);
          }
          stored.set(oldName, current);
        }
        for (const { oldName } of normalized) delete links[oldName];
        for (const { oldName, newName } of normalized) links[newName] = stored.get(oldName);
      });
    } catch (error) {
      await renamePlan.rollback();
      throw error;
    }

    try {
      await this.plugin.renameInfoCardEditorCollapsedItemsBatch(
        normalized.map(({ oldName, newName }) => ({ previousName: oldName, nextName: newName })),
      );
    } catch {
      new Notice('The variables were renamed, but some card designer collapse state could not be moved.');
    }
    try {
      await this.load();
    } catch {
      for (const { oldName } of normalized) this.data.delete(oldName);
      for (const { oldName, newName } of normalized) {
        const definition = definitions.get(oldName);
        if (definition) this.data.set(newName, definition);
      }
      new Notice('The variables were renamed, but the registry view could not be reloaded. Reload Obsidian.');
    }
    try {
      await this.plugin.indexer?.build();
    } catch {
      new Notice('The variables were renamed, but the search index could not be refreshed. Reload Obsidian.');
    }
    try {
      await renamePlan.commit();
    } catch {
      try {
        await tokenCache.rebuild();
      } catch {
        new Notice('The variables were renamed, but the token cache could not be refreshed. Rebuild it from settings.');
      }
    }
    this.plugin.livePreviewRenderer?.refresh();
    try {
      await this.plugin.refreshManagementCenterViews();
    } catch {
      // The saved renames remain authoritative; open views can refresh later.
    }
    return {
      renamed: normalized.length,
      fileCount: renamePlan.fileCount,
      tokenCount: renamePlan.tokenCount,
    };
  }

  async deleteVariable(name: string) {
    await this.deleteVariables([name]);
  }

  async deleteVariables(names: readonly string[]): Promise<number> {
    const variableNames = [...new Set(names.map((name) => name.trim()))]
      .filter((name) => name && this.data.has(name));
    if (!variableNames.length) return 0;
    const guids = variableNames
      .map((name) => this.data.get(name)?.guid)
      .filter((guid): guid is string => Boolean(guid));
    await this.mutateRegistryLinks((links) => {
      for (const variableName of variableNames) delete links[variableName];
    });
    try {
      await this.load();
    } catch {
      for (const variableName of variableNames) this.data.delete(variableName);
      new Notice('The variables were deleted, but the registry view could not be reloaded. Reload Obsidian.');
    }
    try {
      await this.plugin.indexer?.build();
    } catch {
      new Notice('The variables were deleted, but the search index could not be refreshed. Reload Obsidian.');
    }
    try {
      if (guids.length) await this.plugin.tokenCache?.removeGuids(guids);
    } catch {
      new Notice('The variables were deleted, but the token cache could not be refreshed. Rebuild it from settings.');
    }
    let collapseStateFailed = false;
    for (const variableName of variableNames) {
      try {
        await this.plugin.saveInfoCardEditorCollapsedItems(variableName, []);
      } catch {
        collapseStateFailed = true;
      }
    }
    if (collapseStateFailed) {
      const subject = variableNames.length === 1 ? 'The variable was' : 'The variables were';
      new Notice(`${subject} deleted, but some saved card designer collapse state could not be removed.`);
    }
    this.plugin.livePreviewRenderer?.refresh();
    try {
      await this.plugin.refreshManagementCenterViews();
    } catch {
      // The saved deletion remains authoritative; open views can refresh later.
    }
    return variableNames.length;
  }

  private confirmReservedTextCaseName(variableName: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ReservedTextCaseNameModal(this.plugin, variableName, resolve).open();
    });
  }

  extractFrontmatter(content: string): Record<string, unknown> | null {
    // find the leading YAML frontmatter block
    if (!content.startsWith('---')) return null;
    const parts = content.split(/\r?\n/);
    // find closing '---' after first line
    let end = -1;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].trim() === '---') { end = i; break; }
    }
    if (end === -1) return null;
    const yamlLines = parts.slice(1, end).join('\n');
    try {
      const parsed: unknown = parseYaml(yamlLines);
      return this.isRecord(parsed) ? parsed : null;
    } catch (e) {
      new Notice('Variable Links: failed to parse registry YAML: ' + String(e));
      return null;
    }
  }

  parseRegistryFromContent(content: string, filePath: string): Record<string, unknown> | null {
    // Determine by extension
    const lower = (filePath || '').toLowerCase();
    try {
      if (lower.endsWith('.json')) {
        // parse entire file as JSON
        try {
          const parsed: unknown = JSON.parse(content);
          return this.isRecord(parsed) ? parsed : null;
        } catch (e) {
          new Notice('Variable Links: failed to parse JSON registry: ' + String(e));
          return null;
        }
      }

      if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
        try {
          const parsed: unknown = parseYaml(content);
          return this.isRecord(parsed) ? parsed : null;
        } catch (e) {
          new Notice('Variable Links: failed to parse YAML registry: ' + String(e));
          return null;
        }
      }

      // If markdown, prefer frontmatter
      if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
        const fm = this.extractFrontmatter(content);
        if (fm) return fm;

        // search for fenced code blocks labeled json/yaml
        const fenceRe = /```(json|yaml|yml)\s([\s\S]*?)```/g;
        let m: RegExpExecArray | null;
        while ((m = fenceRe.exec(content)) !== null) {
          const lang = m[1].toLowerCase();
          const body = m[2];
          try {
            if (lang === 'json') {
              const parsed: unknown = JSON.parse(body);
              if (this.isRegistryDocument(parsed)) return parsed;
            } else {
              const parsed: unknown = parseYaml(body);
              if (this.isRegistryDocument(parsed)) return parsed;
            }
          } catch {
            // ignore parse errors here and keep looking
            continue;
          }
        }

        // As a last resort, try parsing entire file as YAML (some users may use pure YAML files saved as .md)
        try {
          const parsed: unknown = parseYaml(content);
          if (this.isRegistryDocument(parsed)) return parsed;
        } catch {
          // ignore
        }

        return null;
      }

      // Unknown extension — try YAML then JSON
      try {
        const parsed: unknown = parseYaml(content);
        if (this.isRegistryDocument(parsed)) return parsed;
      } catch {
        // ignore
      }
      try {
        const parsed: unknown = JSON.parse(content);
        if (this.isRegistryDocument(parsed)) return parsed;
      } catch {
        // ignore
      }

      return null;
    } catch (e) {
      new Notice('Variable Links: error parsing registry file: ' + String(e));
      return null;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toFixedValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    return undefined;
  }

  private isRegistryDocument(value: unknown): value is Record<string, unknown> {
    return this.isRecord(value) && this.isRecord(value['variable-links']);
  }

  private toCardConfig(value: unknown): CardConfig | undefined {
    if (!this.isRecord(value)) return undefined;
    const fields = Array.isArray(value.fields)
      ? value.fields.filter((field): field is string => typeof field === 'string')
      : undefined;
    const title = typeof value.title === 'string' ? value.title : undefined;
    const note = typeof value.note === 'string' ? value.note : undefined;
    const hasShowSourceLink = Object.prototype.hasOwnProperty.call(value, 'showSourceLink');
    const showSourceLink = value.showSourceLink === true;
    const blocks = normalizeCardBlocks(value.blocks);
    const hasLegacyFields = title !== undefined
      || note !== undefined
      || fields !== undefined
      || hasShowSourceLink;
    const derived = blocks && !hasLegacyFields ? deriveLegacyCardFields(blocks) : {};
    return {
      title: title ?? derived.title,
      note: note ?? derived.note,
      fields: fields ?? derived.fields,
      showSourceLink: hasShowSourceLink ? showSourceLink : derived.showSourceLink,
      blocks,
      useBlockLayout: value.useBlockLayout === true
        || (value.useBlockLayout !== false && Boolean(blocks && !hasLegacyFields)),
      layoutMode: value.layoutMode === 'grid'
        ? 'grid'
        : value.layoutMode === 'stack' ? 'stack' : undefined,
      gridColumns: normalizeGridColumns(value.gridColumns),
      layoutGap: normalizeLayoutGap(value.layoutGap),
      cardStyle: normalizeCardStyle(value.cardStyle),
      disableLivePreviewHover: value.disableLivePreviewHover === true,
    };
  }
}

export default Registry;
