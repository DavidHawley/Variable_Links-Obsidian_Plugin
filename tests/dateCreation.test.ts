import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { App, Editor, TFile } from 'obsidian';
import type VariableSuggestType from '../src/suggest';
import type Registry from '../src/registry';
import type { VariableDefinition } from '../src/registry';
import type Indexer from '../src/indexer';
import type Resolver from '../src/resolver';
import { captureTemporalValue, formatTemporalValue } from '../src/temporal';

const bundle = await build({
  stdin: { contents: "export { default as VariableSuggest } from './src/suggest'; export { TFile as TestFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'date-creation-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'date-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'date-host' }, () => ({ contents: `
      export class App {} export class Editor {} export class Modal {} export class Notice {}
      export class TFile { constructor(path) { this.path = path; this.basename = path.replace(/\\.md$/, ''); } }
      export class EditorSuggest { constructor(app) { this.app = app; } close() {} }
      export const parseYaml = JSON.parse; export const stringifyYaml = JSON.stringify;
    ` }));
  } }],
});
// eslint-disable-next-line no-unsanitized/method -- Only repository source and this host stub are bundled.
const { VariableSuggest, TestFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as { VariableSuggest: typeof VariableSuggestType; TestFile: new (path: string) => TFile };

function fixture(expression: string) {
  let note = `{{${expression}}}`;
  const original = note;
  const definitions = new Map<string, VariableDefinition>();
  const registry = {
    data: definitions,
    plugin: { settings: { tokenPrefix: '{{', tokenSuffix: '}}', defaultDateFormat: 'YYYY-MM-DD', defaultTimeFormat: 'HH:mm', defaultDateTimeFormat: 'YYYY-MM-DD HH:mm' } },
    getVariable: (name: string) => definitions.get(name) ?? null,
    saveVariable: async (name: string, definition: VariableDefinition) => { definitions.set(name, definition); },
  } as unknown as Registry;
  const indexer = { byName: new Map(), build: async () => {} } as unknown as Indexer;
  const suggest = new VariableSuggest({} as App, indexer, registry, {} as Resolver, async () => {}, async () => {});
  const editor = {
    getRange: () => note,
    getCursor: () => ({ line: 0, ch: note.length }),
    replaceRange: (text: string) => { note = text; },
    setCursor: () => {}, focus: () => {},
  } as unknown as Editor;
  return { definitions, original, text: () => note, complete: () => suggest.completeTypedCapturedTimeExpression(editor, new TestFile('note.md'), { line: 0, ch: 0 }, { line: 0, ch: original.length }, original, expression) };
}

test('typed DATE creation saves an adjusted canonical date and replaces the whole creation expression', async () => {
  const view = fixture('due=DATE::add(7d)::sub(1d)');
  const before = formatTemporalValue(captureTemporalValue(new Date(), 'date', 'YYYY-MM-DD', '::add(6d)'));
  assert.equal(await view.complete(), true);
  const after = formatTemporalValue(captureTemporalValue(new Date(), 'date', 'YYYY-MM-DD', '::add(6d)'));
  const saved = view.definitions.get('due');
  assert.equal(saved?.type, 'fixed');
  assert.equal(saved?.temporal?.kind, 'date');
  assert.ok(saved?.temporal);
  assert.ok([before, after].includes(formatTemporalValue(saved.temporal)));
  assert.equal(saved.value, formatTemporalValue(saved.temporal));
  assert.equal(view.text(), '{{due}}');
});

test('typed date creation supports automatic names, custom formats and time arithmetic', async () => {
  const automatic = fixture('DATE::sub(1M)');
  await automatic.complete();
  assert.equal(automatic.text(), '{{note_Date_01}}');
  assert.equal(automatic.definitions.get('note_Date_01')?.temporal?.kind, 'date');
  const time = fixture('clock=TIME:HH:mm:ss::add(15m)::sub(1h)');
  await time.complete();
  assert.equal(time.text(), '{{clock}}');
  assert.equal(time.definitions.get('clock')?.temporal?.format, 'HH:mm:ss');
  assert.equal(time.definitions.get('clock')?.temporal?.kind, 'time');
});

test('the requested compact DATETIME creation syntax saves and inserts the named variable', async () => {
  const view = fixture('ad = DATETIME::sub(3M5m)');
  const before = captureTemporalValue(new Date(), 'datetime', 'YYYY-MM-DD HH:mm', '::sub(3M,5m)');
  await view.complete();
  const after = captureTemporalValue(new Date(), 'datetime', 'YYYY-MM-DD HH:mm', '::sub(3M,5m)');
  const saved = view.definitions.get('ad');
  assert.ok(saved?.temporal);
  assert.equal(saved.temporal.kind, 'datetime');
  assert.ok(Date.parse(saved.temporal.iso) >= Date.parse(before.iso));
  assert.ok(Date.parse(saved.temporal.iso) <= Date.parse(after.iso));
  assert.equal(view.text(), '{{ad}}');
});

test('malformed creation adjustments leave the original token unchanged without registry writes', async () => {
  for (const expression of ['due=DATE::add(1x)', 'due=DATE::add(', 'due=DATETIME::sub(1.5M)', 'due=DATE::upper()', 'due=DATETIME::sub(3M5x)', 'due=DATETIME::sub(3M5)']) {
    const view = fixture(expression);
    assert.equal(await view.complete(), true);
    assert.equal(view.text(), view.original);
    assert.equal(view.definitions.size, 0);
  }
});
