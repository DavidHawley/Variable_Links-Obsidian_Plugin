import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEditedValue, valueEditorText, valuesEqual } from '../src/valueEditing';

test('property edits preserve the original scalar or structured type', () => {
  assert.equal(parseEditedValue('0.12', '1'), '0.12');
  assert.equal(parseEditedValue('0.12', 1), 0.12);
  assert.equal(parseEditedValue('false', true), false);
  assert.deepEqual(parseEditedValue('[1,2]', []), [1, 2]);
  assert.deepEqual(parseEditedValue('{"a":2}', { a: 1 }), { a: 2 });
  assert.throws(() => parseEditedValue('12px', 1));
  assert.throws(() => parseEditedValue('', 1));
  assert.throws(() => parseEditedValue('yes', true));
  assert.throws(() => parseEditedValue('2', []));
});

test('structured property snapshots detect external edits', () => {
  const value = { status: 'Draft', tags: ['one', 'two'] };
  assert.ok(valuesEqual(JSON.parse(valueEditorText(value)), value));
  assert.ok(!valuesEqual(value, { ...value, status: 'Final' }));
});
