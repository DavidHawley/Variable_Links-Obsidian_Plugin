export type VariableTextCase =
  | 'lower-first'
  | 'lower'
  | 'upper-first'
  | 'capitalize-words'
  | 'upper';

export interface VariableTextCaseOption {
  value: VariableTextCase | '';
  label: string;
}

export interface VariableTextCaseMarkerMatch {
  name: string;
  textCase: VariableTextCase;
  marker: string;
}

export const VARIABLE_TEXT_CASE_OPTIONS: readonly VariableTextCaseOption[] = [
  { value: '', label: 'Keep original' },
  { value: 'lower-first', label: 'Lowercase first letter' },
  { value: 'upper-first', label: 'Uppercase first letter' },
  { value: 'capitalize-words', label: 'Capitalize each word' },
  { value: 'lower', label: 'lowercase all' },
  { value: 'upper', label: 'UPPERCASE ALL' },
];

const TEXT_CASE_MARKERS: ReadonlyArray<{
  marker: string;
  textCase: VariableTextCase;
}> = [
  { marker: "'''", textCase: 'upper' },
  { marker: "''", textCase: 'capitalize-words' },
  { marker: "'", textCase: 'upper-first' },
  { marker: '..', textCase: 'lower' },
  { marker: '.', textCase: 'lower-first' },
];

export function normalizeVariableTextCase(value: unknown): VariableTextCase | undefined {
  return value === 'lower-first'
    || value === 'lower'
    || value === 'upper-first'
    || value === 'capitalize-words'
    || value === 'upper'
    ? value
    : undefined;
}

export function getVariableTextCaseLabel(value: VariableTextCase): string {
  return VARIABLE_TEXT_CASE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function getVariableTextCaseMarker(value: VariableTextCase): string {
  return TEXT_CASE_MARKERS.find((candidate) => candidate.textCase === value)?.marker ?? '';
}

export function wrapVariableNameWithTextCase(
  name: string,
  textCase: VariableTextCase | undefined,
): string {
  if (!textCase) return name;
  const marker = getVariableTextCaseMarker(textCase);
  return marker ? `${marker}${name}${marker}` : name;
}

export function parseVariableTextCaseMarker(
  value: string,
  exactNameExists?: (name: string) => boolean,
): VariableTextCaseMarkerMatch | null {
  let fallback: VariableTextCaseMarkerMatch | null = null;
  for (const candidate of TEXT_CASE_MARKERS) {
    const { marker, textCase } = candidate;
    if (!value.startsWith(marker) || !value.endsWith(marker)) continue;
    const name = value.slice(marker.length, -marker.length);
    if (!name) continue;
    const match = { name, textCase, marker };
    if (exactNameExists?.(name)) return match;
    const leadingLength = countBoundaryRun(value, marker[0], false);
    const trailingLength = countBoundaryRun(value, marker[0], true);
    if (leadingLength === marker.length && trailingLength === marker.length) {
      fallback ??= match;
    }
  }
  return fallback;
}

export function parseVariableTextCaseQuery(
  value: string,
): { query: string; textCase?: VariableTextCase; marker?: string } {
  for (const candidate of TEXT_CASE_MARKERS) {
    if (!value.startsWith(candidate.marker)) continue;
    let query = value.slice(candidate.marker.length);
    if (query.length > candidate.marker.length && query.endsWith(candidate.marker)) {
      query = query.slice(0, -candidate.marker.length);
    }
    return {
      query,
      textCase: candidate.textCase,
      marker: candidate.marker,
    };
  }
  return { query: value };
}

export function applyVariableTextCase(
  value: string,
  textCase: VariableTextCase | undefined,
): string {
  if (!textCase || !value) return value;
  if (textCase === 'lower') return value.toLocaleLowerCase();
  if (textCase === 'upper') return value.toLocaleUpperCase();
  if (textCase === 'capitalize-words') {
    return value.replace(
      /(^|[^\p{L}\p{N}])(\p{L})/gu,
      (_match, boundary: string, letter: string) => boundary + letter.toLocaleUpperCase(),
    );
  }
  return replaceFirstLetter(
    value,
    textCase === 'lower-first'
      ? (letter) => letter.toLocaleLowerCase()
      : (letter) => letter.toLocaleUpperCase(),
  );
}

function replaceFirstLetter(value: string, transform: (letter: string) => string): string {
  const match = /\p{L}/u.exec(value);
  if (!match || match.index === undefined) return value;
  const letter = match[0];
  return value.slice(0, match.index)
    + transform(letter)
    + value.slice(match.index + letter.length);
}

function countBoundaryRun(value: string, character: string, fromEnd: boolean): number {
  let count = 0;
  if (fromEnd) {
    for (let index = value.length - 1; index >= 0 && value[index] === character; index--) count++;
  } else {
    for (let index = 0; index < value.length && value[index] === character; index++) count++;
  }
  return count;
}
