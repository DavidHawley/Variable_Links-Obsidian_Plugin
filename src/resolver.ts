import { App, TFile, parseYaml } from 'obsidian';
import Registry, { getVariableType } from './registry';

export interface ResolveResult {
  ok: boolean;
  value?: unknown;
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

    if (getVariableType(def) === 'fixed') {
      return {
        ok: true,
        value: def.value ?? '',
        type: 'string',
        sourceFile: null,
      };
    }

    const rawFile = def.file;
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

    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) {
      return { ok: false, error: `Source file not found: ${path}`, sourceFile: null };
    }

    // Prefer metadataCache
    const cached: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    let frontmatter = this.isRecord(cached) ? cached : null;
    if (!frontmatter) {
      // fallback: read file and parse frontmatter
      try {
        const content = await this.app.vault.read(file);
        const fm = this.extractFrontmatter(content);
        frontmatter = fm ?? {};
      } catch (e) {
        return { ok: false, error: `Failed to read source file: ${String(e)}`, sourceFile: file };
      }
    }

    const prop = def.property;
    if (!prop) {
      return { ok: false, error: `Variable '${variableName}' has no property configured`, sourceFile: file };
    }

    const value = frontmatter[prop];
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

  extractFrontmatter(content: string): Record<string, unknown> | null {
    if (!content.startsWith('---')) return null;
    const parts = content.split(/\r?\n/);
    let end = -1;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].trim() === '---') { end = i; break; }
    }
    if (end === -1) return null;
    const yamlLines = parts.slice(1, end).join('\n');
    try {
      const parsed: unknown = parseYaml(yamlLines);
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export default Resolver;
