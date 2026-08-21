import { App } from 'obsidian';
import Registry from './registry';
import Resolver from './resolver';
import Indexer from './indexer';
import InfoCard from './card';

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;

export class Renderer {
  app: App;
  registry: Registry;
  resolver: Resolver;
  indexer: Indexer;
  enabled: boolean = true;
  infoCard: InfoCard;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
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

  async processElement(el: HTMLElement) {
    if (!this.enabled) return;
    // Walk text nodes and replace {{variable}} occurrences
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null as any);
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
      const frag = document.createDocumentFragment();
      TOKEN_REGEX.lastIndex = 0;
      let any = false;
      while ((match = TOKEN_REGEX.exec(text)) !== null) {
        any = true;
        const before = text.slice(lastIndex, match.index);
        if (before) frag.appendChild(document.createTextNode(before));
        const varName = match[1].trim();
        const placeholder = document.createElement('span');
        placeholder.className = 'variable-links-token variable-links-token-reading';
        placeholder.textContent = '…';
        placeholder.dataset.var = varName;
        frag.appendChild(placeholder);

        // resolve async and then update placeholder
        this.resolver.resolve(varName).then(res => {
          if (!this.enabled) return;
          if (!res.ok) {
            placeholder.textContent = `[Missing: ${varName}]`;
            placeholder.classList.add('missing');
            placeholder.setAttribute('title', res.error || 'Unknown error');
            return;
          }
          // render value
          let display = '';
          if (res.type === 'array') display = (res.value as any[]).join(', ');
          else display = String(res.value);
          placeholder.textContent = display;
        }).catch(() => {});

        lastIndex = TOKEN_REGEX.lastIndex;
      }
      if (!any) continue;
      const rest = text.slice(lastIndex);
      if (rest) frag.appendChild(document.createTextNode(rest));
      textNode.parentNode?.replaceChild(frag, textNode);
    }

  }

  unload() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    document.removeEventListener('click', this.clickHandler);
    document.removeEventListener('mouseover', this.mouseOverHandler);
    document.removeEventListener('mouseout', this.mouseOutHandler);
    this.infoCard.destroy();
    for (const leaf of (this.app.workspace as any).getLeavesOfType?.('markdown') || []) {
      const previewMode = leaf?.view?.previewMode;
      try {
        if (typeof previewMode?.rerender === 'function') previewMode.rerender(true);
        else if (typeof previewMode?.renderer?.rerender === 'function') previewMode.renderer.rerender(true);
      } catch (error) {}
    }
  }

  private tokenFromEvent(event: MouseEvent): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest?.('.variable-links-token-reading[data-var]') as HTMLElement | null;
  }

  private async onClick(event: MouseEvent) {
    if (!this.enabled) return;
    const token = this.tokenFromEvent(event);
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    const result = await this.resolver.resolve(name).catch(() => null);
    if (!this.enabled || !result?.ok || !result.sourceFile) return;
    try {
      this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
    } catch (error) {
      this.app.workspace.openFile(result.sourceFile);
    }
    event.stopPropagation();
  }

  private onMouseOver(event: MouseEvent) {
    if (!this.enabled || (this.registry.plugin as any)?.settings?.enableInfoCards === false) return;
    const token = this.tokenFromEvent(event);
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(async () => {
      this.hoverTimer = null;
      if (!this.enabled || !token.isConnected || !token.matches(':hover')) return;
      const definition = this.registry.getVariable(name);
      if (!definition?.card) return;
      const result = await this.resolver.resolve(name).catch(() => null);
      if (!this.enabled || !token.isConnected || !token.matches(':hover')) return;
      const sourcePath = result?.sourceFile?.path ?? definition.file ?? '';
      void this.infoCard.showFor(token, sourcePath, definition.card);
    }, 200);
  }

  private onMouseOut(event: MouseEvent) {
    const token = this.tokenFromEvent(event);
    if (!token) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.infoCard.hideWithDelay(100);
  }
}

export default Renderer;
