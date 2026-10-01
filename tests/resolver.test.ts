import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { App } from 'obsidian';
import type Registry from '../src/registry';
import type { VariableDefinition } from '../src/registry';
import type { Resolver as ResolverType } from '../src/resolver';
import type VariableLinksPlugin from '../src/main';
import type { VariableShortcut } from '../src/shortcuts';

// Exercise the real resolver/registry modules with only Obsidian's host API stubbed.
const bundle = await build({
  stdin: { contents: "export { Resolver } from './src/resolver'; export { Registry as RegistryHost } from './src/registry'; export { TFile as TestFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  define: { window: 'globalThis' },
  plugins: [{ name: 'obsidian-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents: `
      export class App {} export class Modal {} export class Notice {}
      export class TFile { constructor(path) { this.path = path; } }
      export const parseYaml = JSON.parse; export const stringifyYaml = JSON.stringify;
    ` }));
  } }],
});
// The import source is bundled exclusively from this repository and the test stub above.
// eslint-disable-next-line no-unsanitized/method -- Only locally bundled test code is imported.
const { Resolver, RegistryHost, TestFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as { Resolver: typeof ResolverType; RegistryHost: typeof Registry; TestFile: new (path: string) => { path: string } };

function fixture(definitions: Record<string, VariableDefinition>, notes: Record<string, Record<string, unknown>> = {}, shortcuts: VariableShortcut[] = []) {
  const data = new Map(Object.entries(definitions));
  const registry = {
    getVariable: (name: string) => data.get(name) ?? null,
    getVariableByGuid: (guid: string) => {
      const entry = [...data].find(([, definition]) => definition.guid === guid);
      return entry ? { name: entry[0], definition: entry[1] } : null;
    },
    getVariableNameByGuid: (guid: string) => [...data].find(([, def]) => def.guid === guid)?.[0] ?? null,
    getShortcutByCode: (code: string) => shortcuts.find((shortcut) => shortcut.enabled && shortcut.code.toLocaleLowerCase() === code.toLocaleLowerCase()) ?? null,
  } as unknown as Registry;
  const app = { metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: notes[file.path] }) }, vault: {
    getFileByPath: (path: string) => path in notes ? new TestFile(path) : null,
    read: async (file: { path: string }) => `---\n${JSON.stringify(notes[file.path])}\n---\n`,
  } } as unknown as App;
  return new Resolver(app, registry);
}

test('inline math binds note properties and gives existing Variable Links priority', async () => {
  const resolver = fixture({}, { 'invoice.md': { price: '0.12', qty: '5968', tax: '0.07' } });
  assert.equal((await resolver.resolve('=round(@price * @qty * (1 + var("tax")), 2)', undefined, 'invoice.md')).value, 766.29);
  const global = fixture({ price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' } }, { 'invoice.md': { price: 100 } });
  assert.equal((await global.resolve('=@price + 1', undefined, 'invoice.md')).value, 3);
});

test('exact variables and saved GUIDs take priority over same-code shortcuts', async () => {
  const shortcuts: VariableShortcut[] = [{ id: 's', code: 'price', enabled: true, targetGuid: 'list', searchTerms: [], selector: { steps: [{ type: 'index', index: 2 }] } }];
  const resolver = fixture({
    price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' },
    list: { guid: 'list', type: 'fixed', shape: 'list', file: '', property: '', fixedItems: [{ id: 'a', value: '4' }, { id: 'b', value: '7' }] },
  }, {}, shortcuts);
  assert.equal((await resolver.resolveInline('@price + 1')).value, 3);
  assert.equal((await resolver.previewComputed('@price + 1')).value, 3);
  assert.equal((await resolver.previewComputed('@price + 1', [{ name: 'price', guid: 'p' }])).value, 3);
  assert.equal((await resolver.previewComputed('@price + 1', [{ name: 'price', guid: 'deleted' }])).ok, false);
  const alias = fixture({ list: { guid: 'list', type: 'fixed', shape: 'list', file: '', property: '', fixedItems: [{ id: 'a', value: '4' }, { id: 'b', value: '7' }] } }, {}, shortcuts);
  assert.equal((await alias.resolveInline('@price + 1')).value, 8);
  assert.equal((await alias.previewComputed('@price + 1')).value, 8);
  const missing = fixture({}, { 'local.md': { price: 9 } }, shortcuts);
  assert.match((await missing.resolveInline('@price + 1', 'local.md')).error ?? '', /missing target/u);
});

async function registryFixture(definitions: Record<string, VariableDefinition>, notes: Record<string, Record<string, unknown>>, shortcuts: Record<string, unknown>[] = []) {
  let content = JSON.stringify({ 'variable-links': definitions, shortcuts });
  let writes = 0;
  const app = { metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: notes[file.path] }) }, vault: {
    getAbstractFileByPath: () => null,
    getFileByPath: (path: string) => path in notes ? new TestFile(path) : null,
    read: async (file: { path: string }) => `---\n${JSON.stringify(notes[file.path])}\n---\n`,
    on: () => ({}), offref: () => {},
    adapter: { exists: async () => true, read: async () => content, write: async (_path: string, next: string) => { content = next; writes++; } },
  } } as unknown as App;
  const plugin = { settings: { registryFilePath: 'registry.json', tokenPrefix: '{{', tokenSuffix: '}}' }, refreshManagementCenterViews: async () => {} } as unknown as VariableLinksPlugin;
  const registry = new RegistryHost(app, plugin);
  const resolver = new Resolver(app, registry);
  plugin.resolver = resolver;
  await registry.load();
  return {
    registry, resolver, writes: () => writes,
    document: () => JSON.parse(content) as { 'variable-links': Record<string, VariableDefinition>; shortcuts: Record<string, unknown>[] },
    externalEdit: (change: (document: { 'variable-links': Record<string, VariableDefinition>; shortcuts: Record<string, unknown>[] }) => void) => {
      const document = JSON.parse(content) as { 'variable-links': Record<string, VariableDefinition>; shortcuts: Record<string, unknown>[] };
      change(document); content = JSON.stringify(document);
    },
  };
}

test('promotion review does not write, then creates all reviewed local bindings atomically', async (context) => {
  const host = await registryFixture({}, { 'invoice.md': { price: 2, qty: 3 } });
  context.after(() => host.registry.unload());
  const plan = await host.registry.prepareInlinePromotion('total', '@price * @qty + @price', 'invoice.md');
  assert.deepEqual(plan.additions.map((entry) => entry.name), ['price', 'qty']);
  assert.equal(host.writes(), 0);
  await host.registry.promoteInlineExpression(plan);
  assert.equal(host.writes(), 1);
  assert.equal((await host.resolver.resolve('total')).value, 8);
  assert.equal(host.document()['variable-links'].price.file, '[[invoice]]');
  await host.registry.load();
  assert.equal((await host.resolver.resolve('total')).value, 8);
});

test('promotion preserves shortcut selectors without creating misleading property links', async (context) => {
  const host = await registryFixture({ list: { guid: 'l', type: 'fixed', shape: 'list', file: '', property: '', fixedItems: [{ id: 'a', value: '4' }, { id: 'b', value: '7' }] } }, { 'note.md': { selected: 100 } }, [{ id: 's', code: 'selected', targetGuid: 'l', enabled: true, selector: '::index(2)' }]);
  context.after(() => host.registry.unload());
  const plan = await host.registry.prepareInlinePromotion('total', '@selected + 1', 'note.md');
  assert.equal(plan.additions.length, 0);
  await host.registry.promoteInlineExpression(plan);
  assert.equal(host.registry.getVariable('selected'), null);
  assert.equal((await host.resolver.resolve('total')).value, 8);
});

test('promotion rejects changed reviewed bindings without partial registry writes', async (context) => {
  const definition: VariableDefinition = { guid: 'p', type: 'fixed', file: '', property: '', value: '2' };
  const host = await registryFixture({ price: definition }, { 'note.md': { qty: 3 } });
  context.after(() => host.registry.unload());
  const plan = await host.registry.prepareInlinePromotion('total', '@price * @qty', 'note.md');
  host.externalEdit((document) => { delete document['variable-links'].price; });
  await assert.rejects(host.registry.promoteInlineExpression(plan), /changed after the review/u);
  assert.equal(host.writes(), 0);
  assert.equal(host.document()['variable-links'].qty, undefined);
  assert.equal(host.document()['variable-links'].total, undefined);
});

test('promotion rejects a shortcut changed after review and a new colliding local binding', async (context) => {
  const host = await registryFixture({ price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' } }, { 'note.md': { qty: 3 } }, [{ id: 's', code: 'alias', targetGuid: 'p', enabled: true }]);
  context.after(() => host.registry.unload());
  const plan = await host.registry.prepareInlinePromotion('total', '@alias * @qty', 'note.md');
  host.externalEdit((document) => { document.shortcuts[0].enabled = false; });
  await assert.rejects(host.registry.promoteInlineExpression(plan), /Shortcut.*changed/u);
  host.externalEdit((document) => { document.shortcuts[0].enabled = true; document['variable-links'].qty = { guid: 'q', type: 'fixed', file: '', property: '', value: '100' }; });
  await assert.rejects(host.registry.promoteInlineExpression(plan), /created elsewhere/u);
  assert.equal(host.writes(), 0);
});

test('multi-edit validates every snapshot before writing and preserves unrelated fields', async (context) => {
  const definitions: Record<string, VariableDefinition> = {
    one: { guid: '1', type: 'fixed', file: '', property: '', value: 'keep', favorite: false },
    two: { guid: '2', type: 'fixed', file: '', property: '', value: 'also keep', favorite: false },
  };
  const host = await registryFixture(definitions, {});
  context.after(() => host.registry.unload());
  const snapshots = Object.entries(definitions).map(([name, definition]) => ({ name, definition }));
  host.externalEdit((document) => { document['variable-links'].two.favorite = true; });
  await assert.rejects(host.registry.updateVariableFlags(snapshots, { favorite: true }), /changed after the preview/u);
  assert.equal(host.writes(), 0);
  assert.equal(host.document()['variable-links'].one.favorite, false);
  await host.registry.updateVariableFlags(snapshots, { hidden: true, linkEnabled: false });
  assert.equal(host.writes(), 1);
  assert.equal(host.registry.getVariable('one')?.value, 'keep');
  assert.equal(host.registry.getVariable('two')?.favorite, true);
  assert.equal(host.registry.getVariable('two')?.hidden, true);
});

test('editor saves detect external registry edits even before the registry watcher reloads', async (context) => {
  const host = await registryFixture({ price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' } }, {});
  context.after(() => host.registry.unload());
  const original = host.registry.getVariable('price')!;
  host.externalEdit((document) => { document['variable-links'].price.value = '100'; });
  await assert.rejects(host.registry.saveVariable('price', { ...original, display: 'Price' }, 'price', original), /changed while editing/u);
  assert.equal(host.writes(), 0);
  assert.equal(host.document()['variable-links'].price.value, '100');
  await host.registry.load();
  const refreshed = host.registry.getVariable('price')!;
  await host.registry.saveVariable('price', { ...refreshed, display: 'Price' }, 'price', refreshed);
  assert.equal(host.registry.getVariable('price')?.value, '100');
  assert.equal(host.registry.getVariable('price')?.display, 'Price');
});

test('saving a computed variable never silently rebinds a deleted input to a new same-name variable', async (context) => {
  const host = await registryFixture({
    price: { guid: 'replacement', type: 'fixed', file: '', property: '', value: '100' },
    total: { guid: 't', type: 'computed', file: '', property: '', expression: '@price * 2', dependencies: [{ name: 'price', guid: 'deleted-original' }] },
  }, {});
  context.after(() => host.registry.unload());
  assert.equal((await host.resolver.resolve('total')).ok, false);
  const original = host.registry.getVariable('total')!;
  await host.registry.saveVariable('total', { ...original, display: 'Total' }, 'total', original);
  assert.equal(host.registry.getVariable('total')?.dependencies?.[0].guid, 'deleted-original');
  assert.match((await host.resolver.resolve('total')).error ?? '', /no longer exists/u);
});

test('property inputs refresh and temporal properties apply arithmetic from raw ISO values', async () => {
  const notes = { 'item.md': { price: 4, due: '2024-01-31' } };
  const resolver = fixture({
    price: { guid: 'p', type: 'property', file: 'item.md', property: 'price' },
    total: { guid: 't', type: 'computed', file: '', property: '', expression: '@price * 2', dependencies: [{ name: 'price', guid: 'p' }] },
    due: { guid: 'd', type: 'property', file: 'item.md', property: 'due', temporal: { kind: 'date', iso: '2000-01-01T00:00:00.000Z', format: 'YYYY-MM-DD' } },
  }, notes);
  assert.equal((await resolver.resolve('total')).value, 8);
  notes['item.md'].price = 6;
  assert.equal((await resolver.resolve('total')).value, 12);
  assert.equal((await resolver.resolve('due', { steps: [{ type: 'add', parts: [{ unit: 'M', amount: 1 }] }] })).value, '2024-02-29');
  notes['item.md'].due = '2024-02-31';
  assert.equal((await resolver.resolve('due')).ok, false);
});

test('inline evaluation supports list selection, missing inputs and zero division errors', async () => {
  const resolver = fixture({}, { 'list.md': { values: [2, 4] } });
  assert.equal((await resolver.resolve('=@values::index(2) * 2', undefined, 'list.md')).value, 8);
  assert.match((await resolver.resolve('=@missing + 1', undefined, 'list.md')).error ?? '', /not found/u);
  assert.match((await resolver.resolve('=1 / 0')).error ?? '', /divide by zero/u);
});

test('saved GUID dependencies survive renames and detect cycles and deleted inputs', async () => {
  const resolver = fixture({
    renamed: { guid: 'p', type: 'fixed', file: '', property: '', value: '5' },
    total: { guid: 't', type: 'computed', file: '', property: '', expression: '@oldName * 2', dependencies: [{ name: 'oldName', guid: 'p' }] },
    cycle: { guid: 'c', type: 'computed', file: '', property: '', expression: '@cycle', dependencies: [{ name: 'cycle', guid: 'c' }] },
    deleted: { guid: 'd', type: 'computed', file: '', property: '', expression: '@gone', dependencies: [{ name: 'gone', guid: 'missing' }] },
  });
  assert.equal((await resolver.resolve('total')).value, 10);
  assert.match((await resolver.resolve('cycle')).error ?? '', /Circular/u);
  assert.match((await resolver.resolve('deleted')).error ?? '', /no longer exists/u);
});

test('indirect cycles fail and a dependency chain cannot exceed the documented 32-variable limit', async () => {
  const definitions: Record<string, VariableDefinition> = {
    first: { guid: 'first', type: 'computed', file: '', property: '', expression: '@second', dependencies: [{ name: 'second', guid: 'second' }] },
    second: { guid: 'second', type: 'computed', file: '', property: '', expression: '@first', dependencies: [{ name: 'first', guid: 'first' }] },
    base: { guid: 'base', type: 'fixed', file: '', property: '', value: '1', hidden: true },
  };
  for (let index = 0; index < 33; index++) {
    const input = index === 0 ? 'base' : `level${index - 1}`;
    definitions[`level${index}`] = { guid: `level${index}`, type: 'computed', file: '', property: '', expression: `@${input} + 1`, dependencies: [{ name: input, guid: input }] };
  }
  const resolver = fixture(definitions);
  assert.match((await resolver.resolve('first')).error ?? '', /Circular computed dependency/u);
  assert.equal((await resolver.resolve('level31')).value, 33);
  assert.match((await resolver.resolve('level32')).error ?? '', /depth exceeds 32/u);
  assert.equal((await resolver.resolveInline('@base * 2')).value, 2);
});
