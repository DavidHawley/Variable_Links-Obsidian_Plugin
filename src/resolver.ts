import { App, TFile, parseYaml } from 'obsidian';
import Registry, { getVariableShape, getVariableType } from './registry';
import type { VariableSelector, VariableSelectorStep } from './tokenSyntax';
import { splitGraphemes } from './selectorUtils';

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

  async resolve(variableName: string, selector?: VariableSelector): Promise<ResolveResult> {
    const def = this.registry.getVariable(variableName);
    if (!def) {
      return { ok: false, error: `Variable '${variableName}' not found in registry` };
    }

    if (getVariableType(def) === 'fixed') {
      const list = getVariableShape(def) === 'list';
      const result: ResolveResult = {
        ok: true,
        value: list ? (def.fixedItems ?? []).map((item) => item.value) : def.value ?? '',
        type: list ? 'array' : 'string',
        sourceFile: null,
      };
      return this.applySelector(variableName, def, result, selector);
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

    const declaredShape = getVariableShape(def);
    if (declaredShape === 'list' && !Array.isArray(value)) {
      return {
        ok: false,
        error: `Property '${prop}' in ${path} is not a list`,
        sourceFile: file,
        property: prop,
      };
    }
    if (declaredShape === 'single' && Array.isArray(value)) {
      return {
        ok: false,
        error: `Property '${prop}' in ${path} is a list`,
        sourceFile: file,
        property: prop,
      };
    }

    const res: ResolveResult = { ok: true, value, sourceFile: file, property: prop };

    // derive type
    if (Array.isArray(value)) res.type = 'array';
    else if (typeof value === 'boolean') res.type = 'boolean';
    else if (typeof value === 'number') res.type = 'number';
    else if (typeof value === 'string') res.type = 'string';
    else res.type = typeof value;

    return this.applySelector(variableName, def, res, selector);
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

  private applySelector(
    variableName: string,
    definition: NonNullable<ReturnType<Registry['getVariable']>>,
    result: ResolveResult,
    selector: VariableSelector | undefined,
  ): ResolveResult {
    if (!selector) return result;
    let selected = result;
    for (const step of selector.steps) {
      selected = this.applySelectorStep(variableName, definition, selected, step);
      if (!selected.ok) return selected;
    }
    return selected;
  }

  private applySelectorStep(
    variableName: string,
    definition: NonNullable<ReturnType<Registry['getVariable']>>,
    result: ResolveResult,
    selector: VariableSelectorStep,
  ): ResolveResult {
    if (selector.type === 'word' || selector.type === 'char') {
      if (Array.isArray(result.value)) {
        return this.selectorError(
          result,
          `${selector.type}() requires '${variableName}' to resolve to a single value first`,
        );
      }
      const parts = selector.type === 'word'
        ? this.listItemText(result.value).trim().split(/\s+/u).filter(Boolean)
        : splitGraphemes(this.listItemText(result.value));
      const values = this.selectIndexedParts(parts, selector.indexes);
      if (!values.ok) {
        return this.selectorIndexError(
          result,
          selector.type === 'word' ? 'Word' : 'Character',
          values.index,
          variableName,
        );
      }
      return {
        ...result,
        value: values.values.join(selector.type === 'word' ? ' ' : ''),
        type: 'string',
      };
    }
    if (selector.type === 'upper' || selector.type === 'lower') {
      if (Array.isArray(result.value)) {
        return this.selectorError(
          result,
          `${selector.type}() requires '${variableName}' to resolve to a single value first`,
        );
      }
      const value = this.listItemText(result.value);
      const transform = selector.type === 'upper'
        ? (part: string): string => part.toLocaleUpperCase()
        : (part: string): string => part.toLocaleLowerCase();
      if (!selector.indexes.length) {
        return { ...result, value: transform(value), type: 'string' };
      }
      const parts = splitGraphemes(value);
      const positions = this.resolveIndexes(parts.length, selector.indexes);
      if (!positions.ok) {
        return this.selectorIndexError(
          result,
          'Character',
          positions.index,
          variableName,
        );
      }
      const targeted = new Set(positions.indexes);
      return {
        ...result,
        value: parts.map((part, index) => targeted.has(index) ? transform(part) : part).join(''),
        type: 'string',
      };
    }
    if (!Array.isArray(result.value)) {
      return this.selectorError(result, `Variable '${variableName}' is not a list at ${selector.type}()`);
    }
    let selectedIndex = -1;
    if (selector.type === 'index') {
      if (selector.index === 0) {
        return { ...result, ok: false, value: undefined, error: 'List index 0 is invalid; indexes start at 1' };
      }
      selectedIndex = selector.index > 0
        ? selector.index - 1
        : result.value.length + selector.index;
      if (selectedIndex < 0 || selectedIndex >= result.value.length) {
        return {
          ...result,
          ok: false,
          value: undefined,
          error: `List index ${selector.index} is outside '${variableName}'`,
        };
      }
    } else if (getVariableType(definition) === 'fixed') {
      selectedIndex = (definition.fixedItems ?? []).findIndex((item) =>
        item.key?.toLocaleLowerCase() === selector.key.toLocaleLowerCase()
      );
    } else {
      const metadata = (definition.propertyItems ?? []).find((item) =>
        item.key?.toLocaleLowerCase() === selector.key.toLocaleLowerCase()
      );
      if (metadata) {
        const matches = result.value.flatMap((value, index) =>
          this.listItemText(value) === metadata.value ? [index] : []
        );
        if (matches.length > 1) {
          return {
            ...result,
            ok: false,
            value: undefined,
            error: `List item '${selector.key}' is ambiguous because its property value occurs more than once`,
          };
        }
        selectedIndex = matches[0] ?? -1;
      }
    }
    if (selectedIndex < 0 || selectedIndex >= result.value.length) {
      const selectorLabel = selector.type === 'item'
        ? `List item '${selector.key}'`
        : `List index ${selector.index}`;
      return {
        ...result,
        ok: false,
        value: undefined,
        error: `${selectorLabel} was not found in '${variableName}'`,
      };
    }
    const value: unknown = result.value[selectedIndex];
    return { ...result, value, type: this.valueType(value) };
  }

  private valueType(value: unknown): string {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  }

  private selectIndexedParts(
    values: readonly string[],
    indexes: readonly number[],
  ): { ok: true; values: string[] } | { ok: false; index: number } {
    const positions = this.resolveIndexes(values.length, indexes);
    if (!positions.ok) return positions;
    return { ok: true, values: positions.indexes.map((index) => values[index]) };
  }

  private resolveIndexes(
    length: number,
    indexes: readonly number[],
  ): { ok: true; indexes: number[] } | { ok: false; index: number } {
    const resolved: number[] = [];
    for (const index of indexes) {
      const selectedIndex = index > 0 ? index - 1 : length + index;
      if (index === 0 || selectedIndex < 0 || selectedIndex >= length) {
        return { ok: false, index };
      }
      resolved.push(selectedIndex);
    }
    return { ok: true, indexes: resolved };
  }

  private selectorIndexError(
    result: ResolveResult,
    label: string,
    index: number,
    variableName: string,
  ): ResolveResult {
    return this.selectorError(
      result,
      index === 0
        ? `${label} index 0 is invalid; indexes start at 1`
        : `${label} index ${index} is outside '${variableName}'`,
    );
  }

  private selectorError(result: ResolveResult, error: string): ResolveResult {
    return { ...result, ok: false, value: undefined, error };
  }

  private listItemText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || typeof value === 'bigint') return String(value);
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export default Resolver;
