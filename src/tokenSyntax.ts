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
): string {
  return `${syntax.prefix}${wrapVariableNameWithTextCase(name, textCase)}${syntax.suffix}`;
}

export function canRepresentVariableTextCase(
  name: string,
  textCase: VariableTextCase,
  exactNameExists: (name: string) => boolean,
): boolean {
  const parsed = interpretVariableTokenName(
    wrapVariableNameWithTextCase(name, textCase),
    exactNameExists,
  );
  return parsed.name === name && parsed.textCase === textCase;
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
    return /\{\{\s*([^}\s]+)\s*}}/g;
  }
  const prefix = escapeRegExp(syntax.prefix);
  const suffix = escapeRegExp(syntax.suffix);
  return new RegExp(`${prefix}\\s*((?:(?!${suffix})\\S)+?)\\s*${suffix}`, 'g');
}

function interpretVariableTokenName(
  rawName: string,
  exactNameExists?: (name: string) => boolean,
): { name: string; textCase?: VariableTextCase } {
  if (exactNameExists?.(rawName)) return { name: rawName };
  const parsed = parseVariableTextCaseMarker(rawName, exactNameExists);
  return parsed
    ? { name: parsed.name, textCase: parsed.textCase }
    : { name: rawName };
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
