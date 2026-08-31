import { App, EventRef, Plugin, TAbstractFile, TFile } from 'obsidian';
import Registry from './registry';
import {
  findVariableTokens,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  tokenSyntaxEquals,
  type TokenSyntax,
} from './tokenSyntax';
import type { VariableTextCase } from './textCase';

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
  textCase?: VariableTextCase;
};
type MarkdownProtectionState = {
  htmlComment: boolean;
  mathBlock: boolean;
  isProtected: boolean;
};

export interface TokenSyntaxMigrationPlan {
  fileCount: number;
  tokenCount: number;
  apply(): Promise<void>;
  rollback(): Promise<void>;
}

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
    await this.removeGuids([guid]);
  }

  async removeGuids(guids: readonly string[]) {
    if (!this.active) return;
    for (const guid of new Set(guids)) delete this.data.tokens[guid];
    await this.persist();
  }

  async countGuidLocations(guids: readonly string[]): Promise<number> {
    if (!this.active) return 0;
    await this.synchronize();
    let count = 0;
    for (const guid of new Set(guids)) count += this.data.tokens[guid]?.locations.length ?? 0;
    return count;
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

  async prepareSyntaxMigration(
    previousSyntax: TokenSyntax,
    nextSyntax: TokenSyntax,
  ): Promise<TokenSyntaxMigrationPlan> {
    if (!this.active) throw new Error('The token cache is not active.');
    if (tokenSyntaxEquals(previousSyntax, nextSyntax)) {
      throw new Error('The current and proposed token formats are identical.');
    }
    await this.synchronize(true);
    if (!this.active) throw new Error('The token cache stopped during migration preparation.');

    const paths = new Set<string>();
    for (const token of Object.values(this.data.tokens)) {
      for (const location of token.locations) paths.add(location.file);
    }
    const changes: Array<{
      file: TFile;
      original: string;
      updated: string;
      tokenCount: number;
    }> = [];
    for (const path of paths) {
      const abstractFile = this.app.vault.getAbstractFileByPath(path);
      if (!(abstractFile instanceof TFile)) continue;
      const original = await this.app.vault.read(abstractFile);
      const occurrences = this.findTokens(original, [previousSyntax]).filter((occurrence) => {
        const definition = this.registry.getVariable(occurrence.name);
        return Boolean(definition?.guid);
      });
      if (!occurrences.length) continue;
      let updated = original;
      for (const occurrence of occurrences.reverse()) {
        updated = updated.slice(0, occurrence.start)
          + formatVariableToken(occurrence.name, nextSyntax, occurrence.textCase)
          + updated.slice(occurrence.end);
      }
      changes.push({
        file: abstractFile,
        original,
        updated,
        tokenCount: occurrences.length,
      });
    }

    const applied: typeof changes = [];
    const rollback = async (): Promise<void> => {
      for (const change of [...applied].reverse()) {
        try {
          await this.app.vault.process(change.file, (current) =>
            current === change.updated ? change.original : current
          );
        } catch {
          // Continue restoring the remaining files.
        }
      }
      applied.length = 0;
    };
    const apply = async (): Promise<void> => {
      if (!this.active) throw new Error('The token cache is not active.');
      try {
        for (const change of changes) {
          await this.app.vault.process(change.file, (current) => {
            if (current !== change.original) {
              throw new Error(`${change.file.path} changed after the migration preview was prepared.`);
            }
            return change.updated;
          });
          applied.push(change);
        }
      } catch (error) {
        await rollback();
        throw error;
      }
    };

    return {
      fileCount: changes.length,
      tokenCount: changes.reduce((total, change) => total + change.tokenCount, 0),
      apply,
      rollback,
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
      const replacement = formatVariableToken(newName, occurrence.syntax, occurrence.textCase);
      updated = updated.slice(0, occurrence.start) + replacement + updated.slice(occurrence.end);
    }
    return updated;
  }

  private findTokens(
    content: string,
    syntaxes: readonly TokenSyntax[] = getRecognizedTokenSyntaxes(
      this.registry.plugin.settings,
    ),
  ): Occurrence[] {
    const occurrences: Occurrence[] = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let offset = 0;
    let lineNumber = 1;
    let fence: '`' | '~' | null = null;
    let fenceLength = 0;
    let frontmatter = false;
    let frontmatterChecked = false;
    let htmlComment = false;
    let mathBlock = false;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(content)) !== null) {
      const raw = lineMatch[0];
      if (!raw && linePattern.lastIndex >= content.length) break;
      const line = raw.replace(/\r\n$|\n$|\r$/, '');

      if (!frontmatterChecked) {
        frontmatterChecked = true;
        if (line.replace(/^\uFEFF/, '') === '---') {
          frontmatter = true;
          offset += raw.length;
          lineNumber++;
          continue;
        }
      } else if (frontmatter) {
        if (/^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
        offset += raw.length;
        lineNumber++;
        continue;
      }

      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch && !htmlComment && !mathBlock) {
        const marker = fenceMatch[1][0] as '`' | '~';
        if (!fence) { fence = marker; fenceLength = fenceMatch[1].length; }
        else if (fence === marker && fenceMatch[1].length >= fenceLength) { fence = null; fenceLength = 0; }
      } else if (!fence) {
        for (const tokenMatch of findVariableTokens(
          line,
          syntaxes,
          (name) => this.registry.getVariable(name) !== null,
        )) {
          const protection = this.scanMarkdownProtection(
            line,
            tokenMatch.start,
            htmlComment,
            mathBlock,
          );
          if (protection.isProtected) continue;
          occurrences.push({
            name: tokenMatch.name,
            start: offset + tokenMatch.start,
            end: offset + tokenMatch.end,
            line: lineNumber,
            ch: tokenMatch.start + 1,
            syntax: tokenMatch.syntax,
            textCase: tokenMatch.textCase,
          });
        }
        const endState = this.scanMarkdownProtection(
          line,
          line.length,
          htmlComment,
          mathBlock,
        );
        htmlComment = endState.htmlComment;
        mathBlock = endState.mathBlock;
      }
      offset += raw.length;
      lineNumber++;
    }
    return occurrences;
  }

  private scanMarkdownProtection(
    line: string,
    limit: number,
    startsInHtmlComment: boolean,
    startsInMathBlock: boolean,
  ): MarkdownProtectionState {
    let htmlComment = startsInHtmlComment;
    let mathBlock = startsInMathBlock;
    let inlineMath = false;
    let codeTicks = 0;
    let position = 0;

    while (position < limit) {
      if (htmlComment) {
        if (line.startsWith('-->', position)) {
          htmlComment = false;
          position += 3;
        } else {
          position++;
        }
        continue;
      }

      if (codeTicks) {
        if (line[position] !== '`') {
          position++;
          continue;
        }
        const length = this.countRun(line, position, '`', limit);
        if (length === codeTicks) codeTicks = 0;
        position += length;
        continue;
      }

      if (mathBlock) {
        if (line.startsWith('$$', position) && !this.isEscaped(line, position)) {
          mathBlock = false;
          position += 2;
        } else {
          position++;
        }
        continue;
      }

      if (inlineMath) {
        if (line[position] === '$' && !this.isEscaped(line, position)) inlineMath = false;
        position++;
        continue;
      }

      if (line.startsWith('<!--', position)) {
        htmlComment = true;
        position += 4;
        continue;
      }
      if (line[position] === '`') {
        const length = this.countRun(line, position, '`', limit);
        codeTicks = length;
        position += length;
        continue;
      }
      if (line.startsWith('$$', position) && !this.isEscaped(line, position)) {
        mathBlock = true;
        position += 2;
        continue;
      }
      if (line[position] === '$'
        && !this.isEscaped(line, position)
        && this.hasInlineMathCloser(line, position + 1)) {
        inlineMath = true;
      }
      position++;
    }

    return {
      htmlComment,
      mathBlock,
      isProtected: htmlComment || mathBlock || inlineMath || codeTicks > 0,
    };
  }

  private countRun(line: string, start: number, character: string, limit: number): number {
    let end = start;
    while (end < limit && line[end] === character) end++;
    return end - start;
  }

  private isEscaped(line: string, index: number): boolean {
    let slashes = 0;
    for (let position = index - 1; position >= 0 && line[position] === '\\'; position--) slashes++;
    return slashes % 2 === 1;
  }

  private hasInlineMathCloser(line: string, start: number): boolean {
    let codeTicks = 0;
    let htmlComment = false;
    for (let position = start; position < line.length;) {
      if (htmlComment) {
        if (line.startsWith('-->', position)) {
          htmlComment = false;
          position += 3;
        } else {
          position++;
        }
        continue;
      }
      if (codeTicks) {
        if (line[position] !== '`') {
          position++;
          continue;
        }
        const length = this.countRun(line, position, '`', line.length);
        if (length === codeTicks) codeTicks = 0;
        position += length;
        continue;
      }
      if (line.startsWith('<!--', position)) {
        htmlComment = true;
        position += 4;
        continue;
      }
      if (line[position] === '`') {
        const length = this.countRun(line, position, '`', line.length);
        codeTicks = length;
        position += length;
        continue;
      }
      if (line.startsWith('$$', position)) {
        position += 2;
        continue;
      }
      if (line[position] === '$' && !this.isEscaped(line, position)) return true;
      position++;
    }
    return false;
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
