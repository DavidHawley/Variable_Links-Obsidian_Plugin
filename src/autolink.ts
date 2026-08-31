export type AutolinkScopeType = 'file' | 'folder';
export type AutolinkCardPreset = 'none' | 'classic' | 'compact' | 'profile';

export interface AutolinkProfile {
  id: string;
  name: string;
  enabled: boolean;
  scopeType: AutolinkScopeType;
  path: string;
  includeSubfolders: boolean;
  valueProperty: string;
  namePattern: string;
  cardPreset: AutolinkCardPreset;
  cardProperties: string[];
}

export interface ManagedAutolinkEntry {
  profileId: string;
  sourcePath: string;
  managedFields: string[];
}

export function createAutolinkProfile(id = createAutolinkId()): AutolinkProfile {
  return {
    id,
    name: 'New profile',
    enabled: false,
    scopeType: 'folder',
    path: '',
    includeSubfolders: true,
    valueProperty: '',
    namePattern: '',
    cardPreset: 'none',
    cardProperties: [],
  };
}

export function normalizeAutolinkProfiles(value: unknown): AutolinkProfile[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const profiles: AutolinkProfile[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || ids.has(id)) id = createAutolinkId(ids);
    ids.add(id);
    const scopeType: AutolinkScopeType = item.scopeType === 'file' ? 'file' : 'folder';
    const cardPreset: AutolinkCardPreset = item.cardPreset === 'classic'
      || item.cardPreset === 'compact'
      || item.cardPreset === 'profile'
      ? item.cardPreset
      : 'none';
    profiles.push({
      id,
      name: typeof item.name === 'string' ? item.name.trim() || 'Unnamed profile' : 'Unnamed profile',
      enabled: item.enabled === true,
      scopeType,
      path: normalizeVaultPath(item.path),
      includeSubfolders: scopeType === 'folder' && item.includeSubfolders !== false,
      valueProperty: typeof item.valueProperty === 'string' ? item.valueProperty.trim() : '',
      namePattern: typeof item.namePattern === 'string' ? item.namePattern.trim() : '',
      cardPreset,
      cardProperties: normalizeStringList(item.cardProperties),
    });
  }
  return profiles;
}

export function normalizeVaultPath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    : '';
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

function createAutolinkId(existing: ReadonlySet<string> = new Set()): string {
  let id = '';
  do {
    id = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `autolink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  } while (existing.has(id));
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
