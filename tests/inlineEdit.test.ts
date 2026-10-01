import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { App, Editor, TFile } from 'obsidian';
import type VariableLinksPlugin from '../src/main';
import type { InlineExpressionEditor as InlineEditor } from '../src/inlineEdit';
import type { InlineExpressionTarget } from '../src/inlineEdit';
import type { InlinePromotionPlan } from '../src/registry';

const bundle = await build({
  stdin: { contents: "export { InlineExpressionEditor, editorExpressionTarget, readingExpressionTarget } from './src/inlineEdit'; export { TFile as TestFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'inline-editor-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'inline-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'inline-host' }, () => ({ contents: `
      export class Editor {} export class Notice {}
      export class TFile { constructor(path) { this.path = path; } }
      export class Modal {
        constructor(app) { this.contentEl = app.createElement(); this.modalEl = app.createElement(); }
        setTitle() {} close() { this.onClose(); }
      }
    ` }));
  } }],
});
// eslint-disable-next-line no-unsanitized/method -- Only repository code and the host stub above are bundled.
const { InlineExpressionEditor, editorExpressionTarget, readingExpressionTarget, TestFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as typeof import('../src/inlineEdit') & { TestFile: new (path: string) => TFile };

interface EventStub { key?: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void }
class ElementStub {
  readonly children: ElementStub[] = [];
  readonly listeners = new Map<string, ((event: EventStub) => void)[]>();
  value = '';
  text = '';
  placeholder = '';
  disabled = false;
  isConnected = true;
  focused = false;
  constructor(readonly tag = 'div') {}
  addClass(): void {}
  focus(): void { this.focused = true; }
  empty(): void { this.children.length = 0; this.text = ''; }
  setText(text: string): void { this.text = text; }
  private createChild(tag: string, options?: { text?: string }): ElementStub {
    const child = new ElementStub(tag); child.text = options?.text ?? ''; this.children.push(child); return child;
  }
  createEl(tag: string, options?: { text?: string }): ElementStub { return this.createChild(tag, options); }
  createDiv(options?: { text?: string }): ElementStub { return this.createChild('div', options); }
  createSpan(options?: { text?: string }): ElementStub { return this.createChild('span', options); }
  addEventListener(type: string, callback: (event: EventStub) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
  }
  dispatch(type: string, event: Partial<EventStub> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => {}, ...event });
  }
  querySelectorAll(selector: string): ElementStub[] {
    const tags = selector.split(',').map((tag) => tag.trim());
    return this.children.flatMap((child) => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

function fixture(expression = '1 + 2', prefix = '{{', suffix = '}}', taken: string[] = [], shortcuts: string[] = [], targetOverride?: InlineExpressionTarget, promotionMode = false) {
  const names = new Set(taken);
  const reviewed: string[] = [];
  const created: string[] = [];
  let note = `${prefix}=${expression}${suffix}`;
  const plugin = {
    app: { createElement: () => new ElementStub() },
    settings: { tokenPrefix: prefix, tokenSuffix: suffix },
    trackDialog: () => {}, releaseDialog: () => {},
    resolver: { resolveInline: async () => ({ ok: true, value: 3 }) },
    registry: {
      getVariable: (name: string) => names.has(name) ? {} : null,
      getShortcutByCode: (name: string) => shortcuts.includes(name) ? {} : null,
      prepareInlinePromotion: async (name: string, value: string, sourcePath: string): Promise<InlinePromotionPlan> => {
        reviewed.push(name.trim());
        return { name: name.trim(), expression: value, sourcePath, additions: [], inputs: [] };
      },
      promoteInlineExpression: async (plan: InlinePromotionPlan): Promise<void> => { created.push(plan.name); },
    },
  } as unknown as VariableLinksPlugin;
  const editor = { getRange: () => note, replaceRange: (text: string) => { note = text; }, focus: () => {} } as unknown as Editor;
  const target = targetOverride ?? editorExpressionTarget(editor, { line: 0, ch: 0 }, { line: 0, ch: note.length }, 'invoice.md', { prefix, suffix });
  const modal: InlineEditor = new InlineExpressionEditor(plugin, target, expression, promotionMode);
  modal.onOpen();
  const content = modal.contentEl as unknown as ElementStub;
  const name = content.querySelectorAll('input')[0];
  const input = content.querySelectorAll('textarea')[0];
  const button = (text: string) => content.querySelectorAll('button').find((entry) => entry.text === text)!;
  return { modal, name, input, button, reviewed, created, names, getNote: () => note };
}

async function flushPromises(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('the inline editor suggests an unused name but requires explicit review and creation', async () => {
  const view = fixture('@math_03 + 1', '{{', '}}', ['math_01'], ['math_02']);
  assert.equal(view.name.value, 'math_04');
  assert.deepEqual(view.reviewed, []);
  const create = view.button('Create reviewed variable and property links');
  assert.equal(create.disabled, true);
  create.dispatch('click');
  assert.deepEqual(view.created, []);
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  assert.deepEqual(view.reviewed, ['math_04']);
  assert.deepEqual(view.created, []);
  assert.equal(view.getNote(), '{{=@math_03 + 1}}');
  assert.equal(create.disabled, false);
  create.dispatch('click');
  await flushPromises();
  assert.deepEqual(view.created, ['math_04']);
  assert.equal(view.getNote(), '{{math_04}}');
});

test('a cleared name is suggested again and manually entered names remain unchanged', async () => {
  const view = fixture();
  view.names.add('math_01');
  view.name.value = '   '; view.name.dispatch('input');
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  assert.equal(view.name.value, 'math_02');
  view.name.value = 'my_total'; view.name.dispatch('input');
  assert.equal(view.button('Create reviewed variable and property links').disabled, true);
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  assert.equal(view.name.value, 'my_total');
  assert.deepEqual(view.reviewed, ['math_02', 'my_total']);
  assert.deepEqual(view.created, []);
  view.button('Cancel').dispatch('click');
  assert.deepEqual(view.created, []);
});

test('auto-name suggestions are refreshed when inputs or existing names change before review', async () => {
  const view = fixture();
  view.names.add('math_01');
  view.input.value = '@math_02 + 1'; view.input.dispatch('input');
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  assert.equal(view.name.value, 'math_03');
  assert.deepEqual(view.created, []);
});

test('saving inline with Ctrl/Cmd+Enter never creates the suggested permanent variable', async () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const view = fixture();
    view.input.value = '2 + 3';
    view.input.dispatch('keydown', { key: 'Enter', ...modifier });
    await flushPromises();
    assert.equal(view.getNote(), '{{=2 + 3}}');
    assert.deepEqual(view.reviewed, []);
    assert.deepEqual(view.created, []);
  }
});

test('auto-naming respects custom delimiters and unfinished expressions still open safely', () => {
  const view = fixture('1 +', '_', ']');
  assert.equal(view.name.value, 'math01');
  assert.deepEqual(view.created, []);
  view.button('Cancel').dispatch('click');
});

test('the make-into-variable-link entry point focuses the name without automatically reviewing or creating', () => {
  const view = fixture('1 + 2', '{{', '}}', [], [], undefined, true);
  assert.equal(view.name.focused, true);
  assert.equal(view.input.focused, false);
  assert.deepEqual(view.reviewed, []);
  assert.deepEqual(view.created, []);
});

test('Reading View replaces only the chosen expression and rejects concurrent source edits', async () => {
  const original = 'First {{=1 + 2}}, second {{=1 + 2}}.';
  let current = original;
  const app = { vault: {
    read: async () => current,
    process: async (_file: TFile, update: (text: string) => string) => { current = update(current); },
  } } as unknown as App;
  const start = original.lastIndexOf('{{=');
  const target = readingExpressionTarget(app, new TestFile('invoice.md'), original, start, start + '{{=1 + 2}}'.length, { prefix: '{{', suffix: '}}' });
  const view = fixture('1 + 2', '{{', '}}', [], [], target, true);
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  assert.equal(current, original);
  assert.deepEqual(view.created, []);
  view.button('Create reviewed variable and property links').dispatch('click');
  await flushPromises();
  assert.deepEqual(view.created, ['math_01']);
  assert.equal(current, 'First {{=1 + 2}}, second {{math_01}}.');
  current = `Changed ${original}`;
  assert.equal(await target.isCurrent(), false);
  await assert.rejects(async () => target.replace('{{other}}'), /note changed/u);
  assert.equal(current, `Changed ${original}`);
});

test('an asynchronous stale-note check prevents permanent creation and repeated submissions', async () => {
  let finishCheck: (current: boolean) => void = () => {};
  const view = fixture('1 + 2', '{{', '}}', [], [], {
    sourcePath: 'invoice.md', syntax: { prefix: '{{', suffix: '}}' },
    isCurrent: () => new Promise<boolean>((resolve) => { finishCheck = resolve; }),
    replace: () => { throw new Error('Must not replace a stale note'); }, focus: () => {},
  }, true);
  view.button('Review permanent creation').dispatch('click');
  await flushPromises();
  const create = view.button('Create reviewed variable and property links');
  create.dispatch('click'); create.dispatch('click');
  assert.equal(view.name.disabled, true);
  finishCheck(false);
  await flushPromises();
  assert.deepEqual(view.created, []);
  assert.equal(create.disabled, true);
  assert.equal(view.name.disabled, false);
});
