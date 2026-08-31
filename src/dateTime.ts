export type CapturedTimeShortcut = 'date' | 'time' | 'datetime';

export interface CapturedTimeCreationQuery {
  requestedName?: string;
  typeQuery: string;
  type?: CapturedTimeShortcut;
  format?: string;
  hasFormat: boolean;
}

export type DateTimeFormatResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

const FORMAT_TOKENS = [
  'YYYY', 'MMMM', 'MMM', 'SSS', 'www', 'YY', 'MM', 'DD', 'WW', 'HH', 'hh',
  'mm', 'ss', 'M', 'D', 'w', 'H', 'h', 'm', 's', 'A', 'a',
] as const;

export function parseCapturedTimeCreationQuery(
  value: string,
): CapturedTimeCreationQuery | null {
  const equals = value.indexOf('=');
  const requestedName = equals === -1 ? undefined : value.slice(0, equals).trim();
  const expression = equals === -1 ? value : value.slice(equals + 1);
  const sourceSeparator = expression.indexOf(':');
  const rawType = (sourceSeparator === -1
    ? expression
    : expression.slice(0, sourceSeparator)).trim();
  const typeQuery = rawType.toLocaleLowerCase();
  const type = typeQuery === 'date' || typeQuery === 'time' || typeQuery === 'datetime'
    ? typeQuery
    : undefined;
  const couldMatch = typeQuery.length === 0
    || (['date', 'time', 'datetime'] as const).some((candidate) => candidate.startsWith(typeQuery));
  if (!couldMatch) return null;
  return {
    requestedName,
    typeQuery,
    type,
    format: sourceSeparator === -1 ? undefined : expression.slice(sourceSeparator + 1),
    hasFormat: sourceSeparator !== -1,
  };
}

export function formatCapturedDateTime(date: Date, format: string): DateTimeFormatResult {
  if (!format.length) return { ok: false, error: 'The date and time format cannot be empty.' };
  let output = '';
  for (let index = 0; index < format.length;) {
    const character = format[index];
    if (character === '\\') {
      if (index + 1 >= format.length) {
        return { ok: false, error: 'A trailing backslash must escape a literal character.' };
      }
      output += format[index + 1];
      index += 2;
      continue;
    }
    if (character === '[') {
      const literal = readBracketedLiteral(format, index + 1);
      if (!literal.ok) return literal;
      output += literal.value;
      index = literal.next;
      continue;
    }
    const token = FORMAT_TOKENS.find((candidate) => format.startsWith(candidate, index));
    if (token) {
      output += formatToken(date, token);
      index += token.length;
      continue;
    }
    if (/[A-Za-z]/.test(character)) {
      return {
        ok: false,
        error: `Unsupported date and time format text near “${format.slice(index, index + 8)}”. Put literal words in [brackets].`,
      };
    }
    output += character;
    index++;
  }
  return { ok: true, value: output };
}

export function defaultFormatForCapturedTime(
  type: CapturedTimeShortcut,
  settings: {
    defaultDateFormat: string;
    defaultTimeFormat: string;
    defaultDateTimeFormat: string;
  },
): string {
  if (type === 'date') return settings.defaultDateFormat;
  if (type === 'time') return settings.defaultTimeFormat;
  return settings.defaultDateTimeFormat;
}

export function automaticCapturedTimeNameBase(fileName: string): string {
  const characters = Array.from(fileName.normalize('NFKC'))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, 5)
    .join('');
  return characters || 'Note';
}

export function capturedTimeShortcutLabel(type: CapturedTimeShortcut): string {
  if (type === 'datetime') return 'DateTime';
  return type === 'date' ? 'Date' : 'Time';
}

function formatToken(date: Date, token: typeof FORMAT_TOKENS[number]): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour24 = date.getHours();
  const hour12 = hour24 % 12 || 12;
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  switch (token) {
    case 'YYYY': return String(year).padStart(4, '0');
    case 'YY': return String(year % 100).padStart(2, '0');
    case 'MMMM': return date.toLocaleDateString(undefined, { month: 'long' });
    case 'MMM': return date.toLocaleDateString(undefined, { month: 'short' });
    case 'MM': return padTwo(month);
    case 'M': return String(month);
    case 'DD': return padTwo(day);
    case 'D': return String(day);
    case 'WW': return weekday;
    case 'www': return date.toLocaleDateString(undefined, { weekday: 'short' });
    case 'w': return Array.from(weekday)[0] ?? '';
    case 'HH': return padTwo(hour24);
    case 'H': return String(hour24);
    case 'hh': return padTwo(hour12);
    case 'h': return String(hour12);
    case 'mm': return padTwo(date.getMinutes());
    case 'm': return String(date.getMinutes());
    case 'ss': return padTwo(date.getSeconds());
    case 's': return String(date.getSeconds());
    case 'SSS': return String(date.getMilliseconds()).padStart(3, '0');
    case 'A': return hour24 < 12 ? 'AM' : 'PM';
    case 'a': return hour24 < 12 ? 'am' : 'pm';
  }
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

function readBracketedLiteral(
  format: string,
  start: number,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  let value = '';
  for (let index = start; index < format.length; index++) {
    const character = format[index];
    if (character === ']') return { ok: true, value, next: index + 1 };
    if (character === '\\' && index + 1 < format.length) {
      value += format[++index];
    } else {
      value += character;
    }
  }
  return { ok: false, error: 'Close bracketed literal text with ].' };
}
