import { App, MarkdownRenderer, parseYaml } from 'obsidian';

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
      h.className = 'variable-links-card-title';
      h.textContent = cardConfig.title;
      container.appendChild(h);
    }

    // Note
    if (cardConfig?.note) {
      const p = document.createElement('div');
      p.style.marginBottom = '6px';
      // render as markdown for convenience
      await MarkdownRenderer.renderMarkdown(cardConfig.note || '', p, '', this.app);
      container.appendChild(p);
    }

    // Fields
    if (cardConfig?.fields && cardConfig.fields.length > 0) {
      const table = document.createElement('table');
      table.className = 'variable-links-card-fields-table';
      const tbody = document.createElement('tbody');

      for (const fieldConfig of cardConfig.fields) {
        const external = fieldConfig.match(/^\[\[([^\]]+)\]\]#([^:]+)(?::([\s\S]*))?$/);
        const separator = external ? -1 : fieldConfig.indexOf(':');
        const field = (external ? external[2] : separator === -1 ? fieldConfig : fieldConfig.slice(0, separator)).trim();
        const customLabel = (external ? external[3] || '' : separator === -1 ? '' : fieldConfig.slice(separator + 1)).trim();
        const fieldSourcePath = external ? external[1] : sourceFilePath;
        const front = await this.getFrontmatter(fieldSourcePath);
        const row = document.createElement('tr');
        const val = front?.[field];
        const name = document.createElement('th');
        name.className = 'variable-links-card-field-name';
        name.scope = 'row';
        name.textContent = customLabel || (field ? field.charAt(0).toUpperCase() + field.slice(1) : field);
        const value = document.createElement('td');
        value.className = 'variable-links-card-field-value';
        if (typeof val === 'undefined') value.textContent = '(missing)';
        else if (Array.isArray(val)) value.textContent = val.join(', ');
        else if (typeof val === 'string') await MarkdownRenderer.renderMarkdown(val, value, '', this.app);
        else value.textContent = String(val);
        row.appendChild(name);
        row.appendChild(value);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      container.appendChild(table);
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

  private async getFrontmatter(sourcePath: string): Promise<any> {
    const linkPath = sourcePath.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '');
    const cache = (this.app as any).metadataCache;
    const file = cache?.getFirstLinkpathDest?.(linkPath, '')
      || (this.app.vault as any).getAbstractFileByPath(/\.md$/i.test(sourcePath) ? sourcePath : `${sourcePath}.md`);
    if (!file) return null;
    const cached = cache?.getFileCache?.(file)?.frontmatter;
    if (cached) return cached;
    try {
      const content = await (this.app.vault as any).read(file);
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      return match ? parseYaml(match[1]) : null;
    } catch (e) {
      return null;
    }
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
