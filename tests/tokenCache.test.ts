import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { App, Plugin } from 'obsidian';
import type Registry from '../src/registry';
import type { VariableDefinition } from '../src/registry';
import type TokenCacheType from '../src/tokenCache';
import type { TokenSyntax } from '../src/tokenSyntax';

const bundle = await build({
  stdin: { contents: "export { default as TokenCache } from './src/tokenCache'; export { TFile as TestFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', define: { window: 'globalThis' },
  plugins: [{ name: 'cache-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'cache-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'cache-host' }, () => ({ contents: `
      export class App {} export class Plugin {} export class Modal {} export class Notice {}
      export class TAbstractFile {} export class TFile extends TAbstractFile {
        constructor(path, content) { super(); this.path = path; this.stat = { mtime: 1, size: content.length }; }
      }
      export const parseYaml = JSON.parse; export const stringifyYaml = JSON.stringify;
    ` }));
  } }],
});
// eslint-disable-next-line no-unsanitized/method -- Only repository code and the test host above are bundled.
const { TokenCache, TestFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as {
  TokenCache: typeof TokenCacheType;
  TestFile: new (path: string, content: string) => { path: string; stat: { mtime: number; size: number } };
};

async function fixture(notes: Record<string, string>, definitions: Record<string, VariableDefinition> = {}, syntax: TokenSyntax = { prefix: '{{', suffix: '}}' }, legacy: TokenSyntax[] = []) {
  const contents = new Map(Object.entries(notes));
  const files = new Map(Object.entries(notes).map(([path, content]) => [path, new TestFile(path, content)]));
  const data = new Map(Object.entries(definitions));
  const registry = {
    data,
    plugin: { settings: { tokenPrefix: syntax.prefix, tokenSuffix: syntax.suffix, legacyTokenSyntaxes: legacy } },
    getVariable: (name: string) => data.get(name) ?? null,
  } as unknown as Registry;
  const adapterContents = new Map<string, string>();
  const app = { vault: {
    configDir: '.test-config',
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: async (file: { path: string }) => contents.get(file.path)!,
    process: async (file: { path: string }, update: (current: string) => string) => {
      const next = update(contents.get(file.path)!); contents.set(file.path, next);
      const entry = files.get(file.path)!; entry.stat.mtime++; entry.stat.size = next.length;
    },
    adapter: {
      exists: async (path: string) => adapterContents.has(path),
      read: async (path: string) => adapterContents.get(path),
      write: async (path: string, content: string) => { adapterContents.set(path, content); },
      mkdir: async () => {},
    },
  } } as unknown as App;
  const plugin = { manifest: { id: 'variable-links' } } as unknown as Plugin;
  const cache = new TokenCache(app, plugin, registry);
  await cache.rebuild();
  return { cache, data, text: (path: string) => contents.get(path), externalEdit: (path: string, text: string) => { contents.set(path, text); } };
}

test('Reading View conversion locates inline occurrences without choosing literal code or frontmatter examples', async () => {
  const content = ['---', 'sample: "{{=1 + 2}}"', '---', '{{=1 + 2}} {{=1 + 2}}', '`{{=1 + 2}}`', '```', '{{=1 + 2}}', '```', '<!-- {{=1 + 2}} -->'].join('\n');
  const { cache } = await fixture({ 'note.md': content });
  const matches = cache.getInlineExpressionOccurrences(content, '=1 + 2');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].line, 4);
  assert.equal(matches[1].line, 4);
  assert.notEqual(matches[0].start, matches[1].start);
  assert.equal(content.slice(matches[1].start, matches[1].end), '{{=1 + 2}}');
  assert.deepEqual(cache.getInlineExpressionOccurrences(content, 'ordinary'), []);
});

test('renames update direct and inline references, preserving selectors, delimiters, and protected Markdown', async () => {
  const source = [
    '---', 'literal: "{{= @price * 2 }}"', '---',
    '{{price}} {{=round(@price * var("price") + @priceExtra, 2)}}',
    '{{=sum(@prices::index(2), @price)}}', '<<= @price + 1 >>',
    '`{{=@price + 1}}`', '```text', '{{=@price + 1}}', '```',
    '<!-- {{=@price + 1}} -->', '$ {{=@price + 1}} $',
  ].join('\n');
  const host = await fixture({ 'note.md': source }, {
    price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' },
    prices: { guid: 'ps', type: 'fixed', file: '', property: '', shape: 'list', fixedItems: [{ id: 'i', value: '4' }] },
  }, { prefix: '{{', suffix: '}}' }, [{ prefix: '<<', suffix: '>>' }]);
  const plan = await host.cache.prepareRename('p', 'price', 'Unit price');
  assert.equal(plan.fileCount, 1); assert.equal(plan.tokenCount, 4);
  await plan.apply();
  const updated = host.text('note.md')!;
  assert.match(updated, /\{\{Unit price\}\}/u);
  assert.ok(updated.includes('round(var("Unit price") * var("Unit price") + @priceExtra, 2)'));
  assert.ok(updated.includes('sum(@prices::index(2), var("Unit price"))'));
  assert.ok(updated.includes('<<= var("Unit price") + 1 >>') || updated.includes('<<= var("Unit price") + 1>>'));
  assert.ok(updated.includes('literal: "{{= @price * 2 }}"'));
  assert.ok(updated.includes('`{{=@price + 1}}`'));
  assert.ok(updated.includes('```text\n{{=@price + 1}}\n```'));
  assert.ok(updated.includes('<!-- {{=@price + 1}} -->'));
  assert.ok(updated.includes('$ {{=@price + 1}} $'));
  await plan.rollback(); assert.equal(host.text('note.md'), source);
  host.cache.stop();
});

test('rename plans reject a stale note and roll back previously updated notes', async () => {
  const host = await fixture({ 'first.md': '{{=@price + 1}}', 'second.md': '{{price}}' }, { price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' } });
  const plan = await host.cache.prepareRename('p', 'price', 'cost');
  host.externalEdit('second.md', '{{price}} external edit');
  await assert.rejects(plan.apply(), /changed after the rename preview/u);
  assert.equal(host.text('first.md'), '{{=@price + 1}}');
  assert.equal(host.text('second.md'), '{{price}} external edit');
  host.cache.stop();
});

test('syntax migration includes note-local and invalid inline calculations without touching literal samples', async () => {
  const source = '{{=@price * 2}}\n{{=1 / 0}}\n{{=1 + )}}\n`{{=@price * 2}}`\n```text\n{{=1 / 0}}\n```\n{{unregistered}}';
  const host = await fixture({ 'local-only.md': source });
  const plan = await host.cache.prepareSyntaxMigration({ prefix: '{{', suffix: '}}' }, { prefix: '<<', suffix: '>>' });
  assert.equal(plan.fileCount, 1); assert.equal(plan.tokenCount, 3);
  await plan.apply();
  assert.equal(host.text('local-only.md'), '<<=@price * 2>>\n<<=1 / 0>>\n<<=1 + )>>\n`{{=@price * 2}}`\n```text\n{{=1 / 0}}\n```\n{{unregistered}}');
  await plan.rollback(); assert.equal(host.text('local-only.md'), source);
  host.cache.stop();
});

test('migration rejects delimiters occurring inside an expression before writing any notes', async () => {
  const source = '{{=var("price>>net") * 2}}';
  const host = await fixture({ 'local.md': source, 'other.md': '{{=1 + 2}}' });
  await assert.rejects(host.cache.prepareSyntaxMigration({ prefix: '{{', suffix: '}}' }, { prefix: '<<', suffix: '>>' }), /cannot use the proposed delimiters/u);
  assert.equal(host.text('local.md'), source);
  assert.equal(host.text('other.md'), '{{=1 + 2}}');
  host.cache.stop();
});

test('value replacement leaves calculations intact rather than replacing one dependency with its full value', async () => {
  const host = await fixture({ 'note.md': '{{price}} and {{=@price * 2}}' }, { price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' } });
  const plan = await host.cache.prepareValueReplacement(new Map([['price', { value: '2' }]]));
  assert.equal(plan.tokenCount, 1);
  await plan.apply();
  assert.equal(host.text('note.md'), '2 and {{=@price * 2}}');
  await plan.rollback();
  assert.equal(host.text('note.md'), '{{price}} and {{=@price * 2}}');
  host.cache.stop();
});

test('bulk impact counts an inline token once even when several selected inputs occur in it', async () => {
  const host = await fixture({ 'note.md': '{{=@price * @qty}} and {{price}}' }, {
    price: { guid: 'p', type: 'fixed', file: '', property: '', value: '2' },
    qty: { guid: 'q', type: 'fixed', file: '', property: '', value: '3' },
  });
  assert.deepEqual(await host.cache.getGuidLocationImpact(['p', 'q', 'p']), { fileCount: 1, tokenCount: 2 });
  host.cache.stop();
});
