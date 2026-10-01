export function valueEditorText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

export function parseEditedValue(text: string, original: unknown): unknown {
  if (typeof original === 'string' || original === undefined || original === null) return text;
  if (typeof original === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text.trim()) || !Number.isFinite(Number(text))) throw new Error('Enter a finite number');
    return Number(text);
  }
  if (typeof original === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('Choose true or false');
    return text === 'true';
  }
  const next: unknown = JSON.parse(text);
  if (Array.isArray(original) && !Array.isArray(next)) throw new Error('Enter a JSON list');
  if (!Array.isArray(original) && (next === null || typeof next !== 'object' || Array.isArray(next))) throw new Error('Enter a JSON object');
  return next;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
