import {
  parseVariableTextCaseMarker,
  wrapVariableNameWithTextCase,
  type VariableTextCase,
} from './textCase';

export interface TokenSyntax {
  prefix: string;
  suffix: string;
}

export interface VariableTokenMatch {
  name: string;
  start: number;
  end: number;
  syntax: TokenSyntax;
  textCase?: VariableTextCase;
  selector?: VariableSelector;
}

export type VariableSelectorStep =
  | { type: 'index'; index: number }
  | { type: 'item'; key: string }
  | { type: 'word'; indexes: number[] }
  | { type: 'char'; indexes: number[] }
  | { type: 'upper'; indexes: number[] }
  | { type: 'lower'; indexes: number[] };

export interface VariableSelector {
  steps: VariableSelectorStep[];
}

export interface VariableTokenTrigger {
  start: number;
  query: string;
  syntax: TokenSyntax;
}

export const DEFAULT_TOKEN_SYNTAX: Readonly<TokenSyntax> = Object.freeze({
  prefix: '{{',
  suffix: '}}',
});

export const MAX_TOKEN_DELIMITER_LENGTH = 12;

export function normalizeTokenDelimiter(value: unknown, fallback: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_TOKEN_DELIMITER_LENGTH
    || value.trim().length === 0
    || /[\r\n]/.test(value)) return fallback;
  return value;
}

export function normalizeLegacyTokenSyntaxes(
  value: unknown,
  active: TokenSyntax,
): TokenSyntax[] {
  if (!Array.isArray(value)) return [];
  const syntaxes: TokenSyntax[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const prefix = normalizeTokenDelimiter(candidate.prefix, '');
    const suffix = normalizeTokenDelimiter(candidate.suffix, '');
    const syntax = { prefix, suffix };
    if (!prefix || !suffix || prefix === suffix || tokenSyntaxEquals(active, syntax)) continue;
    if (syntaxes.some((existing) => tokenSyntaxEquals(existing, syntax))) continue;
    syntaxes.push(syntax);
  }
  return syntaxes.slice(0, 5);
}

export function getTokenSyntax(settings?: unknown): TokenSyntax {
  if (!isRecord(settings)) return { ...DEFAULT_TOKEN_SYNTAX };
  const prefix = typeof settings.tokenPrefix === 'string' && settings.tokenPrefix.length > 0
    ? settings.tokenPrefix
    : DEFAULT_TOKEN_SYNTAX.prefix;
  const suffix = typeof settings.tokenSuffix === 'string' && settings.tokenSuffix.length > 0
    ? settings.tokenSuffix
    : DEFAULT_TOKEN_SYNTAX.suffix;
  return { prefix, suffix };
}

export function getRecognizedTokenSyntaxes(settings?: unknown): TokenSyntax[] {
  const active = getTokenSyntax(settings);
  const syntaxes = [active];
  if (!isRecord(settings) || !Array.isArray(settings.legacyTokenSyntaxes)) return syntaxes;
  for (const value of settings.legacyTokenSyntaxes) {
    if (!isRecord(value)) continue;
    const prefix = typeof value.prefix === 'string' ? value.prefix : '';
    const suffix = typeof value.suffix === 'string' ? value.suffix : '';
    if (!prefix || !suffix || prefix === suffix || /[\r\n]/.test(prefix + suffix)) continue;
    if (syntaxes.some((syntax) => tokenSyntaxEquals(syntax, { prefix, suffix }))) continue;
    syntaxes.push({ prefix, suffix });
  }
  return syntaxes;
}

export function tokenSyntaxEquals(left: TokenSyntax, right: TokenSyntax): boolean {
  return left.prefix === right.prefix && left.suffix === right.suffix;
}

export function formatVariableToken(
  name: string,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
  textCase?: VariableTextCase,
  selector?: VariableSelector,
): string {
  const selectedName = `${name}${formatVariableSelector(selector)}`;
  return `${syntax.prefix}${wrapVariableNameWithTextCase(selectedName, textCase)}${syntax.suffix}`;
}

export function canRepresentVariableTextCase(
  name: string,
  textCase: VariableTextCase,
  exactNameExists: (name: string) => boolean,
  selector?: VariableSelector,
): boolean {
  const selectedName = `${name}${formatVariableSelector(selector)}`;
  const parsed = interpretVariableTokenName(
    wrapVariableNameWithTextCase(selectedName, textCase),
    exactNameExists,
  );
  return parsed.name === name
    && parsed.textCase === textCase
    && variableSelectorsEqual(parsed.selector, selector);
}

export function findVariableTokens(
  text: string,
  syntax: TokenSyntax | readonly TokenSyntax[] = DEFAULT_TOKEN_SYNTAX,
  exactNameExists?: (name: string) => boolean,
): VariableTokenMatch[] {
  if (!text) return [];
  const syntaxes: readonly TokenSyntax[] = isSingleTokenSyntax(syntax) ? [syntax] : syntax;
  const candidates: Array<VariableTokenMatch & { priority: number }> = [];
  syntaxes.forEach((candidateSyntax, priority) => {
    if (!candidateSyntax.prefix || !candidateSyntax.suffix) return;
    const pattern = createVariableTokenPattern(candidateSyntax);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawName = match[1]?.trim();
      if (!rawName) continue;
      const parsed = interpretVariableTokenName(rawName, exactNameExists);
      candidates.push({
        name: parsed.name,
        start: match.index,
        end: pattern.lastIndex,
        syntax: candidateSyntax,
        textCase: parsed.textCase,
        selector: parsed.selector,
        priority,
      });
    }
  });
  candidates.sort((left, right) =>
    left.start - right.start || left.priority - right.priority || right.end - left.end
  );

  const matches: VariableTokenMatch[] = [];
  for (const candidate of candidates) {
    const overlaps = matches.some((match) =>
      candidate.start < match.end && candidate.end > match.start
    );
    if (overlaps) continue;
    matches.push({
      name: candidate.name,
      start: candidate.start,
      end: candidate.end,
      syntax: candidate.syntax,
      textCase: candidate.textCase,
      selector: candidate.selector,
    });
  }
  return matches;
}

export function findVariableTokenAt(
  text: string,
  index: number,
  syntax: TokenSyntax | readonly TokenSyntax[] = DEFAULT_TOKEN_SYNTAX,
  exactNameExists?: (name: string) => boolean,
): VariableTokenMatch | null {
  if (index < 0 || index > text.length) return null;
  return findVariableTokens(text, syntax, exactNameExists).find((match) =>
    index >= match.start && index <= match.end - match.syntax.suffix.length
  ) ?? null;
}

export function findVariableTokenTrigger(
  line: string,
  cursor: number,
  syntax: TokenSyntax | readonly TokenSyntax[] = DEFAULT_TOKEN_SYNTAX,
): VariableTokenTrigger | null {
  if (cursor < 0 || cursor > line.length) return null;
  const syntaxes: readonly TokenSyntax[] = isSingleTokenSyntax(syntax) ? [syntax] : syntax;
  let trigger: VariableTokenTrigger | null = null;
  for (const candidate of syntaxes) {
    if (!candidate.prefix || !candidate.suffix) continue;
    const fromIndex = line.lastIndexOf(candidate.prefix, cursor - 1);
    if (fromIndex === -1 || (trigger && fromIndex <= trigger.start)) continue;
    const query = line.slice(fromIndex + candidate.prefix.length, cursor);
    if (query.includes(candidate.suffix)) continue;
    trigger = { start: fromIndex, query, syntax: candidate };
  }
  return trigger;
}

export function hasVariableTokenSuffixAt(
  text: string,
  index: number,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
): boolean {
  return syntax.suffix.length > 0 && text.startsWith(syntax.suffix, index);
}

function createVariableTokenPattern(syntax: TokenSyntax): RegExp {
  if (syntax.prefix === DEFAULT_TOKEN_SYNTAX.prefix
    && syntax.suffix === DEFAULT_TOKEN_SYNTAX.suffix) {
    return /\{\{\s*([^}\r\n]+?)\s*}}/g;
  }
  const prefix = escapeRegExp(syntax.prefix);
  const suffix = escapeRegExp(syntax.suffix);
  return new RegExp(`${prefix}\\s*((?:(?!${suffix})[^\\r\\n])+?)\\s*${suffix}`, 'g');
}

function interpretVariableTokenName(
  rawName: string,
  exactNameExists?: (name: string) => boolean,
): { name: string; textCase?: VariableTextCase; selector?: VariableSelector } {
  if (exactNameExists?.(rawName)) return { name: rawName };
  const parsed = parseVariableTextCaseMarker(rawName, exactNameExists);
  const selected = parseVariableSelector(parsed?.name ?? rawName, exactNameExists);
  return {
    name: selected.name,
    textCase: parsed?.textCase,
    selector: selected.selector,
  };
}

export function formatVariableSelector(selector?: VariableSelector): string {
  if (!selector) return '';
  return selector.steps.map(formatVariableSelectorStep).join('');
}

export function parseVariableSelector(
  value: string,
  exactNameExists?: (name: string) => boolean,
): { name: string; selector?: VariableSelector } {
  if (exactNameExists?.(value)) return { name: value };
  const candidates: Array<{ name: string; steps: VariableSelectorStep[] }> = [];
  let separator = value.indexOf('::');
  while (separator > 0) {
    const name = value.slice(0, separator);
    const steps = parseVariableSelectorSteps(value.slice(separator));
    if (steps) candidates.push({ name, steps });
    separator = value.indexOf('::', separator + 2);
  }
  const selected = [...candidates].reverse().find((candidate) => exactNameExists?.(candidate.name))
    ?? candidates[0];
  if (selected) return { name: selected.name, selector: { steps: selected.steps } };
  return { name: value };
}

export function parseVariableSelectorStep(value: string): VariableSelectorStep | null {
  const source = value.trim();
  const item = source.match(/^item\(([\p{L}\p{N}_-]+)\)$/u);
  if (item?.[1]) return { type: 'item', key: item[1] };
  const operation = source.match(/^(index|word|char|upper|lower)\(([^()]*)\)$/u);
  if (!operation?.[1] || operation[2] === undefined) return null;
  const type = operation[1] as 'index' | 'word' | 'char' | 'upper' | 'lower';
  const indexes = parseSelectorIndexes(operation[2]);
  if (indexes === null) return null;
  if (type === 'index') {
    return indexes.length === 1 ? { type, index: indexes[0] } : null;
  }
  if ((type === 'word' || type === 'char') && !indexes.length) return null;
  return { type, indexes };
}

export function appendVariableSelector(
  selector: VariableSelector | undefined,
  step: VariableSelectorStep,
): VariableSelector {
  return { steps: [...(selector?.steps ?? []), step] };
}

function parseVariableSelectorSteps(value: string): VariableSelectorStep[] | null {
  if (!value.startsWith('::')) return null;
  const steps: VariableSelectorStep[] = [];
  let position = 0;
  while (position < value.length) {
    if (!value.startsWith('::', position)) return null;
    const next = value.indexOf('::', position + 2);
    const source = value.slice(position + 2, next === -1 ? value.length : next);
    const step = parseVariableSelectorStep(source);
    if (!step) return null;
    steps.push(step);
    if (next === -1) break;
    position = next;
  }
  return steps.length ? steps : null;
}

function formatVariableSelectorStep(step: VariableSelectorStep): string {
  switch (step.type) {
    case 'index': return `::index(${step.index})`;
    case 'item': return `::item(${step.key})`;
    case 'word': return `::word(${step.indexes.join(',')})`;
    case 'char': return `::char(${step.indexes.join(',')})`;
    case 'upper': return `::upper(${step.indexes.join(',')})`;
    case 'lower': return `::lower(${step.indexes.join(',')})`;
  }
}

function parseSelectorIndexes(value: string): number[] | null {
  if (!value.trim()) return [];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^-?\d+$/u.test(part))) return null;
  return parts.map(Number);
}

function variableSelectorsEqual(
  left: VariableSelector | undefined,
  right: VariableSelector | undefined,
): boolean {
  if (!left || !right) return left === right;
  return formatVariableSelector(left) === formatVariableSelector(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSingleTokenSyntax(
  value: TokenSyntax | readonly TokenSyntax[],
): value is TokenSyntax {
  return !Array.isArray(value);
}
