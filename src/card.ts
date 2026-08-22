import { App, MarkdownRenderChild, MarkdownRenderer, TFile, parseYaml } from 'obsidian';

export interface CardConfig {
  title?: string;
  note?: string;
  fields?: string[];
  showSourceLink?: boolean;
  disableLivePreviewHover?: boolean;
}

type Frontmatter = Record<string, unknown>;

export interface CardPointerPosition {
  clientX: number;
  clientY: number;
}

export class InfoCard {
  private el: HTMLElement | null = null;
  private hideTimeout: number | null = null;
  private animationFrame: number | null = null;
  private renderChild: MarkdownRenderChild | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly app: App) {}

  async showFor(
    targetEl: HTMLElement,
    sourceFilePath: string,
    cardConfig: CardConfig,
    pointer: CardPointerPosition,
  ): Promise<void> {
    if (this.destroyed) return;
    this.hideImmediate();
    const generation = this.generation;

    const container = createDiv({ cls: 'variable-links-card' });
    this.el = container;
    const renderChild = new MarkdownRenderChild(container);
    this.renderChild = renderChild;
    renderChild.load();
    const hydrate: Array<() => Promise<void>> = [];

    if (cardConfig.title) {
      container.createDiv({ cls: 'variable-links-card-title', text: cardConfig.title });
    }

    if (cardConfig.note) {
      const noteEl = createDiv({ cls: 'variable-links-card-note' });
      noteEl.textContent = '…';
      container.appendChild(noteEl);
      hydrate.push(async () => {
        noteEl.replaceChildren();
        await MarkdownRenderer.render(this.app, cardConfig.note ?? '', noteEl, sourceFilePath, renderChild);
      });
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

        const row = createEl('tr');
        const name = createEl('th', {
          cls: 'variable-links-card-field-name',
          text: customLabel || this.toSentenceCase(field),
        });
        name.scope = 'row';
        const value = createEl('td', { cls: 'variable-links-card-field-value', text: '…' });
        row.append(name, value);
        tbody.appendChild(row);
        hydrate.push(async () => {
          const frontmatter = await this.getFrontmatter(fieldSourcePath);
          if (!this.isCurrent(container, generation)) return;
          const fieldValue = frontmatter?.[field];
          if (fieldValue === undefined) {
            value.textContent = '(Missing)';
          } else if (Array.isArray(fieldValue)) {
            value.textContent = fieldValue.map(String).join(', ');
          } else if (typeof fieldValue === 'string') {
            value.replaceChildren();
            await MarkdownRenderer.render(this.app, fieldValue, value, fieldSourcePath, renderChild);
          } else if (fieldValue === null
            || typeof fieldValue === 'boolean'
            || typeof fieldValue === 'number'
            || typeof fieldValue === 'bigint') {
            value.textContent = String(fieldValue);
          } else {
            value.textContent = JSON.stringify(fieldValue);
          }
        });
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
    this.schedulePosition(targetEl, container, pointer, generation);

    container.addEventListener('mouseenter', () => this.clearHideTimeout());
    container.addEventListener('mouseleave', () => this.hideWithDelay(150));

    for (const render of hydrate) {
      await render();
      if (!this.isCurrent(container, generation)) return;
      this.schedulePosition(targetEl, container, pointer, generation);
    }
  }

  private schedulePosition(
    targetEl: HTMLElement,
    container: HTMLElement,
    pointer: CardPointerPosition,
    generation: number,
  ): void {
    const activeWindow = targetEl.ownerDocument.defaultView ?? window;
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = null;
      if (!this.isCurrent(container, generation) || !targetEl.isConnected) return;
      const margin = 12;
      const offset = 14;
      let top = pointer.clientY + activeWindow.scrollY + offset;
      let left = pointer.clientX + activeWindow.scrollX + offset;
      const cardWidth = container.offsetWidth || container.getBoundingClientRect().width;
      const cardHeight = container.offsetHeight || container.getBoundingClientRect().height;
      const maxRight = activeWindow.scrollX + activeWindow.innerWidth - margin;
      if (left + cardWidth > maxRight) {
        left = pointer.clientX + activeWindow.scrollX - cardWidth - offset;
      }
      const maxBottom = activeWindow.scrollY + activeWindow.innerHeight - margin;
      if (top + cardHeight > maxBottom) {
        top = pointer.clientY + activeWindow.scrollY - cardHeight - offset;
      }
      left = Math.max(left, margin + activeWindow.scrollX);
      top = Math.max(top, margin + activeWindow.scrollY);
      container.style.top = `${top}px`;
      container.style.left = `${left}px`;
    });
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
