import {
  formatVariableSelector,
  parseVariableSelector,
  type VariableSelector,
} from './tokenSyntax';

export interface VariableShortcut {
  code: string;
  displayName?: string;
  enabled: boolean;
  id: string;
  searchTerms: string[];
  selector?: VariableSelector;
  targetGuid: string;
}

export function normalizeVariableShortcuts(value: unknown): VariableShortcut[] {
  if (!Array.isArray(value)) return [];
  const shortcuts: VariableShortcut[] = [];
  const usedCodes = new Set<string>();
  const usedIds = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const code = typeof candidate.code === 'string' ? candidate.code.trim() : '';
    const targetGuid = typeof candidate.targetGuid === 'string' ? candidate.targetGuid.trim() : '';
    const normalizedCode = code.toLocaleLowerCase();
    if (!code || !targetGuid || usedCodes.has(normalizedCode)) continue;
    const selector = parseStoredSelector(candidate.selector);
    if (candidate.selector !== undefined && !selector) continue;
    let id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || usedIds.has(id)) id = createStableId();
    usedCodes.add(normalizedCode);
    usedIds.add(id);
    const displayName = typeof candidate.displayName === 'string'
      ? candidate.displayName.trim()
      : '';
    shortcuts.push({
      id,
      code,
      targetGuid,
      selector,
      displayName: displayName || undefined,
      searchTerms: normalizeSearchTerms(candidate.searchTerms),
      enabled: candidate.enabled !== false,
    });
  }
  return shortcuts;
}

export function serializeVariableShortcuts(
  shortcuts: readonly VariableShortcut[],
): Array<Record<string, unknown>> {
  return shortcuts.map((shortcut) => {
    const stored: Record<string, unknown> = {
      id: shortcut.id,
      code: shortcut.code,
      targetGuid: shortcut.targetGuid,
      enabled: shortcut.enabled,
    };
    if (shortcut.displayName) stored.displayName = shortcut.displayName;
    if (shortcut.selector) stored.selector = formatVariableSelector(shortcut.selector);
    if (shortcut.searchTerms.length) stored.searchTerms = [...shortcut.searchTerms];
    return stored;
  });
}

export function validateShortcutCode(code: string): void {
  if (!code) throw new Error('Shortcut code is required.');
  if (!/^[\p{L}\p{N}_-]+$/u.test(code)) {
    throw new Error('Shortcut codes may only contain letters, numbers, underscores, and hyphens.');
  }
}

export function normalizeShortcutSearchTerms(value: string | readonly string[]): string[] {
  const terms = typeof value === 'string' ? value.split(',') : value;
  const normalized: string[] = [];
  const used = new Set<string>();
  for (const term of terms) {
    const cleaned = term.trim();
    const key = cleaned.toLocaleLowerCase();
    if (!cleaned || used.has(key)) continue;
    used.add(key);
    normalized.push(cleaned);
  }
  return normalized;
}

function parseStoredSelector(value: unknown): VariableSelector | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.startsWith('::')) return undefined;
  const parsed = parseVariableSelector(`ShortcutTarget${value}`);
  return parsed.name === 'ShortcutTarget' ? parsed.selector : undefined;
}

function normalizeSearchTerms(value: unknown): string[] {
  return Array.isArray(value)
    ? normalizeShortcutSearchTerms(value.filter((term): term is string => typeof term === 'string'))
    : [];
}

function createStableId(): string {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  return `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
