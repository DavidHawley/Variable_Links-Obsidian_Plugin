export type NamedCreationType = 'fixed' | 'property';

export interface NamedCreationQuery {
  name: string;
  typeQuery: string;
  type?: NamedCreationType;
  source?: string;
  hasSource: boolean;
}

export type FixedCreationSourceResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function parseNamedCreationQuery(value: string): NamedCreationQuery | null {
  const separator = value.indexOf('=');
  if (separator === -1) return null;
  const name = value.slice(0, separator).trim();
  const expression = value.slice(separator + 1);
  const sourceSeparator = expression.indexOf(':');
  const rawType = (sourceSeparator === -1
    ? expression
    : expression.slice(0, sourceSeparator)).trim();
  const normalizedType = rawType.toLocaleLowerCase();
  const type = normalizedType === 'fixed' || normalizedType === 'property'
    ? normalizedType
    : undefined;
  return {
    name,
    typeQuery: normalizedType,
    type,
    source: sourceSeparator === -1 ? undefined : expression.slice(sourceSeparator + 1),
    hasSource: sourceSeparator !== -1,
  };
}

export function parseFixedCreationSource(source: string): FixedCreationSourceResult {
  const value = source.trim();
  if (!value.startsWith('"')) return { ok: true, value };
  if (value.length < 2 || !value.endsWith('"') || isEscaped(value, value.length - 1)) {
    return { ok: false, error: 'Close the quoted fixed value with a double quote.' };
  }

  let parsed = '';
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== '\\') {
      parsed += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === '"' || escaped === '\\') parsed += escaped;
    else return { ok: false, error: 'Quoted fixed values only use \\" and \\\\ escapes.' };
  }
  return { ok: true, value: parsed };
}

export function isValidNamedCreationName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let position = index - 1; position >= 0 && value[position] === '\\'; position--) slashes++;
  return slashes % 2 === 1;
}
