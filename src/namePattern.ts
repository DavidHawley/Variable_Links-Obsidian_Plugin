export interface NamePatternContext {
  filename?: string;
  folder?: string;
  path?: string;
  profile?: string;
  properties?: Readonly<Record<string, unknown>>;
  property?: string;
  value?: unknown;
  variable?: string;
}

export interface NamePatternResult {
  errors: string[];
  value: string;
}

export function renderNamePattern(
  pattern: string,
  context: NamePatternContext,
  counter = 1,
): NamePatternResult {
  const errors: string[] = [];
  let value = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next && ['\\', '#', '{', '}'].includes(next)) {
        value += next;
        index += 2;
      } else {
        value += character;
        index++;
      }
      continue;
    }
    if (character === '#') {
      let end = index + 1;
      while (pattern[end] === '#') end++;
      const width = end - index;
      value += String(counter).padStart(width, '0');
      index = end;
      continue;
    }
    if (character !== '{') {
      value += character;
      index++;
      continue;
    }
    const closing = findClosingBrace(pattern, index + 1);
    if (closing < 0) {
      errors.push('The pattern contains an opening brace without a closing brace.');
      value += pattern.slice(index);
      break;
    }
    const placeholder = pattern.slice(index + 1, closing).trim();
    const resolved = resolvePlaceholderExpression(placeholder, context);
    if (resolved.error) errors.push(resolved.error);
    else value += resolved.value;
    index = closing + 1;
  }
  return { value, errors: [...new Set(errors)] };
}

function resolvePlaceholderExpression(
  expression: string,
  context: NamePatternContext,
): { error?: string; value: string } {
  const [rawPlaceholder, ...rawWrappers] = splitPipeline(expression);
  if (!rawPlaceholder) return { value: '', error: 'A pattern placeholder cannot be empty.' };
  const resolved = resolvePlaceholder(unescapePlaceholder(rawPlaceholder), context);
  if (resolved.error) return resolved;
  let value = resolved.value;
  for (const rawWrapper of rawWrappers) {
    const wrapper = unescapePlaceholder(rawWrapper).trim();
    if (!wrapper) return { value: '', error: 'A pattern wrapper cannot be empty.' };
    const transformed = applyPatternWrapper(value, wrapper);
    if (transformed.error) return transformed;
    value = transformed.value;
  }
  return { value };
}

function resolvePlaceholder(
  placeholder: string,
  context: NamePatternContext,
): { error?: string; value: string } {
  const normalized = placeholder.toLocaleLowerCase();
  if (normalized.startsWith('property:')) {
    const propertyName = placeholder.slice(placeholder.indexOf(':') + 1).trim();
    if (!propertyName) return { value: '', error: 'A property placeholder requires a property name.' };
    if (!context.properties
      || !Object.prototype.hasOwnProperty.call(context.properties, propertyName)) {
      return { value: '', error: `The source note has no “${propertyName}” property.` };
    }
    return { value: formatPatternValue(context.properties[propertyName]) };
  }
  const values: Record<string, unknown> = {
    filename: context.filename,
    file: context.filename,
    folder: context.folder,
    path: context.path,
    profile: context.profile,
    property: context.property,
    value: context.value,
    variable: context.variable,
  };
  if (!Object.prototype.hasOwnProperty.call(values, normalized)) {
    return { value: '', error: `Unknown pattern placeholder “{${placeholder}}”.` };
  }
  const resolved = values[normalized];
  if (resolved === undefined) {
    return { value: '', error: `Pattern placeholder “{${placeholder}}” is unavailable for this variable.` };
  }
  return { value: formatPatternValue(resolved) };
}

function applyPatternWrapper(value: string, wrapper: string): { error?: string; value: string } {
  const match = /^(word|char)\((.*)\)$/iu.exec(wrapper);
  if (!match) return { value: '', error: `Unknown pattern wrapper “${wrapper}”.` };
  const name = match[1]?.toLocaleLowerCase() ?? '';
  const indexes = parseWrapperIndexes(match[2] ?? '', name);
  if (indexes.error) return { value: '', error: indexes.error };
  const items = name === 'word'
    ? value.split(/[\s,_]+/u).filter(Boolean)
    : Array.from(value);
  const unavailable = indexes.value.find((index) => index > items.length);
  if (unavailable !== undefined) {
    return {
      value: '',
      error: `${capitalize(name)} position ${unavailable} is unavailable; this result has ${items.length} ${name}${items.length === 1 ? '' : 's'}.`,
    };
  }
  const selected = indexes.value.map((index) => items[index - 1] ?? '');
  return { value: selected.join(name === 'word' ? '_' : '') };
}

function parseWrapperIndexes(
  value: string,
  name: string,
): { error?: string; value: number[] } {
  const positions = value.split(',').map((position) => position.trim());
  if (!positions.length || positions.some((position) => !/^\d+$/u.test(position))) {
    return {
      value: [],
      error: `${capitalize(name)} wrappers require 1-based positions separated by commas.`,
    };
  }
  const indexes = positions.map(Number);
  if (indexes.some((index) => index < 1)) {
    return { value: [], error: `${capitalize(name)} positions must start at 1.` };
  }
  return { value: indexes };
}

function splitPipeline(value: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index] ?? '';
    if (character === '\\' && index + 1 < value.length) {
      part += character + (value[index + 1] ?? '');
      index++;
    } else if (character === '|') {
      parts.push(part.trim());
      part = '';
    } else {
      part += character;
    }
  }
  parts.push(part.trim());
  return parts;
}

function findClosingBrace(pattern: string, start: number): number {
  for (let index = start; index < pattern.length; index++) {
    if (pattern[index] === '\\') {
      index++;
      continue;
    }
    if (pattern[index] === '}') return index;
  }
  return -1;
}

function unescapePlaceholder(value: string): string {
  return value.replace(/\\([\\#{}|])/g, '$1');
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toLocaleUpperCase() ?? ''}${value.slice(1)}` : value;
}

function formatPatternValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === undefined || value === null) return '';
  if (typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}
