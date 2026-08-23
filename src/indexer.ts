import { App } from 'obsidian';
import Registry, { getVariableType, VariableDefinition } from './registry';

export interface VariableIndexEntry {
  name: string;
  def: VariableDefinition;
  filePath?: string; // normalized vault path (e.g. People/John Smith.md)
}

export class Indexer {
  app: App;
  registry: Registry;
  byName: Map<string, VariableIndexEntry> = new Map();
  byFile: Map<string, Set<string>> = new Map();
  byProperty: Map<string, Set<string>> = new Map();

  constructor(app: App, registry: Registry) {
    this.app = app;
    this.registry = registry;
  }

  async build() {
    this.byName.clear();
    this.byFile.clear();
    this.byProperty.clear();

    for (const [name, def] of Array.from(this.registry.data.entries())) {
      const type = getVariableType(def);
      const filePath = this.normalizeFile(type === 'fixed' ? def.link : def.file);
      const entry: VariableIndexEntry = { name, def, filePath };
      this.byName.set(name, entry);

      if (filePath) {
        let s = this.byFile.get(filePath);
        if (!s) { s = new Set(); this.byFile.set(filePath, s); }
        s.add(name);
      }

      if (type === 'property' && def.property) {
        let ps = this.byProperty.get(def.property);
        if (!ps) { ps = new Set(); this.byProperty.set(def.property, ps); }
        ps.add(name);
      }
    }
  }

  normalizeFile(raw: unknown): string | undefined {
    if (!raw) return undefined;
    if (typeof raw !== 'string') return undefined;
    // already a wiki-link? strip [[ ]]
    const m = raw.match(/\[\[([^\]]+)\]\]/);
    let inner = m ? m[1].trim() : raw.trim();
    if (!/\.md$/i.test(inner)) inner = inner + '.md';
    return inner;
  }

  getByName(name: string): VariableIndexEntry | null {
    return this.byName.get(name) ?? null;
  }

  getVarsByFile(path: string): string[] {
    const s = this.byFile.get(path);
    return s ? Array.from(s) : [];
  }

  getVarsByProperty(property: string): string[] {
    const s = this.byProperty.get(property);
    return s ? Array.from(s) : [];
  }
}

export default Indexer;
