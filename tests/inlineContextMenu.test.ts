import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { App, Editor, TFile } from 'obsidian';
import type VariableLinksPlugin from '../src/main';

// Exercise the real menu wiring while replacing unrelated plugin subsystems.
const source = readFileSync('src/main.ts', 'utf8');
const supportModules = new Map<string, string>();
for (const match of source.matchAll(/^import\s+([^;]+?)\s+from\s+['"](\.[^'"]+)['"];?/gmu)) {
  const names = match[1].match(/\{([^}]+)\}/u)?.[1].split(',')
    .map((name) => name.trim()).filter((name) => name && !name.startsWith('type ')) ?? [];
  supportModules.set(match[2], `export default class Stub {} ${names.map((name) => `export const ${name} = ${name === 'DEFAULT_SETTINGS' ? '{}' : 'function () {}'};`).join(' ')}`);
}
const bundle = await build({
  stdin: { contents: "export { default as PluginHost } from './src/main'; export { Menu as TestMenu, TFile as TestFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'menu-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'menu-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'menu-host' }, () => ({ contents: `
      export class Editor {} export class MarkdownView {} export class Notice {}
      export class TFile { constructor(path) { this.path = path; } } export class TFolder {} export class WorkspaceLeaf {}
      export class Plugin { constructor(app) { this.app = app; this.domEvents = new Map(); }
        registerDomEvent(_target, type, callback) { this.domEvents.set(type, callback); } registerEvent() {} }
      export class MenuItem { setTitle(title) { this.title = title; return this; }
        setIcon() { return this; } setDisabled(value) { this.disabled = value; return this; }
        onClick(callback) { this.click = callback; return this; } }
      export class Menu { static shown; constructor() { this.items = []; }
        addItem(callback) { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
        showAtMouseEvent() { Menu.shown = this; } }
    ` }));
    builder.onResolve({ filter: /^\./ }, (args) => {
      if (args.importer.endsWith('src/main.ts') || args.importer.endsWith('src\\main.ts')) return { path: args.path, namespace: 'menu-support' };
      return null;
    });
    builder.onLoad({ filter: /.*/, namespace: 'menu-support' }, (args) => ({ contents: supportModules.get(args.path) ?? 'export default class Stub {}' }));
  } }],
});
interface ItemStub { title: string; disabled: boolean; click?: () => void }
interface MenuStub { items: ItemStub[] }
// eslint-disable-next-line no-unsanitized/method -- Only the repository's menu wiring and explicit host stubs are bundled.
const { PluginHost, TestMenu, TestFile } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`,
) as { PluginHost: typeof VariableLinksPlugin; TestMenu: { new (): MenuStub; shown: MenuStub }; TestFile: new (path: string) => TFile };

interface MenuInternals {
  active: boolean;
  domEvents: Map<string, (event: unknown) => void>;
  registerVariableContextMenu(): void;
  getContextEditorPosition(): { line: number; ch: number };
  getContextVariableToken(): unknown;
  openInlineEditor(...args: unknown[]): void;
  openReadingInlineEditor(...args: unknown[]): Promise<void>;
}

test('inline expressions have a direct right-click conversion action in source editing and Reading View', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(global, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(global, 'Element');
  class ElementStub {
    dataset = { var: '=1 + 2', sourcePath: 'note.md' };
    closest(): ElementStub { return this; }
  }
  Object.defineProperty(global, 'document', { configurable: true, value: {} });
  Object.defineProperty(global, 'Element', { configurable: true, value: ElementStub });
  try {
    let editorMenu: ((menu: MenuStub, editor: Editor, info: { file: TFile }) => void) | undefined;
    const app = { workspace: { on: (_event: string, callback: typeof editorMenu) => { editorMenu = callback; return {}; } } } as unknown as App;
    const plugin = new PluginHost(app, { id: 'variable-links' } as VariableLinksPlugin['manifest']);
    plugin.registry = { getVariable: () => null, data: new Map() } as unknown as NonNullable<VariableLinksPlugin['registry']>;
    const internals = plugin as unknown as MenuInternals;
    const token = { name: '=1 + 2', from: { line: 0, ch: 0 }, to: { line: 0, ch: 10 }, syntax: { prefix: '{{', suffix: '}}' } };
    internals.active = true;
    internals.getContextEditorPosition = () => ({ line: 0, ch: 0 });
    internals.getContextVariableToken = () => token;
    const opened: unknown[][] = [];
    internals.openInlineEditor = (...args) => { opened.push(args); };
    internals.openReadingInlineEditor = async (...args) => { opened.push(args); };
    internals.registerVariableContextMenu();
    const menu = new TestMenu();
    const editor = { somethingSelected: () => false } as unknown as Editor;
    assert.ok(editorMenu);
    editorMenu(menu, editor, { file: new TestFile('note.md') });
    const action = menu.items.find((item) => item.title === 'Make into variable link');
    assert.ok(action?.click);
    assert.deepEqual(opened, []);
    action.click();
    assert.deepEqual(opened[0], [editor, token, 'note.md', true]);
    const target = new ElementStub();
    internals.domEvents.get('contextmenu')!({ target, clientX: 10, clientY: 20, preventDefault: () => {}, stopPropagation: () => {} });
    const readingAction = TestMenu.shown.items.find((item) => item.title === 'Make into variable link');
    assert.ok(readingAction?.click);
    readingAction.click();
    await Promise.resolve();
    assert.deepEqual(opened[1], ['=1 + 2', target]);
  } finally {
    if (oldDocument) Object.defineProperty(global, 'document', oldDocument);
    else Reflect.deleteProperty(global, 'document');
    if (oldElement) Object.defineProperty(global, 'Element', oldElement);
    else Reflect.deleteProperty(global, 'Element');
  }
});
