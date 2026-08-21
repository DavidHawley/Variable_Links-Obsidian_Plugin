import { App, TFile, parseYaml, Notice } from 'obsidian';
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
