import { App, TFile, parseYaml, Notice } from 'obsidian';
import Registry from './registry';
import { parseWikiLink } from './utils';

export interface ResolveResult {
  ok: boolean;
  value?: any;
  type?: string;
  sourceFile?: TFile | null;
  property?: string;
  error?: string;
}

export class Resolver {
  app: App;
  registry: Registry;

  constructor(app: App, registry: Registry) {
    this.app = app;
    this.registry = registry;
  }

  async resolve(variableName: string): Promise<ResolveResult> {
    const def = this.registry.getVariable(variableName);
    if (!def) {
      return { ok: false, error: `Variable '${variableName}' not found in registry` };
    }

    let rawFile = def.file as string;
    if (!rawFile) {
      return { ok: false, error: `Variable '${variableName}' has no file configured` };
    }

    // normalize wiki-link to path
    let path = rawFile;
    const m = rawFile.match(/\[\[([^\]]+)\]\]/);
    if (m) {
      path = m[1];
    }
    if (!/\.md$/i.test(path)) path = path + '.md';

    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) {
      return { ok: false, error: `Source file not found: ${path}`, sourceFile: null };
    }

    // Prefer metadataCache
    const cache = (this.app as any).metadataCache?.getFileCache?.(file) ?? null;
    let front: any = cache?.frontmatter ?? null;
    if (!front) {
      // fallback: read file and parse frontmatter
      try {
        const content = await this.app.vault.read(file);
        const fm = this.extractFrontmatter(content);
        front = fm ?? {};
      } catch (e) {
        return { ok: false, error: `Failed to read source file: ${String(e)}`, sourceFile: file };
      }
    }

    const prop = def.property;
    if (!prop) {
      return { ok: false, error: `Variable '${variableName}' has no property configured`, sourceFile: file };
    }

    const value = front?.[prop];
    if (typeof value === 'undefined') {
      return { ok: false, error: `Property '${prop}' not found in ${path}`, sourceFile: file, property: prop };
    }

    const res: ResolveResult = { ok: true, value, sourceFile: file, property: prop };

    // derive type
    if (Array.isArray(value)) res.type = 'array';
    else if (typeof value === 'boolean') res.type = 'boolean';
    else if (typeof value === 'number') res.type = 'number';
    else if (typeof value === 'string') res.type = 'string';
    else res.type = typeof value;

    return res;
  }

  extractFrontmatter(content: string): any | null {
    if (!content.startsWith('---')) return null;
    const parts = content.split(/\r?\n/);
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
      // parsing failure
      return null;
    }
  }
}

export default Resolver;
