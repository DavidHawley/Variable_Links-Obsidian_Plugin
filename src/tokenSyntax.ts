export interface TokenSyntax {
  prefix: string;
  suffix: string;
}

export interface VariableTokenMatch {
  name: string;
  start: number;
  end: number;
}

export interface VariableTokenTrigger {
  start: number;
  query: string;
}

export const DEFAULT_TOKEN_SYNTAX: Readonly<TokenSyntax> = Object.freeze({
  prefix: '{{',
  suffix: '}}',
});

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

export function formatVariableToken(
  name: string,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
): string {
  return `${syntax.prefix}${name}${syntax.suffix}`;
}

export function findVariableTokens(
  text: string,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
): VariableTokenMatch[] {
  if (!text || !syntax.prefix || !syntax.suffix) return [];
  const pattern = createVariableTokenPattern(syntax);
  const matches: VariableTokenMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    matches.push({ name, start: match.index, end: pattern.lastIndex });
  }
  return matches;
}

export function findVariableTokenAt(
  text: string,
  index: number,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
): VariableTokenMatch | null {
  if (index < 0 || index > text.length) return null;
  const contentEndOffset = syntax.suffix.length;
  return findVariableTokens(text, syntax).find((match) =>
    index >= match.start && index <= match.end - contentEndOffset
  ) ?? null;
}

export function findVariableTokenTrigger(
  line: string,
  cursor: number,
  syntax: TokenSyntax = DEFAULT_TOKEN_SYNTAX,
): VariableTokenTrigger | null {
  if (!syntax.prefix || !syntax.suffix || cursor < 0 || cursor > line.length) return null;
  const fromIndex = line.lastIndexOf(syntax.prefix, cursor - 1);
  if (fromIndex === -1) return null;
  const query = line.slice(fromIndex + syntax.prefix.length, cursor);
  if (query.includes(syntax.suffix) || /\s/.test(query)) return null;
  return { start: fromIndex, query };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
