import { ItemView, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type VariableLinksPlugin from './main';

export const VIEW_TYPE_MANAGEMENT_CENTER = 'variable-links-management-center';

type ManagementActivity = 'variables';

interface ManagementCenterState {
  activity: ManagementActivity;
}

export class ManagementCenterView extends ItemView {
  private active = false;
  private state: ManagementCenterState = { activity: 'variables' };

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VariableLinksPlugin,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_MANAGEMENT_CENTER;
  }

  getDisplayText(): string {
    return 'Variable links management center';
  }

  getIcon(): string {
    return 'database';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), activity: this.state.activity };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.state = { activity: readActivity(state) };
    await super.setState(state, result);
    this.refresh();
  }

  async onOpen(): Promise<void> {
    this.active = true;
    this.contentEl.addClass('variable-links-management-center');
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.active = false;
    this.contentEl.empty();
  }

  refresh(): void {
    if (!this.active) return;
    const registry = this.plugin.registry;
    const entries = registry ? [...registry.data.values()] : [];
    const managed = entries.filter((definition) => definition.managed).length;
    const manual = entries.length - managed;

    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: 'variable-links-management-center-header' });
    header.createEl('h2', { text: 'Variable links management center' });
    header.createEl('p', {
      text: 'Manage variable links and related plugin data from one workspace tab.',
      cls: 'variable-links-hint-text',
    });

    const tabs = this.contentEl.createDiv({
      cls: 'variable-links-management-center-tabs',
      attr: { role: 'tablist', 'aria-label': 'Management activities' },
    });
    const variablesTab = tabs.createEl('button', {
      text: 'Variables',
      cls: 'variable-links-management-center-tab is-active',
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': 'true',
      },
    });
    variablesTab.addEventListener('click', () => {
      this.state.activity = 'variables';
    });

    const content = this.contentEl.createDiv({
      cls: 'variable-links-management-center-content',
      attr: { role: 'tabpanel', 'aria-label': 'Variables' },
    });
    content.createEl('h3', { text: 'Variable links' });
    const summary = content.createDiv({ cls: 'variable-links-management-center-summary' });
    this.addSummaryItem(summary, 'Total', entries.length);
    this.addSummaryItem(summary, 'Manual', manual);
    this.addSummaryItem(summary, 'Managed', managed);
    content.createEl('p', {
      text: 'The searchable registry list and selection controls are coming in the next checkpoint.',
      cls: 'variable-links-hint-text',
    });
  }

  private addSummaryItem(parent: HTMLElement, label: string, value: number): void {
    const item = parent.createDiv({ cls: 'variable-links-management-center-summary-item' });
    item.createSpan({ text: label, cls: 'variable-links-hint-text' });
    item.createEl('strong', { text: String(value) });
  }
}

function readActivity(state: unknown): ManagementActivity {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 'variables';
  const activity = (state as Record<string, unknown>).activity;
  if (activity === 'variables') return activity;
  return 'variables';
}
