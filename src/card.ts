import { App, MarkdownRenderChild, MarkdownRenderer, TFile, parseYaml } from 'obsidian';
import {
  getActiveCardBlocks,
  type CardBlock,
  type CardPropertyEntry,
} from './cardBlocks';

export interface CardConfig {
  blocks?: CardBlock[];
  useBlockLayout?: boolean;
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
  private dismissCleanup: (() => void) | null = null;
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
    const blocks = getActiveCardBlocks(cardConfig).filter((block) => {
      if (block.type === 'title') return Boolean(block.text);
      if (block.type === 'note') return Boolean(block.markdown);
      if (block.type === 'property-table') return block.properties.length > 0;
      if (block.type === 'source') return Boolean(sourceFilePath);
      return true;
    });
    if (!blocks.length) return;
    const generation = this.generation;

    const container = createDiv({ cls: 'variable-links-card' });
    this.el = container;
    const renderChild = new MarkdownRenderChild(container);
    this.renderChild = renderChild;
    renderChild.load();
    const hydrate: Array<() => Promise<void>> = [];
    for (const block of blocks) {
      this.renderBlock(
        block,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
    }

    if (!this.isCurrent(container, generation)) return;
    targetEl.ownerDocument.body.appendChild(container);
    this.schedulePosition(targetEl, container, pointer, generation);

    container.addEventListener('mouseenter', () => this.clearHideTimeout());
    container.addEventListener('mouseleave', () => this.hideWithDelay(150));
    this.trackDismissal(targetEl, container, generation);

    for (const render of hydrate) {
      await render();
      if (!this.isCurrent(container, generation)) return;
      this.schedulePosition(targetEl, container, pointer, generation);
    }
  }

  private renderBlock(
    block: CardBlock,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    if (block.type === 'title') {
      if (block.text) container.createDiv({ cls: 'variable-links-card-title', text: block.text });
      return;
    }
    if (block.type === 'note') {
      if (!block.markdown) return;
      const noteEl = createDiv({ cls: 'variable-links-card-note' });
      noteEl.textContent = '…';
      container.appendChild(noteEl);
      hydrate.push(async () => {
        noteEl.replaceChildren();
        await MarkdownRenderer.render(
          this.app,
          block.markdown,
          noteEl,
          sourceFilePath,
          renderChild,
        );
      });
      return;
    }
    if (block.type === 'property') {
      this.renderStandaloneProperty(
        block.property,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
      return;
    }
    if (block.type === 'property-table') {
      if (!block.properties.length) return;
      const table = createEl('table', { cls: 'variable-links-card-fields-table' });
      const tbody = createEl('tbody');
      for (const property of block.properties) {
        const row = createEl('tr');
        this.renderPropertyCells(
          property,
          row,
          sourceFilePath,
          renderChild,
          hydrate,
          container,
          generation,
        );
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      container.appendChild(table);
      return;
    }
    if (block.type === 'divider') {
      container.createEl('hr', { cls: 'variable-links-card-divider' });
      return;
    }
    if (block.type === 'source' && sourceFilePath) {
      const source = container.createDiv({ cls: 'variable-links-card-source' });
      const link = source.createEl('a', { text: 'Open source', href: '#' });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(sourceFilePath.replace(/\.md$/i, ''), '', false);
      });
    }
  }

  private renderStandaloneProperty(
    property: CardPropertyEntry,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    const wrapper = createDiv({ cls: 'variable-links-card-property' });
    const parsed = this.parsePropertyReference(property.reference, sourceFilePath);
    const name = createDiv({
      cls: 'variable-links-card-property-name',
      text: parsed.label || this.toSentenceCase(parsed.field),
    });
    const value = createDiv({ cls: 'variable-links-card-property-value', text: '…' });
    wrapper.append(name, value);
    container.appendChild(wrapper);
    this.queuePropertyHydration(
      parsed,
      value,
      container,
      renderChild,
      hydrate,
      generation,
    );
  }

  private renderPropertyCells(
    property: CardPropertyEntry,
    row: HTMLTableRowElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    container: HTMLElement,
    generation: number,
  ): void {
    const parsed = this.parsePropertyReference(property.reference, sourceFilePath);
    const name = createEl('th', {
      cls: 'variable-links-card-field-name',
      text: parsed.label || this.toSentenceCase(parsed.field),
    });
    name.scope = 'row';
    const value = createEl('td', { cls: 'variable-links-card-field-value', text: '…' });
    row.append(name, value);
    this.queuePropertyHydration(
      parsed,
      value,
      container,
      renderChild,
      hydrate,
      generation,
    );
  }

  private queuePropertyHydration(
    property: { field: string; label: string; sourcePath: string },
    value: HTMLElement,
    container: HTMLElement,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    hydrate.push(async () => {
      const frontmatter = await this.getFrontmatter(property.sourcePath);
      if (!this.isCurrent(container, generation)) return;
      const fieldValue = frontmatter?.[property.field];
      if (fieldValue === undefined) {
        value.textContent = '(Missing)';
      } else if (Array.isArray(fieldValue)) {
        value.textContent = fieldValue.map(String).join(', ');
      } else if (typeof fieldValue === 'string') {
        value.replaceChildren();
        await MarkdownRenderer.render(
          this.app,
          fieldValue,
          value,
          property.sourcePath,
          renderChild,
        );
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

  private parsePropertyReference(
    reference: string,
    sourceFilePath: string,
  ): { field: string; label: string; sourcePath: string } {
    const external = reference.match(/^\[\[([^\]]+)\]\]#([^:]+)(?::([\s\S]*))?$/);
    const separator = external ? -1 : reference.indexOf(':');
    return {
      field: (external?.[2]
        ?? (separator === -1 ? reference : reference.slice(0, separator))).trim(),
      label: (external?.[3]
        ?? (separator === -1 ? '' : reference.slice(separator + 1))).trim(),
      sourcePath: external?.[1] ?? sourceFilePath,
    };
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

  private trackDismissal(
    targetEl: HTMLElement,
    container: HTMLElement,
    generation: number,
  ): void {
    this.dismissCleanup?.();
    const ownerDocument = container.ownerDocument;
    const activeWindow = ownerDocument.defaultView ?? window;
    const isInsideCardOrTarget = (target: EventTarget | null): boolean => (
      target instanceof activeWindow.Node && (container.contains(target) || targetEl.contains(target))
    );
    const onMouseMove = (event: MouseEvent): void => {
      if (!this.isCurrent(container, generation)) return;
      if (isInsideCardOrTarget(event.target)) {
        this.clearHideTimeout();
      } else if (this.hideTimeout === null) {
        this.hideWithDelay(150);
      }
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (!this.isCurrent(container, generation) || isInsideCardOrTarget(event.target)) return;
      this.hideImmediate();
    };
    const onMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null && this.isCurrent(container, generation)) {
        this.hideImmediate();
      }
    };
    const onWindowBlur = (): void => {
      if (this.isCurrent(container, generation)) this.hideImmediate();
    };

    ownerDocument.addEventListener('mousemove', onMouseMove, true);
    ownerDocument.addEventListener('mousedown', onMouseDown, true);
    ownerDocument.addEventListener('mouseout', onMouseOut, true);
    activeWindow.addEventListener('blur', onWindowBlur);
    this.dismissCleanup = () => {
      ownerDocument.removeEventListener('mousemove', onMouseMove, true);
      ownerDocument.removeEventListener('mousedown', onMouseDown, true);
      ownerDocument.removeEventListener('mouseout', onMouseOut, true);
      activeWindow.removeEventListener('blur', onWindowBlur);
    };
  }

  hideImmediate(): void {
    this.generation++;
    this.clearHideTimeout();
    this.dismissCleanup?.();
    this.dismissCleanup = null;
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
