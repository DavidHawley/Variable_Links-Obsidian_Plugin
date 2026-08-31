import { App, MarkdownView } from 'obsidian';
import Registry, { getVariableType } from './registry';
import Resolver from './resolver';
import Indexer from './indexer';
import InfoCard from './card';
import { filePathFromLink } from './linkSyntax';
import { applyVariableAppearance, getEffectiveVariableAppearance } from './appearance';
import { getActiveCardBlocks } from './cardBlocks';
import { findVariableTokens, getRecognizedTokenSyntaxes } from './tokenSyntax';
import { applyVariableTextCase, type VariableTextCase } from './textCase';

interface PreviewMode {
  rerender?: (force: boolean) => void;
  renderer?: { rerender?: (force: boolean) => void };
}

interface HoverState {
  name: string;
  token: HTMLElement;
  livePreview: boolean;
  deadline: number;
  timer: number | null;
  clientX: number;
  clientY: number;
}

export class Renderer {
  app: App;
  registry: Registry;
  resolver: Resolver;
  indexer: Indexer;
  enabled: boolean = true;
  infoCard: InfoCard;
  private hoverState: HoverState | null = null;
  private hoverExitTimer: number | null = null;
  private clickHandler: (event: MouseEvent) => void;
  private mouseOverHandler: (event: MouseEvent) => void;
  private mouseOutHandler: (event: MouseEvent) => void;
  private mouseMoveHandler: (event: MouseEvent) => void;

  constructor(app: App, registry: Registry, resolver: Resolver, indexer: Indexer) {
    this.app = app;
    this.registry = registry;
    this.resolver = resolver;
    this.indexer = indexer;
    this.infoCard = new InfoCard(app);
    this.clickHandler = (event) => void this.onClick(event);
    this.mouseOverHandler = (event) => this.onMouseOver(event);
    this.mouseOutHandler = (event) => this.onMouseOut(event);
    this.mouseMoveHandler = (event) => this.onMouseMove(event);
    document.addEventListener('click', this.clickHandler);
    document.addEventListener('mouseover', this.mouseOverHandler);
    document.addEventListener('mouseout', this.mouseOutHandler);
    document.addEventListener('mousemove', this.mouseMoveHandler);
  }

  async processElement(el: HTMLElement): Promise<void> {
    if (!this.enabled) return;
    const syntaxes = getRecognizedTokenSyntaxes(this.registry.plugin.settings);
    // Walk text nodes and replace Variable Link token occurrences.
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
      const value = n.nodeValue || '';
      if (syntaxes.some((syntax) => value.includes(syntax.prefix))) {
        nodes.push(n as Text);
      }
    }

    const resolutions: Promise<void>[] = [];
    const replacements: Array<{ textNode: Text; fragment: DocumentFragment }> = [];
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      let lastIndex = 0;
      const frag = createFragment();
      let any = false;
      for (const match of findVariableTokens(
        text,
        syntaxes,
        (name) => this.registry.getVariable(name) !== null,
      )) {
        any = true;
        const before = text.slice(lastIndex, match.start);
        if (before) frag.appendChild(document.createTextNode(before));
        const varName = match.name;
        const placeholder = createSpan();
        placeholder.className = 'variable-links-token variable-links-token-reading';
        placeholder.textContent = '…';
        placeholder.dataset.var = varName;
        applyVariableAppearance(
          placeholder,
          getEffectiveVariableAppearance(
            this.registry.getVariable(varName)?.appearance,
            this.registry.plugin.settings,
          ),
        );
        frag.appendChild(placeholder);

        // Resolve while the fragment is detached so table cells do not reflow
        // from a placeholder to their final value during scrolling.
        resolutions.push(this.resolvePlaceholder(varName, placeholder, match.textCase));

        lastIndex = match.end;
      }
      if (!any) continue;
      const rest = text.slice(lastIndex);
      if (rest) frag.appendChild(document.createTextNode(rest));
      replacements.push({ textNode, fragment: frag });
    }

    await Promise.all(resolutions);
    if (!this.enabled) return;
    for (const { textNode, fragment } of replacements) {
      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }

  unload(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearHoverState();
    this.clearHoverExitTimer();
    document.removeEventListener('click', this.clickHandler);
    document.removeEventListener('mouseover', this.mouseOverHandler);
    document.removeEventListener('mouseout', this.mouseOutHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
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

  private readingTokenFromEvent(event: MouseEvent): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest?.('.variable-links-token-reading[data-var]') as HTMLElement | null;
  }

  private hoverTokenFromEvent(event: MouseEvent): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest?.(
      '.variable-links-token-reading[data-var], .variable-links-token-live-preview[data-var]',
    ) as HTMLElement | null;
  }

  private async onClick(event: MouseEvent): Promise<void> {
    if (!this.enabled) return;
    const token = this.readingTokenFromEvent(event);
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    const definition = this.registry.getVariable(name);
    const fileLinkTarget = filePathFromLink(definition?.link ?? '');
    if (fileLinkTarget) {
      await this.app.workspace.openLinkText(
        fileLinkTarget,
        '',
        this.registry.plugin.settings.openInNewPane,
      );
      event.stopPropagation();
      return;
    }
    const result = await this.resolver.resolve(name).catch(() => null);
    if (!this.enabled || !result?.ok || !result.sourceFile) return;
    try {
      await this.app.workspace.openLinkText(
        result.sourceFile.path.replace(/\.md$/i, ''),
        '',
        this.registry.plugin.settings.openInNewPane,
      );
    } catch {
      await this.app.workspace.getLeaf(false).openFile(result.sourceFile);
    }
    event.stopPropagation();
  }

  private onMouseOver(event: MouseEvent): void {
    if (!this.enabled || !this.registry.plugin.settings.enableInfoCards) return;
    const token = this.hoverTokenFromEvent(event);
    const target = event.target instanceof Element ? event.target : null;
    if (!token && target?.closest('.variable-links-card')) {
      this.clearHoverExitTimer();
      this.clearHoverState();
      return;
    }
    const name = token?.dataset.var?.trim();
    if (!token || !name) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    this.clearHoverExitTimer();
    const livePreview = token.classList.contains('variable-links-token-live-preview');
    const definition = this.registry.getVariable(name);
    if (!definition?.card || !getActiveCardBlocks(definition.card).length) return;
    if (livePreview && (
      this.registry.plugin.settings.disableLivePreviewHover
      || definition.card.disableLivePreviewHover
    )) return;
    const current = this.hoverState;
    if (current && current.name === name && current.livePreview === livePreview) {
      current.token = token;
      return;
    }
    this.clearHoverState();
    const delay = livePreview
      ? this.registry.plugin.settings.livePreviewHoverDelaySeconds * 1000
      : this.registry.plugin.settings.readingViewHoverDelaySeconds * 1000;
    const state: HoverState = {
      name,
      token,
      livePreview,
      deadline: performance.now() + delay,
      timer: null,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    const remaining = Math.max(0, state.deadline - performance.now());
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void this.showInfoCard(state);
    }, remaining);
    this.hoverState = state;
  }

  private onMouseOut(event: MouseEvent): void {
    const token = this.hoverTokenFromEvent(event);
    if (!token) return;
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return;
    if (token.classList.contains('variable-links-token-live-preview')) {
      const state = this.hoverState;
      const document = token.ownerDocument;
      const { clientX, clientY } = event;
      this.clearHoverExitTimer();
      this.hoverExitTimer = window.setTimeout(() => {
        this.hoverExitTimer = null;
        if (!this.enabled || !state || this.hoverState !== state) return;
        const hovered = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
          '.variable-links-token-live-preview[data-var]',
        );
        if (hovered?.dataset.var?.trim() === state.name) {
          state.token = hovered;
          return;
        }
        this.clearHoverState();
        this.infoCard.hideWithDelay(100);
      }, 0);
      return;
    }
    this.clearHoverState();
    this.infoCard.hideWithDelay(100);
  }

  private onMouseMove(event: MouseEvent): void {
    const state = this.hoverState;
    if (!state) return;
    const token = this.hoverTokenFromEvent(event);
    if (token?.dataset.var?.trim() !== state.name) return;
    state.token = token;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
  }

  private async resolvePlaceholder(
    variableName: string,
    placeholder: HTMLElement,
    tokenTextCase?: VariableTextCase,
  ): Promise<void> {
    try {
      const result = await this.resolver.resolve(variableName);
      if (!this.enabled) return;
      if (!result.ok) {
        placeholder.textContent = `[Missing: ${variableName}]`;
        placeholder.classList.add('missing');
        placeholder.title = result.error ?? 'Unknown error';
        return;
      }
      const value = Array.isArray(result.value)
        ? result.value.map(String).join(', ')
        : String(result.value);
      placeholder.textContent = applyVariableTextCase(
        value,
        tokenTextCase ?? this.registry.getVariable(variableName)?.textCase,
      );
    } catch {
      if (!this.enabled) return;
      placeholder.textContent = `[Missing: ${variableName}]`;
      placeholder.classList.add('missing');
    }
  }

  private async showInfoCard(state: HoverState): Promise<void> {
    if (!this.enabled
      || this.hoverState !== state
      || !this.registry.plugin.settings.enableInfoCards
      || (state.livePreview && this.registry.plugin.settings.disableLivePreviewHover)) return;
    const { token, name } = state;
    if (!token.isConnected || !token.matches(':hover')) return;
    const definition = this.registry.getVariable(name);
    if (!definition?.card || !getActiveCardBlocks(definition.card).length) return;
    if (state.livePreview && definition.card.disableLivePreviewHover) return;
    const rawSource = getVariableType(definition) === 'fixed'
      ? definition.link ?? ''
      : definition.file;
    const filePath = filePathFromLink(rawSource);
    const sourcePath = filePath ? `${filePath}.md` : '';
    const card = sourcePath
      ? definition.card
      : { ...definition.card, showSourceLink: false };
    await this.infoCard.showFor(
      token,
      sourcePath,
      card,
      { clientX: state.clientX, clientY: state.clientY },
    );
  }

  private clearHoverState(): void {
    const timer = this.hoverState?.timer;
    if (typeof timer === 'number') window.clearTimeout(timer);
    this.hoverState = null;
  }

  private clearHoverExitTimer(): void {
    if (this.hoverExitTimer !== null) window.clearTimeout(this.hoverExitTimer);
    this.hoverExitTimer = null;
  }
}

export default Renderer;
