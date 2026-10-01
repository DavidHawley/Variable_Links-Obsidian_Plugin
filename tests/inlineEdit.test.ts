import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { Editor } from 'obsidian';
import type VariableLinksPlugin from '../src/main';
import type { InlineExpressionEditor as InlineEditor } from '../src/inlineEdit';
import type { InlinePromotionPlan } from '../src/registry';

const bundle = await build({
  stdin: { contents: "export { InlineExpressionEditor } from './src/inlineEdit';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'inline-editor-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'inline-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'inline-host' }, () => ({ contents: `
      export class Editor {} export class Notice {}
      export class Modal {
        constructor(app) { this.contentEl = app.createElement(); this.modalEl = app.createElement(); }
        setTitle() {} close() { this.onClose(); }
      }
    ` }));
  } }],
});
// eslint-disable-next-line no-unsanitized/method -- Only repository code and the host stub above are bundled.
const { InlineExpressionEditor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as { InlineExpressionEditor: typeof InlineEditor };

interface EventStub { key?: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void }
class ElementStub {
  readonly children: ElementStub[] = [];
  readonly listeners = new Map<string, ((event: EventStub) => void)[]>();
  value = '';
  text = '';
  placeholder = '';
  disabled = false;
  isConnected = true;
  constructor(readonly tag = 'div') {}
  addClass(): void {}
  focus(): void {}
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

function fixture(expression = '1 + 2', prefix = '{{', suffix = '}}', taken: string[] = [], shortcuts: string[] = []) {
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
  const modal = new InlineExpressionEditor(plugin, editor, { line: 0, ch: 0 }, { line: 0, ch: note.length }, note, expression, 'invoice.md', { prefix, suffix });
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
