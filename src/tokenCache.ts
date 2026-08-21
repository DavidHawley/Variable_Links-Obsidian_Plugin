import { App, TFile } from 'obsidian';
import Registry from './registry';

type TokenLocation = { file: string; line: number; ch: number };
type CachedToken = { guid: string; name: string; locations: TokenLocation[] };
type CacheData = {
  version: 1;
  files: Record<string, { mtime: number; size: number }>;
  tokens: Record<string, CachedToken>;
};
type Occurrence = { name: string; start: number; end: number; line: number; ch: number };

export default class TokenCache {
  private app: App;
  private plugin: any;
  private registry: Registry;
  private cachePath: string;
  private data: CacheData = { version: 1, files: {}, tokens: {} };
  private listeners: Array<{ event: string; callback: any }> = [];
  private timers = new Map<string, any>();
  private active = true;
  private generation = 0;

  constructor(app: App, plugin: any, registry: Registry) {
    this.app = app;
    this.plugin = plugin;
    this.registry = registry;
    const configDir = (app.vault as any).configDir || '.obsidian';
    const pluginId = plugin.manifest?.id || 'variable-links';
    this.cachePath = `${configDir}/plugins/${pluginId}/token-cache.json`;
  }

  async initialize() {
    const generation = this.generation;
    const adapter = (this.app.vault as any).adapter;
    try {
      if (await adapter.exists(this.cachePath)) {
        const parsed = JSON.parse(await adapter.read(this.cachePath));
        if (parsed?.version === 1 && parsed.files && parsed.tokens) this.data = parsed;
      }
    } catch (error) {
      this.data = { version: 1, files: {}, tokens: {} };
    }
    if (!this.isCurrent(generation)) return;
    await this.synchronize();
    if (this.isCurrent(generation)) this.attach();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    const vault: any = this.app.vault;
    for (const listener of this.listeners) vault.off(listener.event, listener.callback);
    this.listeners = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async rebuild() {
    if (!this.active) return;
    this.data = { version: 1, files: {}, tokens: {} };
    await this.synchronize(true);
  }

  async synchronize(force = false) {
    if (!this.active) return;
    const generation = this.generation;
    const files: TFile[] = (this.app.vault as any).getMarkdownFiles?.() || [];
    const currentPaths = new Set(files.map((file) => file.path));
    for (const path of Object.keys(this.data.files)) {
      if (!currentPaths.has(path)) this.removeFile(path);
    }
    for (const file of files) {
      if (!this.isCurrent(generation)) return;
      const stat = (file as any).stat || {};
      const cached = this.data.files[file.path];
      if (force || !cached || cached.mtime !== stat.mtime || cached.size !== stat.size) await this.indexFile(file);
    }
    if (!this.isCurrent(generation)) return;
    this.syncTokenNames();
    await this.persist();
  }

  async removeGuid(guid: string) {
    if (!this.active) return;
    delete this.data.tokens[guid];
    await this.persist();
  }

  async prepareRename(guid: string, oldName: string, newName: string) {
    if (!this.active) throw new Error('The token cache is not active.');
    await this.synchronize();
    if (!this.data.tokens[guid]) await this.rebuild();
    let paths = Array.from(new Set((this.data.tokens[guid]?.locations || []).map((location) => location.file)));
    if (!paths.length) paths = ((this.app.vault as any).getMarkdownFiles?.() || []).map((file: TFile) => file.path);
    const files = paths
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => file instanceof TFile);
    const applied: Array<{ file: TFile; original: string; updated: string }> = [];
    const cache = this;

    const rollback = async () => {
      for (const change of [...applied].reverse()) {
        try {
          await (cache.app.vault as any).process(change.file, (current: string) =>
            current === change.updated ? change.original : current
          );
        } catch (error) {}
      }
      applied.length = 0;
      await cache.rebuild();
    };

    return {
      apply: async () => {
        try {
          for (const file of files) {
            const preview = await cache.app.vault.read(file);
            if (cache.replaceToken(preview, oldName, newName) === preview) continue;
            let original = '';
            let updated = '';
            await (cache.app.vault as any).process(file, (current: string) => {
              original = current;
              updated = cache.replaceToken(current, oldName, newName);
              return updated;
            });
            if (updated !== original) applied.push({ file, original, updated });
          }
        } catch (error) {
          await rollback();
          throw error;
        }
      },
      rollback,
      commit: async () => {
        for (const change of applied) await cache.indexFile(change.file);
        if (!cache.data.tokens[guid]) cache.data.tokens[guid] = { guid, name: newName, locations: [] };
        cache.data.tokens[guid].name = newName;
        cache.syncTokenNames();
        await cache.persist();
      }
    };
  }

  private attach() {
    if (!this.active || this.listeners.length) return;
    const vault: any = this.app.vault;
    const add = (event: string, callback: any) => {
      if (!this.active) return;
      vault.on(event, callback);
      this.listeners.push({ event, callback });
    };
    add('modify', (file: TFile) => this.schedule(file));
    add('create', (file: TFile) => this.schedule(file));
    add('delete', (file: TFile) => {
      if (!this.active) return;
      if (!this.isMarkdown(file)) return;
      this.removeFile(file.path);
      void this.persist();
    });
    add('rename', (file: TFile, oldPath: string) => {
      if (!this.active) return;
      this.removeFile(oldPath);
      this.schedule(file);
    });
  }

  private schedule(file: TFile) {
    if (!this.active || !this.isMarkdown(file)) return;
    const prior = this.timers.get(file.path);
    if (prior) clearTimeout(prior);
    this.timers.set(file.path, setTimeout(async () => {
      this.timers.delete(file.path);
      if (!this.active) return;
      try { await this.indexFile(file); await this.persist(); }
      catch (error) {}
    }, 150));
  }

  private isMarkdown(file: any) {
    return file instanceof TFile && /\.md$/i.test(file.path);
  }

  private async indexFile(file: TFile) {
    if (!this.active) return;
    const generation = this.generation;
    const content = await this.app.vault.read(file);
    if (!this.isCurrent(generation)) return;
    this.removeFile(file.path);
    for (const occurrence of this.findTokens(content)) {
      const definition = this.registry.getVariable(occurrence.name);
      if (!definition?.guid) continue;
      const token = this.data.tokens[definition.guid] || {
        guid: definition.guid,
        name: occurrence.name,
        locations: []
      };
      token.name = occurrence.name;
      token.locations.push({ file: file.path, line: occurrence.line, ch: occurrence.ch });
      this.data.tokens[definition.guid] = token;
    }
    const stat = (file as any).stat || {};
    this.data.files[file.path] = { mtime: stat.mtime || 0, size: stat.size || content.length };
  }

  private removeFile(path: string) {
    delete this.data.files[path];
    for (const token of Object.values(this.data.tokens)) {
      token.locations = token.locations.filter((location) => location.file !== path);
    }
  }

  private syncTokenNames() {
    const validGuids = new Set<string>();
    for (const [name, definition] of this.registry.data) {
      if (!definition.guid) continue;
      validGuids.add(definition.guid);
      const token = this.data.tokens[definition.guid] || { guid: definition.guid, name, locations: [] };
      token.name = name;
      this.data.tokens[definition.guid] = token;
    }
    for (const guid of Object.keys(this.data.tokens)) if (!validGuids.has(guid)) delete this.data.tokens[guid];
  }

  private replaceToken(content: string, oldName: string, newName: string) {
    const occurrences = this.findTokens(content).filter((occurrence) => occurrence.name === oldName);
    let updated = content;
    for (const occurrence of occurrences.reverse()) {
      updated = updated.slice(0, occurrence.start) + `{{${newName}}}` + updated.slice(occurrence.end);
    }
    return updated;
  }

  private findTokens(content: string): Occurrence[] {
    const occurrences: Occurrence[] = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let offset = 0;
    let lineNumber = 1;
    let fence: '`' | '~' | null = null;
    let fenceLength = 0;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(content)) !== null) {
      const raw = lineMatch[0];
      if (!raw && linePattern.lastIndex >= content.length) break;
      const line = raw.replace(/\r\n$|\n$|\r$/, '');
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0] as '`' | '~';
        if (!fence) { fence = marker; fenceLength = fenceMatch[1].length; }
        else if (fence === marker && fenceMatch[1].length >= fenceLength) { fence = null; fenceLength = 0; }
      } else if (!fence) {
        const tokenPattern = /\{\{\s*([^}\s]+)\s*\}\}/g;
        let tokenMatch: RegExpExecArray | null;
        while ((tokenMatch = tokenPattern.exec(line)) !== null) {
          if (this.isInsideInlineCode(line, tokenMatch.index)) continue;
          occurrences.push({
            name: tokenMatch[1].trim(),
            start: offset + tokenMatch.index,
            end: offset + tokenPattern.lastIndex,
            line: lineNumber,
            ch: tokenMatch.index + 1
          });
        }
      }
      offset += raw.length;
      lineNumber++;
    }
    return occurrences;
  }

  private isInsideInlineCode(line: string, index: number) {
    let openLength = 0;
    for (let position = 0; position < index;) {
      if (line[position] !== '`') { position++; continue; }
      let end = position;
      while (end < index && line[end] === '`') end++;
      const length = end - position;
      if (!openLength) openLength = length;
      else if (length === openLength) openLength = 0;
      position = end;
    }
    return openLength > 0;
  }

  private async persist() {
    if (!this.active) return;
    const adapter = (this.app.vault as any).adapter;
    await adapter.write(this.cachePath, JSON.stringify(this.data, null, 2) + '\n');
  }

  private isCurrent(generation: number) {
    return this.active && this.generation === generation;
  }
}
