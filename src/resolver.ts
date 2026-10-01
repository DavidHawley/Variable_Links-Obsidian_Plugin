import { App, TFile, parseYaml } from 'obsidian';
import {
  evaluateComputedExpression,
  formatComputedNumber,
  parseComputedExpression,
  type ComputedDependency,
} from './computed';
import Registry, { getVariableShape, getVariableType } from './registry';
import type { VariableSelector, VariableSelectorStep } from './tokenSyntax';
import { parseVariableSelector } from './tokenSyntax';
import { splitGraphemes } from './selectorUtils';
import { adjustTemporalValue, createTemporalValue, formatTemporalValue, type TemporalValue } from './temporal';

export interface ResolveResult {
  ok: boolean;
  value?: unknown;
  type?: string;
  sourceFile?: TFile | null;
  property?: string;
  error?: string;
  temporal?: TemporalValue;
}

interface ResolutionContext {
  stack: string[];
}

const MAX_COMPUTED_DEPTH = 32;

export class Resolver {
  app: App;
  registry: Registry;

  constructor(app: App, registry: Registry) {
    this.app = app;
    this.registry = registry;
  }

  async resolve(variableName: string, selector?: VariableSelector, sourcePath?: string): Promise<ResolveResult> {
    if (variableName.startsWith('=') && !this.registry.getVariable(variableName)) return this.resolveInline(variableName.slice(1), sourcePath);
    return this.resolveInternal(variableName, selector, { stack: [] });
  }

  async resolveInline(expression: string, sourcePath?: string): Promise<ResolveResult> {
    try {
      const parsed = parseComputedExpression(expression);
      const file = sourcePath ? this.app.vault.getFileByPath(sourcePath) : null;
      const frontmatter = file ? this.extractFrontmatter(await this.app.vault.read(file)) ?? {} : {};
      const value = await evaluateComputedExpression(parsed.ast, async (reference) => {
        const direct = this.registry.getVariable(reference.name);
        const shortcut = direct ? null : this.registry.getShortcutByCode(reference.name);
        const target = direct
          ? reference.name
          : shortcut?.enabled ? this.registry.getVariableNameByGuid(shortcut.targetGuid) : null;
        if (shortcut && !target) throw new Error(`Shortcut '${reference.name}' has a missing target`);
        let result: ResolveResult;
        if (target) result = await this.resolve(target, reference.selector ?? shortcut?.selector);
        else {
          if (!Object.prototype.hasOwnProperty.call(frontmatter, reference.name)) throw new Error(`Input '${reference.name}' was not found in Variable Links or this note's properties`);
          result = this.applySelector(reference.name, { type: 'property', file: sourcePath ?? '', property: reference.name }, {
            ok: true, value: frontmatter[reference.name], sourceFile: file, property: reference.name,
          }, reference.selector);
        }
        if (!result.ok) throw new Error(result.error ?? `Could not resolve '${reference.name}'`);
        return result.value;
      });
      return { ok: true, value, type: 'number', sourceFile: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async previewComputed(
    expression: string,
    savedDependencies: readonly ComputedDependency[] = [],
    precision?: number,
  ): Promise<ResolveResult> {
    try {
      const parsed = parseComputedExpression(expression);
      const dependencies = new Map(savedDependencies.map((dependency) => [dependency.name, dependency]));
      const value = await evaluateComputedExpression(parsed.ast, async (reference) => {
        const saved = dependencies.get(reference.name);
        const direct = saved ? null : this.registry.getVariable(reference.name);
        const shortcut = saved || direct ? null : this.registry.getShortcutByCode(reference.name);
        const savedGuid = saved?.guid ?? shortcut?.targetGuid;
        const target = savedGuid
          ? this.registry.getVariableByGuid(savedGuid)
          : null;
        const targetName = savedGuid ? target?.name : direct ? reference.name : null;
        if (!targetName) throw new Error(`Variable '${reference.name}' was not found`);
        const savedSelector = saved ? (saved.selector ? parseVariableSelector(`Dependency${saved.selector}`).selector : undefined) : shortcut?.selector;
        const result = await this.resolve(targetName, reference.selector ?? savedSelector);
        if (!result.ok) throw new Error(result.error ?? `Could not resolve '${targetName}'`);
        return result.value;
      });
      return {
        ok: true,
        value: formatComputedNumber(value, precision),
        type: precision === undefined ? 'number' : 'string',
        sourceFile: null,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        sourceFile: null,
      };
    }
  }

  private async resolveInternal(
    variableName: string,
    selector: VariableSelector | undefined,
    context: ResolutionContext,
  ): Promise<ResolveResult> {
    const def = this.registry.getVariable(variableName);
    if (!def) {
      return { ok: false, error: `Variable '${variableName}' not found in registry` };
    }

    if (getVariableType(def) === 'computed') {
      const guid = def.guid;
      if (!guid) return { ok: false, error: `Computed variable '${variableName}' has no stable ID` };
      const cycleStart = context.stack.indexOf(guid);
      if (cycleStart !== -1) {
        const cycle = [...context.stack.slice(cycleStart), guid]
          .map((entry) => this.registry.getVariableNameByGuid(entry) ?? entry)
          .join(' → ');
        return { ok: false, error: `Circular computed dependency: ${cycle}` };
      }
      if (context.stack.length >= MAX_COMPUTED_DEPTH) {
        return { ok: false, error: `Computed dependency depth exceeds ${MAX_COMPUTED_DEPTH} variables` };
      }
      try {
        const parsed = parseComputedExpression(def.expression ?? '');
        const dependencies = new Map((def.dependencies ?? []).map((dependency) => [dependency.name, dependency]));
        const value = await evaluateComputedExpression(parsed.ast, async (reference) => {
          const dependency = dependencies.get(reference.name);
          const dependencyGuid = dependency?.guid;
          if (!dependencyGuid) {
            throw new Error(`Computed dependency '${reference.name}' is not bound to a Variable Link`);
          }
          const target = this.registry.getVariableByGuid(dependencyGuid);
          if (!target) {
            throw new Error(`Computed dependency '${reference.name}' no longer exists`);
          }
          const result = await this.resolveInternal(
            target.name,
            reference.selector ?? (dependency?.selector ? parseVariableSelector(`Dependency${dependency.selector}`).selector : undefined),
            { stack: [...context.stack, guid] },
          );
          if (!result.ok) throw new Error(result.error ?? `Could not resolve '${target.name}'`);
          return result.value;
        });
        const result: ResolveResult = {
          ok: true,
          value: formatComputedNumber(value, def.precision),
          type: def.precision === undefined ? 'number' : 'string',
          sourceFile: null,
        };
        return this.applySelector(variableName, def, result, selector);
      } catch (error) {
        return {
          ok: false,
          error: `Computed variable '${variableName}': ${error instanceof Error ? error.message : String(error)}`,
          sourceFile: null,
        };
      }
    }

    if (getVariableType(def) === 'fixed') {
      const list = getVariableShape(def) === 'list';
      const result: ResolveResult = {
        ok: true,
        value: list ? (def.fixedItems ?? []).map((item) => item.value) : def.temporal ? formatTemporalValue(def.temporal) : def.value ?? '',
        type: list ? 'array' : 'string',
        sourceFile: null,
        temporal: list ? undefined : def.temporal,
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
    if (def.temporal && !Array.isArray(value)) {
      try {
        if (typeof value !== 'string') throw new Error('Date/time properties must contain an ISO text value');
        res.temporal = createTemporalValue(value, def.temporal.kind, def.temporal.format);
        res.value = formatTemporalValue(res.temporal);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), sourceFile: file, property: prop };
      }
    }

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
    if (selector.type === 'add' || selector.type === 'sub') {
      if (!result.temporal) return this.selectorError(result, 'Date arithmetic requires a canonical date/time value; set Date/time in the variable editor first');
      try {
        const temporal = adjustTemporalValue(result.temporal, selector.parts, selector.type === 'sub');
        return { ...result, temporal, value: formatTemporalValue(temporal), type: 'string' };
      } catch (error) {
        return this.selectorError(result, error instanceof Error ? error.message : String(error));
      }
    }
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
