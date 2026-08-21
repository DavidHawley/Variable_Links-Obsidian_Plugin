import { App, TFile, parseYaml, stringifyYaml, Notice } from 'obsidian';
import VariableLinksPlugin from './main';
import { VariableLinksSettings } from './settings';
import { parseWikiLink } from './utils';

export interface VariableDefinition {
  file: string; // vault path or wiki-link raw
  property: string;
  display?: string;
  card?: any;
  format?: any;
}

export class Registry {
  app: App;
  plugin: VariableLinksPlugin;
  settings: VariableLinksSettings;
  data: Map<string, VariableDefinition> = new Map();
  registryFile: TFile | null = null;
  modifyHandler: ((file: TFile) => void) | null = null;

  constructor(app: App, plugin: VariableLinksPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  async load() {
    this.settings = this.plugin.settings;
    const path = this.settings.registryFilePath;
    if (!path) {
      new Notice('Variable Links: registryFilePath not set');
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      new Notice('Variable Links: registry file not found at ' + path);
      this.registryFile = null;
      this.data.clear();
      return;
    }

    this.registryFile = file;

    // read file content
    const content = await this.app.vault.read(file as TFile);

    // Try to parse registry using intelligent handling based on extension and content
    const parsed = this.parseRegistryFromContent(content, file.path);
    if (!parsed || typeof parsed !== 'object') {
      new Notice('Variable Links: failed to parse registry from file: ' + file.path);
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
    for (const [key, raw] of Object.entries(variableLinks)) {
      if (typeof raw === 'object' && raw !== null) {
        const def: VariableDefinition = {
          file: (raw as any).file,
          property: (raw as any).property,
          display: (raw as any).display,
          card: (raw as any).card,
          format: (raw as any).format
        };
        this.data.set(String(key), def);
      }
    }

    // register vault change listener to reload registry when the file is modified
    if (this.modifyHandler) {
      this.app.vault.off('modify', this.modifyHandler as any);
      this.modifyHandler = null;
    }
    this.modifyHandler = (f: TFile) => {
      if (this.registryFile && f.path === this.registryFile.path) {
        // debounce briefly
        setTimeout(() => this.load(), 50);
      }
    };
    this.app.vault.on('modify', this.modifyHandler);

    console.log('Variable Links: registry loaded with', this.data.size, 'entries');
  }

  unload() {
    if (this.modifyHandler) {
      this.app.vault.off('modify', this.modifyHandler as any);
      this.modifyHandler = null;
    }
  }

  getVariable(name: string) {
    return this.data.get(name) ?? null;
  }

  /** Persist a registry mapping while preserving any Markdown body below its frontmatter. */
  async saveVariable(name: string, definition: VariableDefinition) {
    const variableName = name.trim();
    if (!variableName) throw new Error('Variable name is required.');
    if (!definition.file?.trim()) throw new Error('A source note is required.');
    if (!definition.property?.trim()) throw new Error('A property name is required.');
    if (!this.registryFile) throw new Error('The registry file is not loaded.');

    const file = this.registryFile;
    const content = await this.app.vault.read(file);
    const normalized: Partial<VariableDefinition> = {
      file: definition.file.trim(),
      property: definition.property.trim()
    };
    if (Object.prototype.hasOwnProperty.call(definition, 'card')) normalized.card = definition.card;
    const lowerPath = file.path.toLowerCase();
    const mergeDefinition = (existing: any) => {
      const updated: any = { ...(existing || {}), ...normalized };
      if (definition.display?.trim()) updated.display = definition.display.trim();
      else delete updated.display;
      if (Object.prototype.hasOwnProperty.call(definition, 'card') && !definition.card) delete updated.card;
      return updated;
    };

    // Let Obsidian update Markdown frontmatter instead of rewriting the note
    // ourselves. This is the reliable save path for a Markdown registry.
    if ((lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx'))
      && typeof (this.app as any).fileManager?.processFrontMatter === 'function') {
      await (this.app as any).fileManager.processFrontMatter(file, (frontmatter: any) => {
        frontmatter['variable-links'] = frontmatter['variable-links'] || {};
        frontmatter['variable-links'][variableName] = mergeDefinition(frontmatter['variable-links'][variableName]);
      });
      await this.load();
      await (this.plugin as any).indexer?.build();
      return;
    }

    if (lowerPath.endsWith('.json')) {
      const registry = JSON.parse(content || '{}');
      registry['variable-links'] = registry['variable-links'] || {};
      registry['variable-links'][variableName] = mergeDefinition(registry['variable-links'][variableName]);
      await this.app.vault.modify(file, JSON.stringify(registry, null, 2) + '\n');
    } else {
      const registry = this.parseRegistryFromContent(content, file.path);
      if (!registry || typeof registry !== 'object') {
        throw new Error('The registry must contain valid YAML or JSON.');
      }
      registry['variable-links'] = registry['variable-links'] || {};
      registry['variable-links'][variableName] = mergeDefinition(registry['variable-links'][variableName]);
      const yaml = stringifyYaml(registry).trimEnd();

      if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx')) {
        if (!content.startsWith('---')) throw new Error('The Markdown registry needs a YAML frontmatter block.');
        const closing = content.indexOf('\n---', 3);
        if (closing === -1) throw new Error('The registry frontmatter is not closed.');
        const bodyStart = content.indexOf('\n', closing + 4);
        const body = bodyStart === -1 ? '' : content.slice(bodyStart + 1);
        await this.app.vault.modify(file, `---\n${yaml}\n---${body ? `\n${body}` : '\n'}`);
      } else {
        await this.app.vault.modify(file, yaml + '\n');
      }
    }

    await this.load();
    await (this.plugin as any).indexer?.build();
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
