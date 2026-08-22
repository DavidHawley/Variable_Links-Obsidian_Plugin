import { App, MarkdownRenderChild, MarkdownRenderer, TFile, parseYaml } from 'obsidian';

export interface CardConfig {
  title?: string;
  note?: string;
  fields?: string[];
  showSourceLink?: boolean;
}

type Frontmatter = Record<string, unknown>;

export class InfoCard {
  private el: HTMLElement | null = null;
  private hideTimeout: number | null = null;
  private animationFrame: number | null = null;
  private renderChild: MarkdownRenderChild | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly app: App) {}

  async showFor(targetEl: HTMLElement, sourceFilePath: string, cardConfig: CardConfig): Promise<void> {
    if (this.destroyed) return;
    this.hideImmediate();
    const generation = this.generation;

    const container = createDiv({ cls: 'variable-links-card' });
    this.el = container;
    this.renderChild = new MarkdownRenderChild(container);
    this.renderChild.load();

    if (cardConfig.title) {
      container.createDiv({ cls: 'variable-links-card-title', text: cardConfig.title });
    }

    if (cardConfig.note) {
      const noteEl = createDiv({ cls: 'variable-links-card-note' });
      await MarkdownRenderer.render(this.app, cardConfig.note, noteEl, sourceFilePath, this.renderChild);
      if (!this.isCurrent(container, generation)) return;
      container.appendChild(noteEl);
    }

    if (cardConfig.fields?.length) {
      const table = createEl('table', { cls: 'variable-links-card-fields-table' });
      const tbody = createEl('tbody');

      for (const fieldConfig of cardConfig.fields) {
        const external = fieldConfig.match(/^\[\[([^\]]+)\]\]#([^:]+)(?::([\s\S]*))?$/);
        const separator = external ? -1 : fieldConfig.indexOf(':');
        const field = (external?.[2] ?? (separator === -1 ? fieldConfig : fieldConfig.slice(0, separator))).trim();
        const customLabel = (external?.[3] ?? (separator === -1 ? '' : fieldConfig.slice(separator + 1))).trim();
        const fieldSourcePath = external?.[1] ?? sourceFilePath;
        const frontmatter = await this.getFrontmatter(fieldSourcePath);
        if (!this.isCurrent(container, generation)) return;

        const row = createEl('tr');
        const name = createEl('th', {
          cls: 'variable-links-card-field-name',
          text: customLabel || this.toSentenceCase(field),
        });
        name.scope = 'row';
        const value = createEl('td', { cls: 'variable-links-card-field-value' });
        const fieldValue = frontmatter?.[field];
        if (fieldValue === undefined) {
          value.textContent = '(Missing)';
        } else if (Array.isArray(fieldValue)) {
          value.textContent = fieldValue.map(String).join(', ');
        } else if (typeof fieldValue === 'string') {
          await MarkdownRenderer.render(this.app, fieldValue, value, fieldSourcePath, this.renderChild);
          if (!this.isCurrent(container, generation)) return;
        } else if (fieldValue === null
          || typeof fieldValue === 'boolean'
          || typeof fieldValue === 'number'
          || typeof fieldValue === 'bigint') {
          value.textContent = String(fieldValue);
        } else {
          value.textContent = JSON.stringify(fieldValue);
        }
        row.append(name, value);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      container.appendChild(table);
    }

    if (cardConfig.showSourceLink) {
      const source = container.createDiv({ cls: 'variable-links-card-source' });
      const link = source.createEl('a', { text: 'Open source', href: '#' });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(sourceFilePath.replace(/\.md$/i, ''), '', false);
      });
    }

    if (!this.isCurrent(container, generation)) return;
    targetEl.ownerDocument.body.appendChild(container);
    const activeWindow = targetEl.ownerDocument.defaultView ?? window;
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = null;
      if (!this.isCurrent(container, generation) || !targetEl.isConnected) return;
      const rect = targetEl.getBoundingClientRect();
      const margin = 12;
      const top = rect.bottom + activeWindow.scrollY + 6;
      let left = rect.left + activeWindow.scrollX;
      const cardWidth = container.offsetWidth || container.getBoundingClientRect().width;
      const maxRight = activeWindow.scrollX + activeWindow.innerWidth - margin;
      if (left + cardWidth > maxRight) {
        left = Math.max(margin + activeWindow.scrollX, maxRight - cardWidth);
      }
      left = Math.max(left, margin + activeWindow.scrollX);
      container.style.top = `${top}px`;
      container.style.left = `${left}px`;
    });

    container.addEventListener('mouseenter', () => this.clearHideTimeout());
    container.addEventListener('mouseleave', () => this.hideWithDelay(150));
  }

  hideWithDelay(ms = 150): void {
    if (this.destroyed) return;
    this.clearHideTimeout();
    this.hideTimeout = window.setTimeout(() => this.hideImmediate(), ms);
  }

  clearHideTimeout(): void {
    if (this.hideTimeout === null) return;
    window.clearTimeout(this.hideTimeout);
    this.hideTimeout = null;
  }

  hideImmediate(): void {
    this.generation++;
    this.clearHideTimeout();
    if (this.animationFrame !== null) {
      const activeWindow = this.el?.ownerDocument.defaultView ?? window;
      activeWindow.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.renderChild?.unload();
    this.renderChild = null;
    this.el?.remove();
    this.el = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.hideImmediate();
  }

  private async getFrontmatter(sourcePath: string): Promise<Frontmatter | null> {
    const linkPath = sourcePath.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '');
    const directPath = /\.md$/i.test(sourcePath) ? sourcePath : `${sourcePath}.md`;
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '')
      ?? this.app.vault.getFileByPath(directPath);
    if (!(file instanceof TFile)) return null;

    const cached: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (this.isRecord(cached)) return cached;
    try {
      const content = await this.app.vault.read(file);
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match?.[1]) return null;
      const parsed: unknown = parseYaml(match[1]);
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private isCurrent(container: HTMLElement, generation: number): boolean {
    return !this.destroyed && this.el === container && this.generation === generation;
  }

  private isRecord(value: unknown): value is Frontmatter {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toSentenceCase(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }
}

export default InfoCard;
