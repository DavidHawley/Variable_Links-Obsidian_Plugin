import { App, EventRef, Plugin, TAbstractFile, TFile } from 'obsidian';
import Registry from './registry';
import {
  findVariableTokens,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  type TokenSyntax,
} from './tokenSyntax';

type TokenLocation = { file: string; line: number; ch: number };
type CachedToken = { guid: string; name: string; locations: TokenLocation[] };
type CacheData = {
  version: 1;
  files: Record<string, { mtime: number; size: number }>;
  tokens: Record<string, CachedToken>;
};
type Occurrence = {
  name: string;
  start: number;
  end: number;
  line: number;
  ch: number;
  syntax: TokenSyntax;
};

export default class TokenCache {
  private app: App;
  private registry: Registry;
  private cachePath: string;
  private data: CacheData = { version: 1, files: {}, tokens: {} };
  private listeners: EventRef[] = [];
  private timers = new Map<string, number>();
  private active = true;
  private generation = 0;

  constructor(app: App, plugin: Plugin, registry: Registry) {
    this.app = app;
    this.registry = registry;
    const configDir = app.vault.configDir;
    const pluginId = plugin.manifest.id || 'variable-links';
    this.cachePath = `${configDir}/plugins/${pluginId}/token-cache.json`;
  }

  async initialize() {
    const generation = this.generation;
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.cachePath)) {
        const parsed: unknown = JSON.parse(await adapter.read(this.cachePath));
        if (this.isCacheData(parsed)) this.data = parsed;
      }
    } catch {
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
    for (const listener of this.listeners) this.app.vault.offref(listener);
    this.listeners = [];
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  async rebuild() {
    if (!this.active) return;
    this.data = { version: 1, files: {}, tokens: {} };
    await this.synchronize(true);
  }

  async updateFile(file: TFile): Promise<void> {
    if (!this.active || !this.isMarkdown(file)) return;
    await this.indexFile(file);
    await this.persist();
  }

  async synchronize(force = false) {
    if (!this.active) return;
    const generation = this.generation;
    const files = this.app.vault.getMarkdownFiles();
    const currentPaths = new Set(files.map((file) => file.path));
    for (const path of Object.keys(this.data.files)) {
      if (!currentPaths.has(path)) this.removeFile(path);
    }
    for (const file of files) {
      if (!this.isCurrent(generation)) return;
      const stat = file.stat;
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
    if (!paths.length) paths = this.app.vault.getMarkdownFiles().map((file) => file.path);
    const files = paths
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => file instanceof TFile);
    const applied: Array<{ file: TFile; original: string; updated: string }> = [];
    const rollback = async () => {
      for (const change of [...applied].reverse()) {
        try {
          await this.app.vault.process(change.file, (current) =>
            current === change.updated ? change.original : current
          );
        } catch {
          // Continue rolling back the remaining files.
        }
      }
      applied.length = 0;
      await this.rebuild();
    };

    return {
      apply: async () => {
        try {
          for (const file of files) {
            const preview = await this.app.vault.read(file);
            if (this.replaceToken(preview, oldName, newName) === preview) continue;
            let original = '';
            let updated = '';
            await this.app.vault.process(file, (current) => {
              original = current;
              updated = this.replaceToken(current, oldName, newName);
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
        for (const change of applied) await this.indexFile(change.file);
        if (!this.data.tokens[guid]) this.data.tokens[guid] = { guid, name: newName, locations: [] };
        this.data.tokens[guid].name = newName;
        this.syncTokenNames();
        await this.persist();
      }
    };
  }

  private attach() {
    if (!this.active || this.listeners.length) return;
    this.listeners.push(this.app.vault.on('modify', (file) => this.schedule(file)));
    this.listeners.push(this.app.vault.on('create', (file) => this.schedule(file)));
    this.listeners.push(this.app.vault.on('delete', (file) => {
      if (!this.active) return;
      if (!this.isMarkdown(file)) return;
      this.removeFile(file.path);
      void this.persist();
    }));
    this.listeners.push(this.app.vault.on('rename', (file, oldPath) => {
      if (!this.active) return;
      this.removeFile(oldPath);
      this.schedule(file);
    }));
  }

  private schedule(file: TAbstractFile): void {
    if (!this.active || !this.isMarkdown(file)) return;
    const prior = this.timers.get(file.path);
    if (prior) window.clearTimeout(prior);
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      if (!this.active) return;
      void this.reindexScheduled(file);
    }, 150));
  }

  private isMarkdown(file: TAbstractFile): file is TFile {
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
    const stat = file.stat;
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
      const replacement = formatVariableToken(newName, occurrence.syntax);
      updated = updated.slice(0, occurrence.start) + replacement + updated.slice(occurrence.end);
    }
    return updated;
  }

  private findTokens(content: string): Occurrence[] {
    const occurrences: Occurrence[] = [];
    const syntaxes = getRecognizedTokenSyntaxes(this.registry.plugin.settings);
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
        for (const tokenMatch of findVariableTokens(line, syntaxes)) {
          if (this.isInsideInlineCode(line, tokenMatch.start)) continue;
          occurrences.push({
            name: tokenMatch.name,
            start: offset + tokenMatch.start,
            end: offset + tokenMatch.end,
            line: lineNumber,
            ch: tokenMatch.start + 1,
            syntax: tokenMatch.syntax,
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
    await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.data, null, 2) + '\n');
  }

  private async reindexScheduled(file: TFile): Promise<void> {
    try {
      await this.indexFile(file);
      await this.persist();
    } catch {
      // The next vault event or manual rebuild will retry the cache update.
    }
  }

  private isCacheData(value: unknown): value is CacheData {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<CacheData>;
    return candidate.version === 1
      && typeof candidate.files === 'object'
      && candidate.files !== null
      && typeof candidate.tokens === 'object'
      && candidate.tokens !== null;
  }

  private isCurrent(generation: number) {
    return this.active && this.generation === generation;
  }
}
