import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustTemporalValue, createTemporalValue, formatTemporalValue, normalizeTemporalValue, parseDuration, parseTemporalInput } from '../src/temporal';
import { findVariableTokens, formatVariableToken, parseVariableSelector } from '../src/tokenSyntax';
import { resolutionErrorText } from '../src/resolutionError';

test('calendar month and leap-year arithmetic clamps rather than overflowing', () => {
  const january = createTemporalValue('2024-01-31', 'date', 'YYYY-MM-DD');
  assert.equal(formatTemporalValue(adjustTemporalValue(january, parseDuration('1M'))), '2024-02-29');
  const leap = createTemporalValue('2024-02-29', 'date', 'YYYY-MM-DD');
  assert.equal(formatTemporalValue(adjustTemporalValue(leap, parseDuration('1y'))), '2025-02-28');
  assert.equal(formatTemporalValue(adjustTemporalValue(january, parseDuration('1M'), true)), '2023-12-31');
  assert.equal(formatTemporalValue(adjustTemporalValue(january, parseDuration('2M,3d'))), '2024-04-03');
});

test('strict temporal parsing rejects invalid dates, times, zones and duration syntax', () => {
  for (const source of ['2023-02-29', '2024-02-30', '2024-13-01']) assert.throws(() => parseTemporalInput(source, 'date'));
  for (const source of ['24:00', '12:61', '10:20:60']) assert.throws(() => parseTemporalInput(source, 'time'));
  assert.throws(() => parseTemporalInput('2024-01-01T12:00+99:00', 'datetime'));
  for (const source of ['', '1x', '1.5M', '1M,', '9007199254740992s']) assert.throws(() => parseDuration(source));
  assert.equal(parseTemporalInput('2024-01-01T12:00:00.5Z', 'datetime').toISOString(), '2024-01-01T12:00:00.500Z');
});

test('canonical values round-trip independently of display format', () => {
  const value = createTemporalValue('2024-01-31', 'date', 'MMMM D, YYYY');
  assert.deepEqual(normalizeTemporalValue(JSON.parse(JSON.stringify(value))), value);
  assert.equal(formatTemporalValue({ ...value, format: 'YYYY-MM-DD' }), '2024-01-31');
  assert.equal(normalizeTemporalValue({ ...value, iso: '2024-02-30T00:00:00.000Z' }), undefined);
});

test('date, time, and datetime values handle mixed durations and day, month, and year boundaries', () => {
  const date = createTemporalValue('2024-12-31', 'date', 'YYYY-MM-DD');
  assert.equal(formatTemporalValue(adjustTemporalValue(date, parseDuration('1d'))), '2025-01-01');
  const time = createTemporalValue('23:50:30', 'time', 'YYYY-MM-DD HH:mm:ss');
  assert.equal(formatTemporalValue(time), '2000-01-01 23:50:30');
  assert.equal(formatTemporalValue(adjustTemporalValue(time, parseDuration('15m,40s'))), '2000-01-02 00:06:10');
  const datetime = createTemporalValue('2024-01-31T12:00', 'datetime', 'YYYY-MM-DD HH:mm:ss');
  assert.equal(formatTemporalValue(adjustTemporalValue(datetime, parseDuration('1M,1w,2d,2h,15m,5s'))), '2024-03-09 14:15:05');
  assert.equal(formatTemporalValue(adjustTemporalValue(datetime, parseDuration('2M,3d'), true)), '2023-11-27 12:00:00');
});

test('date selectors survive chained parsing and custom token delimiters', () => {
  const parsed = parseVariableSelector('date::add(2M,3d,2h,15m)::sub(1w)');
  assert.ok(parsed.selector);
  const token = formatVariableToken(parsed.name, { prefix: '<<', suffix: '>>' }, undefined, parsed.selector);
  assert.equal(token, '<<date::add(2M,3d,2h,15m)::sub(1w)>>');
  assert.deepEqual(findVariableTokens(token, { prefix: '<<', suffix: '>>' })[0].selector, parsed.selector);
});

test('calendar days and elapsed hours differ across DST and invalid target wall times fail clearly', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const start = createTemporalValue('2024-03-09T12:00', 'datetime', 'YYYY-MM-DD HH:mm');
    const day = adjustTemporalValue(start, parseDuration('1d'));
    const hours = adjustTemporalValue(start, parseDuration('24h'));
    assert.equal(formatTemporalValue(day), '2024-03-10 12:00');
    assert.equal(formatTemporalValue(hours), '2024-03-10 13:00');
    assert.throws(() => parseTemporalInput('2024-03-10T02:30', 'datetime'), /does not exist/u);
    const gap = createTemporalValue('2024-03-09T02:30', 'datetime', 'YYYY-MM-DD HH:mm');
    assert.throws(() => adjustTemporalValue(gap, parseDuration('1d')), /does not exist/u);
    const fall = createTemporalValue('2024-11-02T12:00', 'datetime', 'YYYY-MM-DD HH:mm');
    const next = adjustTemporalValue(fall, parseDuration('1d'));
    assert.equal(new Date(next.iso).getTime() - new Date(fall.iso).getTime(), 25 * 3_600_000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('computed and missing errors remain distinct including exact names beginning with equals', () => {
  assert.equal(resolutionErrorText('total', { type: 'computed' }), '[Expression error]');
  assert.equal(resolutionErrorText('=2+2'), '[Expression error]');
  assert.equal(resolutionErrorText('=OldName', { type: 'fixed' }), '[Missing: =OldName]');
  assert.equal(resolutionErrorText('missing'), '[Missing: missing]');
});
