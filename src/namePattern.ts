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
    const placeholder = unescapePlaceholder(pattern.slice(index + 1, closing).trim());
    const resolved = resolvePlaceholder(placeholder, context);
    if (resolved.error) errors.push(resolved.error);
    else value += resolved.value;
    index = closing + 1;
  }
  return { value, errors: [...new Set(errors)] };
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
  return value.replace(/\\([\\#{}])/g, '$1');
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
