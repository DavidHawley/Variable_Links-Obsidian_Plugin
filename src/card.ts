import { App, MarkdownRenderer } from 'obsidian';

export interface CardConfig {
  title?: string;
  note?: string;
  fields?: string[];
  showSourceLink?: boolean;
}

export class InfoCard {
  app: App;
  el: HTMLElement | null = null;
  hideTimeout: any = null;

  constructor(app: App) {
    this.app = app;
  }

  async showFor(targetEl: HTMLElement, sourceFilePath: string, cardConfig: CardConfig) {
    this.hideImmediate();

    // build container
    const container = document.createElement('div');
    container.className = 'variable-links-card';
    container.style.position = 'absolute';
    container.style.zIndex = '9999';

    // Title
    if (cardConfig?.title) {
      const h = document.createElement('div');
      h.style.fontWeight = '600';
      h.style.marginBottom = '6px';
      h.textContent = cardConfig.title;
      container.appendChild(h);
    }

    // Note
    if (cardConfig?.note) {
      const p = document.createElement('div');
      p.style.marginBottom = '6px';
      // render as markdown for convenience
      await MarkdownRenderer.renderMarkdown(cardConfig.note || '', p, '', null as any);
      container.appendChild(p);
    }

    // Fields
    if (cardConfig?.fields && cardConfig.fields.length > 0) {
      const ul = document.createElement('ul');
      ul.style.margin = '4px 0';
      ul.style.paddingLeft = '18px';

      // Attempt to get frontmatter from metadataCache
      const file = (this.app.vault as any).getAbstractFileByPath(sourceFilePath);
      let front: any = null;
      if (file) {
        front = (this.app as any).metadataCache?.getFileCache(file)?.frontmatter ?? null;
        if (!front) {
          try {
            const content = await (this.app.vault as any).read(file);
            // quick frontmatter parse
            const m = content.match(/^---\n([\s\S]*?)\n---/);
            if (m) {
              try { front = (window as any).parseYaml ? (window as any).parseYaml(m[1]) : null; } catch(e) { front = null; }
            }
          } catch (e) { front = null; }
        }
      }

      for (const field of cardConfig.fields) {
        const li = document.createElement('li');
        const val = front?.[field];
        if (typeof val === 'undefined') {
          li.textContent = `${field}: (missing)`;
        } else if (Array.isArray(val)) {
          li.textContent = `${field}: ${val.join(', ')}`;
        } else {
          // render markdown/value
          if (typeof val === 'string') {
            // render markdown into a temporary container
            const span = document.createElement('span');
            await MarkdownRenderer.renderMarkdown(String(val), span, '', null as any);
            li.appendChild(document.createTextNode(`${field}: `));
            li.appendChild(span);
          } else {
            li.textContent = `${field}: ${String(val)}`;
          }
        }
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }

    // Source link
    if (cardConfig?.showSourceLink) {
      const btn = document.createElement('div');
      btn.style.marginTop = '6px';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Open source';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        try {
          (this.app.workspace as any).openLinkText(sourceFilePath.replace(/\.md$/i, ''), '', false);
        } catch (err) {
          const file = (this.app.vault as any).getAbstractFileByPath(sourceFilePath);
          if (file) (this.app.workspace as any).openFile(file);
        }
      });
      btn.appendChild(a);
      container.appendChild(btn);
    }

    // Append first so browser can compute layout, then adjust width/position dynamically
    // allow the card to size to its content but cap at a reasonable percentage of viewport
    container.style.maxWidth = '60vw';
    container.style.width = 'auto';
    container.style.boxSizing = 'border-box';

    document.body.appendChild(container);
    this.el = container;

    // After element is in DOM, measure and position on next frame to allow proper layout
    requestAnimationFrame(() => {
      // position near targetEl
      const rect = targetEl.getBoundingClientRect();
      const top = rect.bottom + window.scrollY + 6;
      // prefer aligning left with target, but ensure the card stays within viewport with an 12px margin
      const margin = 12;
      let left = rect.left + window.scrollX;

      // if card would overflow to the right, shift it left
      const cardWidth = container.offsetWidth || container.getBoundingClientRect().width;
      const maxRight = window.scrollX + window.innerWidth - margin;
      if (left + cardWidth > maxRight) {
        left = Math.max(margin + window.scrollX, maxRight - cardWidth);
      }

      // if card would overflow to the left, clamp
      const minLeft = margin + window.scrollX;
      if (left < minLeft) left = minLeft;

      container.style.top = `${top}px`;
      container.style.left = `${left}px`;
    });

    // attach handlers to hide when mouse leaves
    container.addEventListener('mouseenter', () => { this.clearHideTimeout(); });
    container.addEventListener('mouseleave', () => { this.hideWithDelay(150); });
  }

  hideWithDelay(ms = 150) {
    this.clearHideTimeout();
    this.hideTimeout = setTimeout(() => this.hideImmediate(), ms);
  }
  clearHideTimeout() { if (this.hideTimeout) { clearTimeout(this.hideTimeout); this.hideTimeout = null; } }

  hideImmediate() {
    this.clearHideTimeout();
    if (this.el && this.el.parentElement) {
      this.el.parentElement.removeChild(this.el);
    }
    this.el = null;
  }
}

export default InfoCard;
