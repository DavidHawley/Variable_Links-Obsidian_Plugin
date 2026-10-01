import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { WorkspaceLeaf } from 'obsidian';
import type VariableLinksPlugin from '../src/main';
import type { VariablePropertiesView as PropertiesView } from '../src/panel';
import type { EditorDrafts } from '../src/editorDrafts';

// Stub only the host and minimal DOM surface needed by the real panel save code.
const bundle = await build({
  stdin: { contents: "export { VariablePropertiesView } from './src/panel';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', define: { window: 'globalThis' },
  plugins: [{ name: 'panel-test-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'panel-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'panel-host' }, () => ({ contents: `
      export class App {} export class Modal {} export class Notice {}
      export class TFile {} export class WorkspaceLeaf {} export class Menu {}
      export class MarkdownRenderChild {} export const MarkdownRenderer = {};
      export class ItemView { constructor(leaf) { this.app = leaf.app; this.containerEl = leaf.containerEl; } }
      export function setIcon() {} export const parseYaml = JSON.parse; export const stringifyYaml = JSON.stringify;
    ` }));
  } }],
});
// eslint-disable-next-line no-unsanitized/method -- Only this repository and the host stub above are bundled.
const { VariablePropertiesView } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as { VariablePropertiesView: typeof PropertiesView };

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  disabled = false;
  hidden = false;
  id = '';
  text = '';
  emptyCount = 0;
  constructor(readonly tag = 'div') {}
  empty(): void { this.children.length = 0; this.emptyCount++; }
  setText(text: string): void { this.text = text; }
  createEl(tag: string, options?: { text?: string }): ElementStub {
    const child = new ElementStub(tag); child.text = options?.text ?? ''; this.children.push(child); return child;
  }
  createDiv(): ElementStub { const child = new ElementStub(); this.children.push(child); return child; }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
  }
  dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => {} }); }
  querySelectorAll(selector: string): ElementStub[] {
    const tags = selector.split(',').map((tag) => tag.trim());
    return this.children.flatMap((child) => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

interface PanelInternals {
  active: boolean;
  selectedVariableName: string | null;
  creatingVariableType: string | null;
  creatingVariableName: string;
  panelContentEl: ElementStub;
  draftStatus: ElementStub;
  drafts: EditorDrafts<HTMLElement>;
  addSaveButton(form: HTMLElement, text: string, host: HTMLElement, save: () => Promise<void>): () => void;
}

function fixture() {
  const content = new ElementStub();
  const leaf = { app: {}, containerEl: content } as unknown as WorkspaceLeaf;
  const plugin = { registry: {} } as unknown as VariableLinksPlugin;
  const view = new VariablePropertiesView(leaf, plugin);
  const internals = view as unknown as PanelInternals;
  internals.active = true;
  internals.selectedVariableName = 'original';
  internals.panelContentEl = content;
  internals.draftStatus = new ElementStub();
  return { view, internals, content };
}

async function flushPromises(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('the actual properties panel preserves dirty forms across refresh and selection changes', async () => {
  const { view, internals, content } = fixture();
  const form = content.createEl('form');
  internals.drafts.markDirty(form as unknown as HTMLElement);
  await view.refresh();
  await view.selectVariable('other');
  await view.beginVariableCreation('fixed', 'new');
  assert.equal(content.emptyCount, 0);
  assert.equal(internals.selectedVariableName, 'original');
  assert.match(internals.draftStatus.text, /Unsaved edits are preserved/u);
});

test('the actual panel save freezes controls, rejects repeat submission, and preserves a failed draft', async () => {
  const { internals, content } = fixture();
  const form = content.createEl('form');
  const input = form.createEl('input');
  const host = content.createDiv();
  let rejectSave: (reason: Error) => void = () => {};
  let writes = 0;
  const markDirty = internals.addSaveButton(form as unknown as HTMLElement, 'Save properties', host as unknown as HTMLElement, () => {
    writes++;
    return new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  });
  markDirty(); form.dispatch('submit'); form.dispatch('submit');
  assert.equal(writes, 1);
  assert.equal(input.disabled, true);
  assert.equal(internals.drafts.isSaving, true);
  rejectSave(new Error('External edit'));
  await flushPromises();
  assert.equal(input.disabled, false);
  assert.equal(internals.drafts.isSaving, false);
  assert.equal(internals.drafts.hasPending, true);
  assert.match(internals.draftStatus.text, /Save failed/u);
  assert.equal(host.children[0].disabled, false);
});

test('saving one panel form retains another draft and Cancel explicitly discards remaining edits', async () => {
  const { internals, content } = fixture();
  const properties = content.createEl('form');
  const card = content.createEl('form');
  internals.drafts.markDirty(card as unknown as HTMLElement);
  const host = content.createDiv();
  const markDirty = internals.addSaveButton(properties as unknown as HTMLElement, 'Save properties', host as unknown as HTMLElement, async () => {});
  markDirty(); properties.dispatch('submit');
  await flushPromises();
  assert.equal(internals.drafts.hasPending, true);
  assert.equal(content.emptyCount, 0);
  assert.equal(host.children[0].disabled, true);
  internals.active = false; // A closed host must not attempt a DOM refresh.
  host.children[1].dispatch('click');
  assert.equal(internals.drafts.hasPending, false);
});

test('Cancel exits a prefilled creation instead of recreating its unsaved draft', () => {
  const { internals, content } = fixture();
  const form = content.createEl('form');
  const host = content.createDiv();
  const markDirty = internals.addSaveButton(form as unknown as HTMLElement, 'Add variable', host as unknown as HTMLElement, async () => {});
  internals.creatingVariableType = 'computed';
  internals.creatingVariableName = 'prefilled';
  markDirty();
  internals.active = false;
  host.children[1].dispatch('click');
  assert.equal(internals.creatingVariableType, null);
  assert.equal(internals.creatingVariableName, '');
  assert.equal(internals.selectedVariableName, '');
  assert.equal(internals.drafts.hasPending, false);
});
