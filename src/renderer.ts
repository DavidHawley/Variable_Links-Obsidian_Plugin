import { App, MarkdownView } from 'obsidian';
import Registry from './registry';
import Resolver from './resolver';
import Indexer from './indexer';
import InfoCard from './card';

const TOKEN_REGEX = /\{\{\s*([^}\s]+)\s*}}/g;

interface PreviewMode {
  rerender?: (force: boolean) => void;
  renderer?: { rerender?: (force: boolean) => void };
}

export class Renderer {
  app: App;
  registry: Registry;
  resolver: Resolver;
  indexer: Indexer;
  enabled: boolean = true;
  infoCard: InfoCard;
  private hoverTimer: number | null = null;
  private clickHandler: (event: MouseEvent) => void;
  private mouseOverHandler: (event: MouseEvent) => void;
  private mouseOutHandler: (event: MouseEvent) => void;

  constructor(app: App, registry: Registry, resolver: Resolver, indexer: Indexer) {
    this.app = app;
    this.registry = registry;
    this.resolver = resolver;
    this.indexer = indexer;
    this.infoCard = new InfoCard(app);
    this.clickHandler = (event) => void this.onClick(event);
    this.mouseOverHandler = (event) => this.onMouseOver(event);
    this.mouseOutHandler = (event) => this.onMouseOut(event);
    document.addEventListener('click', this.clickHandler);
    document.addEventListener('mouseover', this.mouseOverHandler);
    document.addEventListener('mouseout', this.mouseOutHandler);
  }

  async processElement(el: HTMLElement): Promise<void> {
    if (!this.enabled) return;
    // Walk text nodes and replace {{variable}} occurrences
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      // skip if parent is code or pre
      const parent = n.parentElement;
      if (!parent) continue;
      // Skipping our own rendered spans makes this processor idempotent without
      // storing a marker on Obsidian's reusable Reading View section elements.
      if (parent.closest('code, pre, .cm-s, .variable-links-token')) continue;
      if ((n.nodeValue || '').includes('{{')) nodes.push(n as Text);
    }

    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const frag = createFragment();
      TOKEN_REGEX.lastIndex = 0;
      let any = false;
      while ((match = TOKEN_REGEX.exec(text)) !== null) {
        any = true;
        const before = text.slice(lastIndex, match.index);
        if (before) frag.appendChild(document.createTextNode(before));
        const varName = match[1].trim();
        const placeholder = createSpan();
        placeholder.className = 'variable-links-token variable-links-token-reading';
        placeholder.textContent = '…';
        placeholder.dataset.var = varName;
        frag.appendChild(placeholder);

        // resolve async and then update placeholder
        void this.resolvePlaceholder(varName, placeholder);

        lastIndex = TOKEN_REGEX.lastIndex;
      }
      if (!any) continue;
      const rest = text.slice(lastIndex);
      if (rest) frag.appendChild(document.createTextNode(rest));
      textNode.parentNode?.replaceChild(frag, textNode);
    }

  }

  unload(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    document.removeEventListener('click', this.clickHandler);
    document.removeEventListener('mouseover', this.mouseOverHandler);
    document.removeEventListener('mouseout', this.mouseOutHandler);
    this.infoCard.destroy();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view as MarkdownView & { previewMode?: PreviewMode };
      try {
        if (typeof view.previewMode?.rerender === 'function') view.previewMode.rerender(true);
        else view.previewMode?.renderer?.rerender?.(true);
      } catch {
        // Reading View may be changing files during plugin unload.
      }
    }
  }

  private tokenFromEvent(event: MouseEvent): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest?.('.variable-links-token-reading[data-var]') as HTMLElement | null;
  }

  private async onClick(event: MouseEvent): Promise<void> {
    if (!this.enabled) return;
    const token = this.tokenFromEvent(event);
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    const result = await this.resolver.resolve(name).catch(() => null);
    if (!this.enabled || !result?.ok || !result.sourceFile) return;
    try {
      await this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
    } catch {
      await this.app.workspace.getLeaf(false).openFile(result.sourceFile);
    }
    event.stopPropagation();
  }

  private onMouseOver(event: MouseEvent): void {
    if (!this.enabled || !this.registry.plugin.settings.enableInfoCards) return;
    const token = this.tokenFromEvent(event);
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      void this.showInfoCard(token, name);
    }, 200);
  }

  private onMouseOut(event: MouseEvent): void {
    const token = this.tokenFromEvent(event);
    if (!token) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.infoCard.hideWithDelay(100);
  }

  private async resolvePlaceholder(variableName: string, placeholder: HTMLElement): Promise<void> {
    try {
      const result = await this.resolver.resolve(variableName);
      if (!this.enabled) return;
      if (!result.ok) {
        placeholder.textContent = `[Missing: ${variableName}]`;
        placeholder.classList.add('missing');
        placeholder.title = result.error ?? 'Unknown error';
        return;
      }
      placeholder.textContent = Array.isArray(result.value)
        ? result.value.map(String).join(', ')
        : String(result.value);
    } catch {
      if (!this.enabled) return;
      placeholder.textContent = `[Missing: ${variableName}]`;
      placeholder.classList.add('missing');
    }
  }

  private async showInfoCard(token: HTMLElement, name: string): Promise<void> {
    if (!this.enabled || !token.isConnected || !token.matches(':hover')) return;
    const definition = this.registry.getVariable(name);
    if (!definition?.card) return;
    const result = await this.resolver.resolve(name).catch(() => null);
    if (!this.enabled || !token.isConnected || !token.matches(':hover')) return;
    const sourcePath = result?.sourceFile?.path ?? definition.file;
    await this.infoCard.showFor(token, sourcePath, definition.card);
  }
}

export default Renderer;
