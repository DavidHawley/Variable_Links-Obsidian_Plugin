import { App } from 'obsidian';
import Registry from './registry';
import Resolver from './resolver';
import Indexer from './indexer';
import InfoCard, { CardConfig } from './card';

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;

export class Renderer {
  app: App;
  registry: Registry;
  resolver: Resolver;
  indexer: Indexer;
  enabled: boolean = true;
  infoCard: InfoCard;

  constructor(app: App, registry: Registry, resolver: Resolver, indexer: Indexer) {
    this.app = app;
    this.registry = registry;
    this.resolver = resolver;
    this.indexer = indexer;
    this.infoCard = new InfoCard(app);
  }

  register() {
    if (!this.enabled) return;
    (this.app as any).registerMarkdownPostProcessor?.(async (el: HTMLElement, ctx: any) => {
      await this.processElement(el);
    });
  }

  async processElement(el: HTMLElement) {
    // Walk text nodes and replace {{variable}} occurrences
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null as any);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      // skip if parent is code or pre
      const parent = n.parentElement;
      if (!parent) continue;
      if (parent.closest('code, pre, .cm-s')) continue;
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
        placeholder.className = 'variable-links-token';
        placeholder.textContent = '…';
        frag.appendChild(placeholder);

        // resolve async and then update placeholder
        this.resolver.resolve(varName).then(res => {
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

          // click to open source
          placeholder.addEventListener('click', (ev) => {
            if (res.sourceFile) {
              try { this.app.workspace.openLinkText(res.sourceFile.path.replace(/\.md$/i, ''), '', false); } catch (e) { this.app.workspace.openFile(res.sourceFile); }
            }
            ev.stopPropagation();
          });

          // hover -> info card (if configured and enabled)
          const def = this.registry.getVariable(varName);
          const cardCfg: CardConfig | undefined = def?.card;
          if (cardCfg && (this.registry.plugin as any)?.settings?.enableInfoCards !== false) {
            let enterTimer: any = null;
            placeholder.addEventListener('mouseenter', () => {
              if (enterTimer) clearTimeout(enterTimer);
              enterTimer = setTimeout(() => {
                const sourcePath = res.sourceFile?.path ?? (def?.file ?? '');
                this.infoCard.showFor(placeholder, sourcePath, cardCfg);
              }, 200);
            });
            placeholder.addEventListener('mouseleave', () => {
              if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
              this.infoCard.hideWithDelay(100);
            });
          }
        });

        lastIndex = TOKEN_REGEX.lastIndex;
      }
      if (!any) continue;
      const rest = text.slice(lastIndex);
      if (rest) frag.appendChild(document.createTextNode(rest));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
}

export default Renderer;
