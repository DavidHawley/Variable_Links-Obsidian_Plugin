import { App, TFile, parseYaml, stringifyYaml, Notice } from 'obsidian';
import VariableLinksPlugin from './main';
import { VariableLinksSettings } from './settings';

export interface VariableDefinition {
  guid?: string;
  file: string; // vault path or wiki-link raw
  property: string;
  display?: string;
  favorite?: boolean;
  card?: any;
  format?: any;
}

export class Registry {
  app: App;
  plugin: VariableLinksPlugin;
  settings: VariableLinksSettings;
  data: Map<string, VariableDefinition> = new Map();
  registryFile: TFile | null = null;
  registryPath: string = '';
  modifyHandler: ((file: TFile) => void) | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
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
    const adapter = (this.app.vault as any).adapter;
    const parts = path.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await adapter.exists(current)) await adapter.mkdir(current);
    }
  }

  private async createRegistry(path: string): Promise<TFile | null> {
    const vault: any = this.app.vault;
    const configDir = vault.configDir || '.obsidian';
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
    const generation = this.generation;
    this.settings = this.plugin.settings;
    const path = this.settings.registryFilePath.replace(/\\/g, '/');
    if (!path) {
      new Notice('Variable Links: registryFilePath not set');
      return;
    }

    this.registryPath = path;
    const adapter = (this.app.vault as any).adapter;
    let abstractFile = this.app.vault.getAbstractFileByPath(path);
    let file = abstractFile instanceof TFile ? abstractFile : null;
    if (!file && !await adapter.exists(path)) {
      file = await this.createRegistry(path);
      new Notice('Variable Links: created registry at ' + path);
    }
    this.registryFile = file;
    const content = file ? await this.app.vault.read(file) : await adapter.read(path);
    if (!this.isCurrent(generation)) return;

    // Try to parse registry using intelligent handling based on extension and content
    const parsed = this.parseRegistryFromContent(content, path);
    if (!parsed || typeof parsed !== 'object') {
      new Notice('Variable Links: failed to parse registry from file: ' + path);
      this.data.clear();
      return;
    }

    const variableLinks = parsed['variable-links'];
    if (!variableLinks || typeof variableLinks !== 'object') {
      new Notice('Variable Links: no "variable-links" section in registry file');
      this.data.clear();
      return;
    }

    this.data.clear();
    const generatedGuids = new Map<string, string>();
    const usedGuids = new Set<string>();
    for (const [key, raw] of Object.entries(variableLinks)) {
      if (typeof raw === 'object' && raw !== null) {
        let guid = typeof (raw as any).guid === 'string' ? (raw as any).guid.trim() : '';
        if (!guid || usedGuids.has(guid)) {
          do { guid = this.createGuid(); } while (usedGuids.has(guid));
          generatedGuids.set(String(key), guid);
        }
        usedGuids.add(guid);
        const def: VariableDefinition = {
          guid,
          file: (raw as any).file,
          property: (raw as any).property,
          display: (raw as any).display,
          favorite: (raw as any).favorite === true,
          card: (raw as any).card,
          format: (raw as any).format
        };
        this.data.set(String(key), def);
      }
    }
    if (generatedGuids.size) {
      await this.mutateRegistryLinks((links) => {
        for (const [name, guid] of generatedGuids) {
          if (links[name]) links[name].guid = guid;
        }
      });
      if (!this.isCurrent(generation)) return;
    }

    // register vault change listener to reload registry when the file is modified
    if (this.modifyHandler) {
      this.app.vault.off('modify', this.modifyHandler as any);
      this.modifyHandler = null;
    }
    if (file) {
      this.modifyHandler = (f: TFile) => {
        if (!this.active || !this.registryFile || f.path !== this.registryFile.path) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          if (this.active) void this.load();
        }, 50);
      };
      this.app.vault.on('modify', this.modifyHandler);
    }

  }

  unload() {
    this.active = false;
    this.generation++;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.modifyHandler) {
      this.app.vault.off('modify', this.modifyHandler as any);
      this.modifyHandler = null;
    }
  }

  private isCurrent(generation: number) {
    return this.active && this.generation === generation;
  }

  getVariable(name: string) {
    return this.data.get(name) ?? null;
  }

  private createGuid(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.random() * 16 | 0;
      return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
    });
  }

  private async mutateRegistryLinks(mutator: (links: any) => void) {
    const file = this.registryFile;
    const adapter = (this.app.vault as any).adapter;
    const path = this.registryPath;
    const lowerPath = path.toLowerCase();
    if ((lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx'))
      && file && typeof (this.app as any).fileManager?.processFrontMatter === 'function') {
      await (this.app as any).fileManager.processFrontMatter(file, (frontmatter: any) => {
        frontmatter['variable-links'] = frontmatter['variable-links'] || {};
        mutator(frontmatter['variable-links']);
      });
      return;
    }

    const content = file ? await this.app.vault.read(file) : await adapter.read(path);
    const registry = this.parseRegistryFromContent(content, path);
    if (!registry || typeof registry !== 'object') throw new Error('The registry must contain valid JSON or YAML.');
    registry['variable-links'] = registry['variable-links'] || {};
    mutator(registry['variable-links']);
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

  /** Persist a mapping. A rename keeps the GUID and updates verified token references. */
  async saveVariable(name: string, definition: VariableDefinition, previousName?: string) {
    const variableName = name.trim();
    const oldName = previousName?.trim();
    if (!variableName) throw new Error('Variable name is required.');
    if (!definition.file?.trim()) throw new Error('A source note is required.');
    if (!definition.property?.trim()) throw new Error('A property name is required.');
    if (!this.registryFile && !this.registryPath) throw new Error('The registry file is not loaded.');
    if (oldName && oldName !== variableName && this.data.has(variableName)) {
      throw new Error(`A Variable Link named “${variableName}” already exists.`);
    }

    const existing = this.data.get(oldName || variableName);
    const guid = existing?.guid || definition.guid || this.createGuid();
    const normalized: Partial<VariableDefinition> = {
      guid,
      file: definition.file.trim(),
      property: definition.property.trim()
    };
    if (Object.prototype.hasOwnProperty.call(definition, 'card')) normalized.card = definition.card;
    if (Object.prototype.hasOwnProperty.call(definition, 'favorite')) normalized.favorite = definition.favorite === true;
    const rename = !!oldName && oldName !== variableName;
    const tokenCache = (this.plugin as any).tokenCache;
    if (rename && !tokenCache) {
      throw new Error('The token cache is unavailable, so the rename was cancelled.');
    }
    const renamePlan = rename && tokenCache ? await tokenCache.prepareRename(guid, oldName!, variableName) : null;

    if (renamePlan) await renamePlan.apply();
    try {
      await this.mutateRegistryLinks((links) => {
        const stored = links[oldName || variableName] || {};
        const updated: any = { ...stored, ...normalized };
        if (definition.display?.trim()) updated.display = definition.display.trim();
        else delete updated.display;
        if (Object.prototype.hasOwnProperty.call(definition, 'favorite') && !definition.favorite) delete updated.favorite;
        if (Object.prototype.hasOwnProperty.call(definition, 'card') && !definition.card) delete updated.card;
        links[variableName] = updated;
        if (rename) delete links[oldName!];
      });
    } catch (error) {
      if (renamePlan) await renamePlan.rollback();
      throw error;
    }

    // Once the registry write succeeds, the rename is authoritative. Derived
    // indexes may be rebuilt, but must never roll note text back independently.
    try {
      await this.load();
    } catch (error) {
      new Notice('Variable Links: the rename was saved, but the registry view could not be refreshed. Reload Obsidian.');
      return;
    }
    try {
      await (this.plugin as any).indexer?.build();
    } catch (error) {}

    if (renamePlan) {
      try {
        await renamePlan.commit();
      } catch (error) {
        try { await tokenCache.rebuild(); }
        catch (rebuildError) {}
      }
    } else if (!existing && tokenCache) {
      try { await tokenCache.rebuild(); }
      catch (error) {}
    }
    this.plugin.livePreviewRenderer?.refresh();
  }

  async deleteVariable(name: string) {
    const variableName = name.trim();
    if (!variableName) return;
    const guid = this.data.get(variableName)?.guid;
    await this.mutateRegistryLinks((links) => delete links[variableName]);
    await this.load();
    await (this.plugin as any).indexer?.build();
    if (guid) await (this.plugin as any).tokenCache?.removeGuid(guid);
    this.plugin.livePreviewRenderer?.refresh();
  }

  extractFrontmatter(content: string): any | null {
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
      const parsed = parseYaml(yamlLines);
      return parsed;
    } catch (e) {
      new Notice('Variable Links: failed to parse registry YAML: ' + String(e));
      return null;
    }
  }

  parseRegistryFromContent(content: string, filePath: string): any | null {
    // Determine by extension
    const lower = (filePath || '').toLowerCase();
    try {
      if (lower.endsWith('.json')) {
        // parse entire file as JSON
        try {
          const obj = JSON.parse(content);
          return obj;
        } catch (e) {
          new Notice('Variable Links: failed to parse JSON registry: ' + String(e));
          return null;
        }
      }

      if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
        try {
          const obj = parseYaml(content);
          return obj;
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
              const obj = JSON.parse(body);
              if (obj && obj['variable-links']) return obj;
            } else {
              const obj = parseYaml(body);
              if (obj && obj['variable-links']) return obj;
            }
          } catch (e) {
            // ignore parse errors here and keep looking
            continue;
          }
        }

        // As a last resort, try parsing entire file as YAML (some users may use pure YAML files saved as .md)
        try {
          const obj = parseYaml(content);
          if (obj && obj['variable-links']) return obj;
        } catch (e) {
          // ignore
        }

        return null;
      }

      // Unknown extension — try YAML then JSON
      try {
        const yamlObj = parseYaml(content);
        if (yamlObj && yamlObj['variable-links']) return yamlObj;
      } catch (e) {
        // ignore
      }
      try {
        const jsonObj = JSON.parse(content);
        if (jsonObj && jsonObj['variable-links']) return jsonObj;
      } catch (e) {
        // ignore
      }

      return null;
    } catch (e) {
      new Notice('Variable Links: error parsing registry file: ' + String(e));
      return null;
    }
  }
}

export default Registry;
