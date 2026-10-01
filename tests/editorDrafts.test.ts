import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorDrafts } from '../src/editorDrafts';

test('pending drafts and in-flight saves hold refreshes until all edits are resolved', () => {
  const drafts = new EditorDrafts<string>();
  assert.equal(drafts.hasPending, false);
  drafts.markDirty('properties');
  drafts.markDirty('card');
  assert.equal(drafts.hasPending, true);
  assert.equal(drafts.beginSave('properties'), true);
  assert.equal(drafts.isSaving, true);
  assert.equal(drafts.beginSave('card'), false);
  drafts.cancel('properties');
  assert.equal(drafts.hasPending, true);
  drafts.finishSave('properties', true);
  assert.equal(drafts.isSaving, false);
  assert.equal(drafts.hasPending, true);
  drafts.cancel('card');
  assert.equal(drafts.hasPending, false);
});

test('failed saves preserve drafts for retry while successful saves clear only their own draft', () => {
  const drafts = new EditorDrafts<string>();
  assert.equal(drafts.beginSave('properties'), false);
  drafts.markDirty('properties');
  assert.equal(drafts.beginSave('properties'), true);
  drafts.finishSave('properties', false);
  assert.equal(drafts.hasPending, true);
  assert.equal(drafts.beginSave('properties'), true);
  drafts.finishSave('properties', true);
  assert.equal(drafts.hasPending, false);
  drafts.markDirty('linked value');
  drafts.clear();
  assert.equal(drafts.hasPending, false);
  assert.equal(drafts.isSaving, false);
});
