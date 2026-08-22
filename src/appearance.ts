export type VariableDecoration = 'underline' | 'highlight' | 'none';

export interface VariableAppearance {
  bold?: boolean;
  italic?: boolean;
  decoration?: VariableDecoration;
  color?: string;
  opacity?: number;
}

export interface VariableAppearanceDefaults {
  defaultAppearanceBold: boolean;
  defaultAppearanceItalic: boolean;
  defaultAppearanceDecoration: VariableDecoration;
  defaultAppearanceUseCustomColor: boolean;
  defaultAppearanceColor: string;
  defaultAppearanceOpacity: number;
}

export const DEFAULT_APPEARANCE_COLORS = [
  '#7f6df2',
  '#e05d6f',
  '#e5a84b',
  '#4caf72',
  '#3b82f6',
  '#a855f7',
] as const;

export function normalizeVariableAppearance(value: unknown): VariableAppearance | undefined {
  if (!isRecord(value)) return undefined;
  const appearance: VariableAppearance = {};
  if (value.bold === true) appearance.bold = true;
  if (value.italic === true) appearance.italic = true;
  if (value.decoration === 'highlight' || value.decoration === 'none') {
    appearance.decoration = value.decoration;
  }
  if (typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color.trim())) {
    appearance.color = value.color.trim().toLowerCase();
  }
  const opacity = normalizeAppearanceOpacity(value.opacity);
  if (opacity !== 100) appearance.opacity = opacity;
  return appearance;
}

export function normalizeAppearanceColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

export function normalizeAppearanceColors(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  return DEFAULT_APPEARANCE_COLORS.map((fallback, index) =>
    normalizeAppearanceColor(source[index], fallback));
}

export function normalizeAppearanceOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function getDefaultVariableAppearance(
  settings: VariableAppearanceDefaults,
): VariableAppearance {
  const appearance: VariableAppearance = {};
  if (settings.defaultAppearanceBold) appearance.bold = true;
  if (settings.defaultAppearanceItalic) appearance.italic = true;
  if (settings.defaultAppearanceDecoration !== 'underline') {
    appearance.decoration = settings.defaultAppearanceDecoration;
  }
  if (settings.defaultAppearanceUseCustomColor
    && settings.defaultAppearanceDecoration !== 'none') {
    appearance.color = settings.defaultAppearanceColor;
  }
  if (settings.defaultAppearanceOpacity !== 100
    && settings.defaultAppearanceDecoration !== 'none') {
    appearance.opacity = settings.defaultAppearanceOpacity;
  }
  return appearance;
}

export function getEffectiveVariableAppearance(
  override: VariableAppearance | undefined,
  settings: VariableAppearanceDefaults,
): VariableAppearance {
  return override ?? getDefaultVariableAppearance(settings);
}

export function applyVariableAppearance(
  element: HTMLElement,
  appearance: VariableAppearance | undefined,
): void {
  const decoration = appearance?.decoration ?? 'underline';
  element.classList.toggle('is-bold', appearance?.bold === true);
  element.classList.toggle('is-italic', appearance?.italic === true);
  element.classList.toggle('is-underlined', decoration === 'underline');
  element.classList.toggle('is-highlighted', decoration === 'highlight');
  element.classList.toggle('has-no-decoration', decoration === 'none');
  if (appearance?.color) {
    element.style.setProperty('--variable-links-decoration-color', appearance.color);
  } else {
    element.style.removeProperty('--variable-links-decoration-color');
  }
  element.style.setProperty(
    '--variable-links-decoration-opacity',
    `${appearance?.opacity ?? 100}%`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
