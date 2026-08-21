declare module 'obsidian' {
  export class Plugin {
    app: any;
    async loadData(): Promise<any>;
    async saveData(data: any): Promise<void>;
    addSettingTab(tab: any): void;
    registerMarkdownPostProcessor?(fn: (el: HTMLElement, ctx: any) => Promise<void> | void): any;
    registerEditorSuggest?(s: any): void;
    registerEditorExtension?(extension: any): void;
  }
  export interface App {
    vault: any;
    workspace: any;
    metadataCache: any;
  }
  export class PluginSettingTab {
    constructor(app: App, plugin: Plugin);
    display(): void;
  }
  export class Setting {
    constructor(container: HTMLElement);
    setName(n: string): Setting;
    setDesc(d: string): Setting;
    addText(cb: any): Setting;
    addToggle(cb: any): Setting;
    addButton(cb: any): Setting;
  }
  export class Notice { constructor(msg: string); }
  export class ItemView {
    app: App;
    containerEl: HTMLElement & {
      empty(): void;
      addClass(className: string): void;
      createDiv(className?: string): HTMLElement;
    };
    constructor(leaf: any);
  }
  export class TFile { path: string; }
  export function parseYaml(yml: string): any;
  export function stringifyYaml(value: any): string;
  export class FuzzySuggestModal<T> { constructor(app: App); setPlaceholder(s: string): void; getItems(): T[]; getItemText(t: T): string; open(): void; close(): void; }
  export const MarkdownRenderer: any;
  export class EditorSuggest<T> {
    context: any;
    constructor(app: App);
  }
  export const MarkdownPostProcessorContext: any;
  export const MarkdownRenderChild: any;
}
