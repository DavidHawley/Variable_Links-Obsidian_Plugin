import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustTemporalValue, captureTemporalValue, createTemporalValue, formatTemporalValue, normalizeTemporalValue, parseDuration, parseTemporalInput } from '../src/temporal';
import { parseCapturedTimeCreationQuery } from '../src/dateTime';
import { isCompleteVariableCreationExpression } from '../src/creationSyntax';
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

test('compact durations match comma-separated amounts while preserving signs, units, and limits', () => {
  assert.deepEqual(parseDuration('3M5m'), parseDuration('3M,5m'));
  assert.deepEqual(parseDuration('1y2M3w4d5h6m7s'), parseDuration('1y,2M,3w,4d,5h,6m,7s'));
  assert.deepEqual(parseDuration(' -3M+5m, 2d-1h '), parseDuration('-3M,+5m,2d,-1h'));
  assert.deepEqual(parseDuration('3M 5m'), parseDuration('3M,5m'));
  assert.deepEqual(parseDuration('0d0h'), [{ unit: 'd', amount: 0 }, { unit: 'h', amount: 0 }]);
  assert.equal(parseDuration('1s'.repeat(32)).length, 32);
  for (const source of ['3M5', '3M5x', '3M5.5m', '3M,', ',3M', '3M,,5m', '3MM5m', '3 M5m', '3M--5m', '3M/5m', '1s'.repeat(33), '1s,'.repeat(33), '3M1000001m', '1'.repeat(10_001)]) {
    assert.throws(() => parseDuration(source));
  }
});

test('compact date creation and selector pipelines produce the same adjusted canonical values', () => {
  const now = new Date(2024, 5, 30, 12, 30);
  const compact = captureTemporalValue(now, 'datetime', 'YYYY-MM-DD HH:mm', '::sub(3M5m)');
  assert.equal(formatTemporalValue(compact), '2024-03-30 12:25');
  assert.deepEqual(compact, captureTemporalValue(now, 'datetime', 'YYYY-MM-DD HH:mm', '::sub(3M,5m)'));
  const parsed = parseVariableSelector('date::sub(3M5m)::add(1w2d)');
  assert.deepEqual(parsed, parseVariableSelector('date::sub(3M,5m)::add(1w,2d)'));
  const token = formatVariableToken(parsed.name, { prefix: '<<', suffix: '>>' }, undefined, parsed.selector);
  assert.equal(token, '<<date::sub(3M,5m)::add(1w,2d)>>');
  assert.deepEqual(findVariableTokens(token, { prefix: '<<', suffix: '>>' })[0].selector, parsed.selector);
});

test('typed date creation parses adjustment pipelines and preserves custom and literal formats', () => {
  const plain = parseCapturedTimeCreationQuery('due=DATE::add(7d)::sub(1w)');
  assert.equal(plain?.requestedName, 'due');
  assert.equal(plain?.type, 'date');
  assert.equal(plain?.hasFormat, false);
  assert.equal(plain?.adjustment, '::add(7d)::sub(1w)');
  const formatted = parseCapturedTimeCreationQuery('due=DATE:YYYY-MM-DD [::]::sub(1M)');
  assert.equal(formatted?.format, 'YYYY-MM-DD [::]');
  assert.equal(formatted?.adjustment, '::sub(1M)');
  assert.equal(parseCapturedTimeCreationQuery('TIME:HH:mm:ss')?.format, 'HH:mm:ss');
  assert.equal(parseCapturedTimeCreationQuery('DATE:YYYY-MM-DD [::add(7d)]')?.adjustment, undefined);
  assert.equal(parseCapturedTimeCreationQuery('DATE:YYYY-MM-DD \\:\\:')?.adjustment, undefined);
  assert.equal(isCompleteVariableCreationExpression('due=DATE::add(7d)'), true);
  assert.equal(parseCapturedTimeCreationQuery('due=FIXED:today'), null);
});

test('creation-time adjustments save their adjusted canonical date rather than a selector on an unadjusted date', () => {
  const now = new Date(2024, 0, 31, 12, 0);
  const nextMonth = captureTemporalValue(now, 'date', 'YYYY-MM-DD', '::add(1M)');
  assert.equal(formatTemporalValue(nextMonth), '2024-02-29');
  assert.equal(formatTemporalValue({ ...nextMonth, format: 'DD/MM/YYYY' }), '29/02/2024');
  assert.equal(formatTemporalValue(captureTemporalValue(now, 'date', 'YYYY-MM-DD', '::sub(1M)::add(7d)')), '2024-01-07');
  assert.equal(formatTemporalValue(captureTemporalValue(now, 'datetime', 'YYYY-MM-DD HH:mm', '::add(1M,2h)::sub(15m)')), '2024-02-29 13:45');
  assert.equal(formatTemporalValue(captureTemporalValue(now, 'time', 'HH:mm', '::sub(30m)')), '11:30');
  for (const adjustment of ['::add(', '::add(1x)', '::upper()', '::add(7d)::', '::sub(1.5M)', '::add(1000000y)']) {
    assert.throws(() => captureTemporalValue(now, 'date', 'YYYY-MM-DD', adjustment));
  }
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
