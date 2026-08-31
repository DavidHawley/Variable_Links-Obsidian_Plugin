export interface ParsedSuggestionQuery {
  valueMode: boolean;
  terms: string[];
}

export function parseSuggestionQuery(query: string): ParsedSuggestionQuery {
  const valueMode = query.startsWith('*');
  const searchText = valueMode ? query.slice(1) : query;
  const terms = searchText
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return { valueMode, terms };
}

export function scoreSuggestionFields(
  terms: readonly string[],
  fields: readonly (string | undefined)[],
): number | null {
  if (!terms.length) return 0;
  const normalizedFields = fields
    .filter((field): field is string => typeof field === 'string' && field.length > 0)
    .map((field) => normalizeSearchText(field));
  if (!normalizedFields.length) return null;

  let score = 0;
  for (const term of terms) {
    let best = Number.POSITIVE_INFINITY;
    normalizedFields.forEach((field, fieldIndex) => {
      const fieldScore = scoreTerm(term, field);
      if (fieldScore !== null) best = Math.min(best, fieldScore + fieldIndex);
    });
    if (!Number.isFinite(best)) return null;
    score += best;
  }
  return score;
}

export function formatSuggestionValue(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  if (Array.isArray(value)) {
    return value.map((item) => formatSuggestionValue(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'string') return normalizeDisplayWhitespace(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? normalizeDisplayWhitespace(serialized) : '';
  } catch {
    return '';
  }
}

export function truncateSuggestionValue(value: string, maximum = 120): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(1, maximum - 1)).join('')}…`;
}

function scoreTerm(term: string, field: string): number | null {
  if (field === term) return 0;
  if (field.startsWith(term)) return 100;
  const wordIndex = findWholeWord(field, term);
  if (wordIndex !== -1) return 200 + wordIndex;
  const substringIndex = field.indexOf(term);
  return substringIndex === -1 ? null : 300 + substringIndex;
}

function findWholeWord(value: string, term: string): number {
  let from = 0;
  while (from <= value.length - term.length) {
    const index = value.indexOf(term, from);
    if (index === -1) return -1;
    const before = index === 0 ? '' : value[index - 1];
    const afterIndex = index + term.length;
    const after = afterIndex >= value.length ? '' : value[afterIndex];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return index;
    from = index + 1;
  }
  return -1;
}

function isWordCharacter(character: string): boolean {
  return character.length > 0 && /[\p{L}\p{N}]/u.test(character);
}

function normalizeSearchText(value: string): string {
  return normalizeDisplayWhitespace(value).toLocaleLowerCase();
}

function normalizeDisplayWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
