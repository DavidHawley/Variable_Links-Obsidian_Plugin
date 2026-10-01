import { formatCapturedDateTime, type CapturedTimeShortcut } from './dateTime';

export interface TemporalValue {
  kind: CapturedTimeShortcut;
  iso: string;
  format: string;
}

export type DurationUnit = 'y' | 'M' | 'w' | 'd' | 'h' | 'm' | 's';
export interface DurationPart { unit: DurationUnit; amount: number }

export function parseDuration(source: string): DurationPart[] {
  const parts = source.split(',').map((part) => part.trim());
  if (!parts.length || parts.length > 32) throw new Error('Use one to 32 duration amounts');
  return parts.map((part) => {
    const match = part.match(/^([+-]?\d+)([yMwdhms])$/u);
    if (!match) throw new Error(`Invalid duration '${part}'; use y, M, w, d, h, m, or s`);
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > 1_000_000) {
      throw new Error('Duration amount is outside the supported range');
    }
    return { unit: match[2] as DurationUnit, amount };
  });
}

/** ISO inputs only. Date-only values use local midnight; times use January 1, 2000. */
export function parseTemporalInput(source: string, kind: CapturedTimeShortcut): Date {
  const value = source.trim();
  const pattern = kind === 'date'
    ? /^(\d{4})-(\d{2})-(\d{2})$/u
    : kind === 'time'
      ? /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u
      : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/u;
  const match = value.match(pattern);
  if (!match) throw new Error('Use YYYY-MM-DD, HH:mm[:ss], or YYYY-MM-DDTHH:mm[:ss] for the selected date/time kind');
  const timeOnly = kind === 'time';
  const year = timeOnly ? 2000 : Number(match[1]);
  const month = timeOnly ? 1 : Number(match[2]);
  const day = timeOnly ? 1 : Number(match[3]);
  const hour = kind === 'date' ? 0 : Number(match[timeOnly ? 1 : 4]);
  const minute = kind === 'date' ? 0 : Number(match[timeOnly ? 2 : 5]);
  const second = kind === 'date' ? 0 : Number(match[timeOnly ? 3 : 6] ?? 0);
  const millis = kind === 'date' ? 0 : Number((match[timeOnly ? 4 : 7] ?? '').padEnd(3, '0'));
  const zone = kind === 'datetime' ? match[8] : undefined;
  if (year < 100 || month < 1 || month > 12 || day < 1
    || day > new Date(year, month, 0).getDate() || hour > 23 || minute > 59 || second > 59) {
    throw new Error('Invalid calendar date or time');
  }
  if (zone) {
    const offset = zone.match(/^[+-](\d{2}):(\d{2})$/u);
    if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) throw new Error('Invalid time zone offset');
    const date = new Date(value.replace(' ', 'T'));
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid date/time');
    return date;
  }
  const date = new Date(year, month - 1, day, hour, minute, second, millis);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    throw new Error('This local time does not exist due to a daylight-saving transition');
  }
  return date;
}

export function createTemporalValue(source: string, kind: CapturedTimeShortcut, format: string): TemporalValue {
  const date = parseTemporalInput(source, kind);
  requireSupportedDate(date);
  const formatted = formatCapturedDateTime(date, format);
  if (!formatted.ok) throw new Error(formatted.error);
  return { kind, iso: date.toISOString(), format };
}

export function normalizeTemporalValue(value: unknown): TemporalValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if ((raw.kind !== 'date' && raw.kind !== 'time' && raw.kind !== 'datetime')
    || typeof raw.iso !== 'string' || typeof raw.format !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.iso)) return undefined;
  const date = new Date(raw.iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw.iso
    || !formatCapturedDateTime(date, raw.format).ok) return undefined;
  try { requireSupportedDate(date); } catch { return undefined; }
  return { kind: raw.kind, iso: raw.iso, format: raw.format };
}

export function formatTemporalValue(value: TemporalValue): string {
  const formatted = formatCapturedDateTime(new Date(value.iso), value.format);
  if (!formatted.ok) throw new Error(formatted.error);
  return formatted.value;
}

export function temporalInputText(value: TemporalValue): string {
  const format = value.kind === 'date' ? 'YYYY-MM-DD'
    : value.kind === 'time' ? 'HH:mm:ss.SSS' : 'YYYY-MM-DD[T]HH:mm:ss.SSS';
  const formatted = formatCapturedDateTime(new Date(value.iso), format);
  return formatted.ok ? formatted.value : '';
}

/** Calendar units preserve local wall time; h/m/s are elapsed time across DST. */
export function adjustTemporalValue(value: TemporalValue, parts: readonly DurationPart[], subtract = false): TemporalValue {
  const date = new Date(value.iso);
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  const amounts = new Map<DurationUnit, number>();
  for (const part of parts) amounts.set(part.unit, (amounts.get(part.unit) ?? 0) + part.amount * (subtract ? -1 : 1));
  for (const unit of ['y', 'M'] as const) {
    const amount = amounts.get(unit) ?? 0;
    if (!amount) continue;
    const day = date.getDate();
    date.setDate(1);
    if (unit === 'y') date.setFullYear(date.getFullYear() + amount);
    else date.setMonth(date.getMonth() + amount);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }
  const days = (amounts.get('w') ?? 0) * 7 + (amounts.get('d') ?? 0);
  if (days) date.setDate(date.getDate() + days);
  if (date.getHours() !== clock[0] || date.getMinutes() !== clock[1]
    || date.getSeconds() !== clock[2] || date.getMilliseconds() !== clock[3]) {
    throw new Error('The target calendar time does not exist due to a daylight-saving transition');
  }
  const elapsed = (amounts.get('h') ?? 0) * 3_600_000 + (amounts.get('m') ?? 0) * 60_000 + (amounts.get('s') ?? 0) * 1_000;
  date.setTime(date.getTime() + elapsed);
  requireSupportedDate(date);
  return { ...value, iso: date.toISOString() };
}

function requireSupportedDate(date: Date): void {
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 100 || date.getFullYear() > 9999
    || date.getUTCFullYear() < 100 || date.getUTCFullYear() > 9999) {
    throw new Error('Date/time is outside supported years 0100 to 9999');
  }
}
