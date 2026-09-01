import { Modal, setIcon } from 'obsidian';
import type VariableLinksPlugin from './main';

type ContextHelpRenderer = (parent: HTMLElement) => void | (() => void);

class ContextHelpModal extends Modal {
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly plugin: VariableLinksPlugin,
    private readonly title: string,
    private readonly origin: HTMLElement,
    private readonly renderContent: ContextHelpRenderer,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.plugin.trackDialog(this);
    this.modalEl.addClass('variable-links-context-help-modal');
    this.contentEl.createEl('h3', { text: this.title });
    this.cleanup = this.renderContent(this.contentEl) ?? null;
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Close', attr: { type: 'button' } })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.plugin.releaseDialog(this);
    this.contentEl.empty();
    if (this.origin.isConnected) this.origin.focus();
  }
}

export function openContextHelp(
  plugin: VariableLinksPlugin,
  title: string,
  origin: HTMLElement,
  renderContent: ContextHelpRenderer,
): void {
  new ContextHelpModal(plugin, title, origin, renderContent).open();
}

export function addContextHelpButton(
  parent: HTMLElement,
  plugin: VariableLinksPlugin,
  title: string,
  renderContent: ContextHelpRenderer,
): () => void {
  parent.addClass('variable-links-context-help-label');
  const button = parent.createEl('button', {
    cls: 'clickable-icon variable-links-context-help-button',
    attr: {
      type: 'button',
      'aria-label': `${title} help`,
      title: `${title} help`,
    },
  });
  setIcon(button, 'circle-help');
  const open = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    openContextHelp(plugin, title, button, renderContent);
  };
  button.addEventListener('click', open);
  return () => button.removeEventListener('click', open);
}
