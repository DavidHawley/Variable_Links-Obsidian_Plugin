export type AutolinkScopeType = 'file' | 'folder';
export type AutolinkCardPreset = 'none' | 'classic' | 'compact' | 'profile';

export interface AutolinkOverrideProperties {
  name: string;
  valueProperty: string;
  template: string;
  cardProperties: string;
}

export const DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES: AutolinkOverrideProperties = {
  name: 'variablelink_name',
  valueProperty: 'variablelink_value_property',
  template: 'variablelink_template',
  cardProperties: 'variablelink_card_properties',
};

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
  allowOverrides: boolean;
  customOverridePropertyNames: boolean;
  overrideProperties: AutolinkOverrideProperties;
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
    allowOverrides: true,
    customOverridePropertyNames: false,
    overrideProperties: { ...DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES },
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
      allowOverrides: item.allowOverrides !== false,
      customOverridePropertyNames: item.customOverridePropertyNames === true,
      overrideProperties: normalizeOverrideProperties(item.overrideProperties),
    });
  }
  return profiles;
}

function normalizeOverrideProperties(value: unknown): AutolinkOverrideProperties {
  const source = isRecord(value) ? value : {};
  return {
    name: normalizePropertyName(source.name, DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.name),
    valueProperty: normalizePropertyName(
      source.valueProperty,
      DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.valueProperty,
    ),
    template: normalizePropertyName(
      source.template,
      DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.template,
    ),
    cardProperties: normalizePropertyName(
      source.cardProperties,
      DEFAULT_AUTOLINK_OVERRIDE_PROPERTIES.cardProperties,
    ),
  };
}

function normalizePropertyName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeVaultPath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    : '';
}

export function profileMatchesPath(profile: AutolinkProfile, filePath: string): boolean {
  const candidate = withMarkdownExtension(normalizeVaultPath(filePath));
  if (!candidate) return false;
  if (profile.scopeType === 'file') {
    const target = withMarkdownExtension(normalizeVaultPath(profile.path));
    return Boolean(target) && candidate.toLocaleLowerCase() === target.toLocaleLowerCase();
  }
  const folder = normalizeVaultPath(profile.path).toLocaleLowerCase();
  const path = normalizeVaultPath(filePath).toLocaleLowerCase();
  if (!folder || !path.startsWith(`${folder}/`)) return false;
  return profile.includeSubfolders || !path.slice(folder.length + 1).includes('/');
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

function withMarkdownExtension(path: string): string {
  return path && !/\.md$/i.test(path) ? `${path}.md` : path;
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
