import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSuggestionSearchMode, parseSuggestionQuery, scoreSuggestionFields, formatSuggestionValue, truncateSuggestionValue } from '../src/suggestionSearch';

test('all focused prefixes, their empty modes, and escaped literal names are recognized', () => {
  for (const [prefix, mode] of [['@', 'variables'], [';', 'properties'], ['!', 'values'], ['*', 'values'], ['~', 'shortcuts'], ['?', 'help']] as const) {
    assert.deepEqual(parseSuggestionSearchMode(`${prefix}john status`), { mode, query: 'john status', escapedPrefix: false });
    assert.deepEqual(parseSuggestionSearchMode(prefix), { mode, query: '', escapedPrefix: false });
    assert.deepEqual(parseSuggestionSearchMode(`\\${prefix}name`), { mode: 'all', query: `${prefix}name`, escapedPrefix: true });
  }
  assert.deepEqual(parseSuggestionSearchMode('john status'), { mode: 'all', query: 'john status', escapedPrefix: false });
  assert.deepEqual(parseSuggestionSearchMode(''), { mode: 'all', query: '', escapedPrefix: false });
});

test('combined multi-term search matches across fields and ranks exact, prefix, whole-word, and substring', () => {
  const terms = parseSuggestionQuery('  JOHN    Status  ').terms;
  assert.deepEqual(terms, ['john', 'status']);
  assert.notEqual(scoreSuggestionFields(terms, ['Status', 'Characters/John Smith.md']), null);
  assert.equal(scoreSuggestionFields(terms, ['Status', 'Characters/Jane Smith.md']), null);
  const scores = ['status', 'statusName', 'note status value', 'mystatusvalue'].map((field) => scoreSuggestionFields(['status'], [field])!);
  assert.ok(scores.every((score, index) => index === 0 || score > scores[index - 1]));
});

test('value previews preserve booleans, numeric lists, Unicode, and the underlying source value', () => {
  const source = [0, false, '  one\n two  '];
  assert.equal(formatSuggestionValue(source), '0, false, one two');
  assert.deepEqual(source, [0, false, '  one\n two  ']);
  assert.equal(truncateSuggestionValue('😀😀😀😀', 3), '😀😀…');
  assert.deepEqual(parseSuggestionQuery('*false 0'), { valueMode: true, terms: ['false', '0'] });
});
