import { App, MarkdownRenderChild, MarkdownRenderer, TFile, parseYaml } from 'obsidian';
import {
  getActiveCardBlocks,
  type CardBlock,
  type CardLayoutFields,
  type CardPropertyEntry,
  type CardPropertyTableBlock,
  type CardStackBlock,
} from './cardBlocks';

export interface CardConfig extends CardLayoutFields {
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
    const rendering = this.createCard(sourceFilePath, cardConfig);
    if (!rendering) return;
    const { container, hydrate, generation } = rendering;

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

  async renderPreview(
    parent: HTMLElement,
    sourceFilePath: string,
    cardConfig: CardConfig,
  ): Promise<void> {
    if (this.destroyed) return;
    const rendering = this.createCard(sourceFilePath, cardConfig, true);
    if (!rendering) {
      parent.createDiv({ cls: 'variable-links-card-preview-empty', text: 'Nothing to preview yet.' });
      return;
    }
    const { container, hydrate, generation } = rendering;
    parent.appendChild(container);
    for (const render of hydrate) {
      await render();
      if (!this.isCurrent(container, generation)) return;
    }
  }

  private createCard(
    sourceFilePath: string,
    cardConfig: CardConfig,
    preview = false,
  ): { container: HTMLElement; hydrate: Array<() => Promise<void>>; generation: number } | null {
    this.hideImmediate();
    const blocks = getActiveCardBlocks(cardConfig)
      .filter((block) => this.isBlockVisible(block, sourceFilePath));
    if (!blocks.length) return null;
    const generation = this.generation;
    const useBlockLayout = cardConfig.useBlockLayout === true;
    const layoutMode = useBlockLayout && cardConfig.layoutMode === 'grid' ? 'grid' : 'stack';
    const gridColumns = cardConfig.gridColumns ?? 2;
    const layoutGap = cardConfig.layoutGap ?? (layoutMode === 'grid' ? 8 : 0);
    const classes = ['variable-links-card'];
    if (useBlockLayout) {
      classes.push(
        `variable-links-card-layout-${layoutMode}`,
        `variable-links-card-grid-columns-${gridColumns}`,
      );
    } else {
      classes.push('variable-links-card-simple');
    }
    if (preview) classes.push('variable-links-card-preview');
    const container = createDiv({ cls: classes.join(' ') });
    if (useBlockLayout) this.applyCardStyle(container, cardConfig);
    if (useBlockLayout) {
      container.style.setProperty('--variable-links-card-layout-gap', `${layoutGap}px`);
    }
    this.el = container;
    const renderChild = new MarkdownRenderChild(container);
    this.renderChild = renderChild;
    renderChild.load();
    const hydrate: Array<() => Promise<void>> = [];
    for (const block of blocks) {
      const wrapBlock = layoutMode === 'grid' || Boolean(useBlockLayout && block.style);
      const host = wrapBlock
        ? container.createDiv({ cls: 'variable-links-card-block' })
        : container;
      if (layoutMode === 'grid') host.dataset.width = block.width ?? 'auto';
      if (wrapBlock) this.applyBlockStyle(host, block);
      this.renderBlock(
        block,
        host,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
    }
    return { container, hydrate, generation };
  }

  private applyCardStyle(container: HTMLElement, cardConfig: CardConfig): void {
    const style = cardConfig.cardStyle;
    if (!style) return;
    if (style.background && style.background !== 'default') {
      container.addClass(`variable-links-card-background-${style.background}`);
    }
    if (style.border && style.border !== 'default') {
      container.addClass(`variable-links-card-border-${style.border}`);
    }
    if (style.shadow) container.addClass(`variable-links-card-shadow-${style.shadow}`);
    if (style.alignment) container.addClass(`variable-links-card-align-${style.alignment}`);
    if (style.radius !== undefined) {
      container.style.setProperty('--variable-links-card-radius', `${style.radius}px`);
    }
    if (style.maxWidth !== undefined) {
      container.style.setProperty('--variable-links-card-max-width', `${style.maxWidth}px`);
      container.addClass('variable-links-card-custom-width');
    }
    if (style.padding !== undefined) {
      container.style.setProperty('--variable-links-card-padding', `${style.padding}px`);
    }
    for (const cssClass of style.cssClasses ?? []) container.addClass(cssClass);
  }

  private applyBlockStyle(host: HTMLElement, block: CardBlock): void {
    const style = block.style;
    if (!style) return;
    host.addClass('variable-links-card-block-styled');
    if (style.tone) host.addClass(`variable-links-card-block-tone-${style.tone}`);
    if (style.border) host.addClass(`variable-links-card-block-border-${style.border}`);
    if (style.alignment) host.addClass(`variable-links-card-block-align-${style.alignment}`);
    if (style.padding !== undefined) host.style.padding = `${style.padding}px`;
  }

  private renderBlock(
    block: CardBlock,
    host: HTMLElement,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    if (block.type === 'stack') {
      this.renderStackBlock(
        block,
        host,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
      return;
    }
    if (block.type === 'title') {
      if (block.text) host.createDiv({ cls: 'variable-links-card-title', text: block.text });
      return;
    }
    if (block.type === 'note') {
      if (!block.markdown) return;
      const noteEl = createDiv({ cls: 'variable-links-card-note' });
      noteEl.textContent = '…';
      host.appendChild(noteEl);
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
        host,
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
      this.renderPropertyTable(
        block,
        host,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
      return;
    }
    if (block.type === 'divider') {
      host.createEl('hr', { cls: 'variable-links-card-divider' });
      return;
    }
    if (block.type === 'source' && sourceFilePath) {
      const source = host.createDiv({ cls: 'variable-links-card-source' });
      const link = source.createEl('a', { text: 'Open source', href: '#' });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(sourceFilePath.replace(/\.md$/i, ''), '', false);
      });
    }
  }

  private renderStackBlock(
    block: CardStackBlock,
    host: HTMLElement,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    const stack = host.createDiv({ cls: 'variable-links-card-stack' });
    stack.dataset.direction = block.direction ?? 'vertical';
    const style = block.stackStyle;
    if (style?.tone) stack.addClass(`variable-links-card-stack-tone-${style.tone}`);
    if (style?.border) stack.addClass(`variable-links-card-stack-border-${style.border}`);
    if (style?.padding !== undefined) stack.style.padding = `${style.padding}px`;
    if (style?.gap !== undefined) {
      stack.style.setProperty('--variable-links-card-stack-gap', `${style.gap}px`);
    }
    if (style?.radius !== undefined) {
      stack.style.setProperty('--variable-links-card-stack-radius', `${style.radius}px`);
    }
    if (block.heading) stack.createDiv({ cls: 'variable-links-card-stack-heading', text: block.heading });
    const content = stack.createDiv({ cls: 'variable-links-card-stack-content' });
    for (const child of block.blocks) {
      if (!this.isBlockVisible(child, sourceFilePath)) continue;
      const childHost = content.createDiv({ cls: 'variable-links-card-stack-item' });
      childHost.dataset.width = child.width ?? 'auto';
      if (child.style) this.applyBlockStyle(childHost, child);
      this.renderBlock(
        child,
        childHost,
        container,
        sourceFilePath,
        renderChild,
        hydrate,
        generation,
      );
    }
  }

  private isBlockVisible(block: CardBlock, sourceFilePath: string): boolean {
    if (block.type === 'title') return Boolean(block.text);
    if (block.type === 'note') return Boolean(block.markdown);
    if (block.type === 'property-table') return block.properties.length > 0;
    if (block.type === 'source') return Boolean(sourceFilePath);
    if (block.type === 'stack') {
      return Boolean(block.heading)
        || block.blocks.some((child) => this.isBlockVisible(child, sourceFilePath));
    }
    return true;
  }

  private renderStandaloneProperty(
    property: CardPropertyEntry,
    host: HTMLElement,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    const wrapper = createDiv({ cls: 'variable-links-card-property' });
    const parsed = this.parsePropertyReference(property.reference, sourceFilePath);
    wrapper.dataset.labelPosition = property.labelPosition ?? 'left';
    if (property.alignment) wrapper.dataset.alignment = property.alignment;
    if (property.labelWidth !== undefined) {
      wrapper.style.setProperty('--variable-links-card-label-width', `${property.labelWidth}%`);
    }
    const name = property.labelPosition === 'hidden'
      ? null
      : createDiv({
        cls: 'variable-links-card-property-name',
        text: (property.label ?? parsed.label) || this.toSentenceCase(parsed.field),
      });
    const value = createDiv({ cls: 'variable-links-card-property-value', text: '…' });
    if (name) wrapper.append(name, value);
    else wrapper.append(value);
    host.appendChild(wrapper);
    this.queuePropertyHydration(
      parsed,
      value,
      container,
      renderChild,
      hydrate,
      generation,
    );
  }

  private renderPropertyTable(
    block: CardPropertyTableBlock,
    host: HTMLElement,
    container: HTMLElement,
    sourceFilePath: string,
    renderChild: MarkdownRenderChild,
    hydrate: Array<() => Promise<void>>,
    generation: number,
  ): void {
    const columns = block.columns ?? 1;
    const contentRows = Math.ceil(block.properties.length / columns);
    const rowCount = block.rowMode === 'fixed'
      ? Math.max(contentRows, block.rows ?? 1)
      : contentRows;
    const table = createEl('table', { cls: 'variable-links-card-fields-table' });
    table.dataset.columns = String(columns);
    const tbody = createEl('tbody');
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row = createEl('tr');
      for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
        const property = block.properties[rowIndex * columns + columnIndex];
        if (property) {
          this.renderPropertyCells(
            property,
            row,
            sourceFilePath,
            renderChild,
            hydrate,
            container,
            generation,
          );
        } else {
          const emptyCell = createEl('td', { cls: 'variable-links-card-field-empty' });
          emptyCell.colSpan = 2;
          emptyCell.setAttribute('aria-hidden', 'true');
          row.appendChild(emptyCell);
        }
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    host.appendChild(table);
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
    const label = (property.label ?? parsed.label) || this.toSentenceCase(parsed.field);
    if (property.labelPosition === 'above') {
      const cell = createEl('td', { cls: 'variable-links-card-field-cell' });
      cell.colSpan = 2;
      const wrapper = cell.createDiv({ cls: 'variable-links-card-property' });
      wrapper.dataset.labelPosition = 'above';
      if (property.alignment) wrapper.dataset.alignment = property.alignment;
      wrapper.createDiv({ cls: 'variable-links-card-property-name', text: label });
      const value = wrapper.createDiv({ cls: 'variable-links-card-property-value', text: '…' });
      row.appendChild(cell);
      this.queuePropertyHydration(
        parsed,
        value,
        container,
        renderChild,
        hydrate,
        generation,
      );
      return;
    }
    if (property.labelPosition === 'hidden') {
      const value = createEl('td', { cls: 'variable-links-card-field-value', text: '…' });
      value.colSpan = 2;
      if (property.alignment) value.style.textAlign = property.alignment;
      row.appendChild(value);
      this.queuePropertyHydration(
        parsed,
        value,
        container,
        renderChild,
        hydrate,
        generation,
      );
      return;
    }
    const name = createEl('th', {
      cls: 'variable-links-card-field-name',
      text: label,
    });
    name.scope = 'row';
    const value = createEl('td', { cls: 'variable-links-card-field-value', text: '…' });
    if (property.labelWidth !== undefined) name.style.width = `${property.labelWidth}%`;
    if (property.alignment) {
      name.style.textAlign = property.alignment;
      value.style.textAlign = property.alignment;
    }
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
