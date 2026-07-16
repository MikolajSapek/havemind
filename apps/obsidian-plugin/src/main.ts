import {
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import type { RevisionRecord } from './activity/activity';
import { buildActivityViewModel } from './runtime/activity-render';
import { formatStatusBar, type StatusBarView } from './runtime/status';
import {
  connectFromInput,
  createInvitationForOwner,
  startHavemindConnection,
  type ConnectionHandle,
} from './runtime/obsidian-adapters';
import type { CreatedInvitation } from './runtime/create-invitation';

export const HAVEMIND_ACTIVITY_VIEW = 'havemind-activity';
export const HAVEMIND_ONBOARDING_VIEW = 'havemind-onboarding';

const EMPTY_ACTIVITY_TEXT =
  'Connect a disposable vault to begin the private pilot.';

/** Injected data + actions for the Activity surface (F5-01 feed + restore). */
export interface ActivityViewOptions {
  readonly feedProvider?: () => readonly RevisionRecord[];
  readonly onRestore?: (revisionId: string) => void;
}

class HavemindActivityView extends ItemView {
  private readonly options: ActivityViewOptions;

  constructor(leaf: WorkspaceLeaf, options: ActivityViewOptions = {}) {
    super(leaf);
    this.options = options;
  }

  override getDisplayText(): string {
    return 'Havemind activity';
  }

  override getIcon(): string {
    return 'users-round';
  }

  override getViewType(): string {
    return HAVEMIND_ACTIVITY_VIEW;
  }

  override onOpen(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.createEl('h3', { text: 'Havemind activity' });

    const model = buildActivityViewModel(this.options.feedProvider?.() ?? []);
    if (model.empty) {
      content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
      return;
    }

    for (const row of model.rows) {
      const entry = content.createDiv({ text: row.label });
      if (row.canRestore && this.options.onRestore) {
        const restore = entry.createEl('button', { text: 'Restore' });
        restore.onClickEvent(() => this.options.onRestore?.(row.revisionId));
      }
    }
  }
}

/** Report a human-readable connect-flow state back to the onboarding view. */
export type ConnectReporter = (message: string) => void;

/** Injected data + actions for the onboarding surface. */
export interface OnboardingViewOptions {
  readonly invitationProvider?: () => CreatedInvitation | null;
  /**
   * Runs the connect flow for the pasted input (invitation envelope `v1.…` or
   * owner pairing token `hm_pt_…`) against the given server URL, reporting
   * progress messages back to the view.
   */
  readonly onConnect?: (
    input: string,
    serverUrl: string,
    report: ConnectReporter,
  ) => void;
}

export class HavemindOnboardingView extends ItemView {
  private readonly options: OnboardingViewOptions;

  constructor(leaf: WorkspaceLeaf, options: OnboardingViewOptions = {}) {
    super(leaf);
    this.options = options;
  }

  override getDisplayText(): string {
    return 'Connect to Havemind';
  }

  override getIcon(): string {
    return 'link';
  }

  override getViewType(): string {
    return HAVEMIND_ONBOARDING_VIEW;
  }

  override onOpen(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.createEl('h3', { text: 'Connect to Havemind' });

    const invitation = this.options.invitationProvider?.() ?? null;
    if (invitation) {
      content.createDiv({
        text: 'Invitation created. Copy it now — it is single-use and expires in 15 minutes.',
      });
      content.createEl('code', { text: invitation.envelope });
      content.createDiv({ text: `Expires: ${invitation.expiresAt}` });
      return;
    }

    content.createDiv({
      text: 'Paste an invitation (v1.…) or your owner pairing token (hm_pt_…).',
    });
    const tokenInput = content.createEl('textarea', {
      placeholder: 'v1.… or hm_pt_…',
    });
    const serverInput = content.createEl('input', {
      type: 'text',
      placeholder: 'Server URL (e.g. https://sapserver.tailnet.ts.net)',
    });
    const status = content.createDiv({ text: '' });
    const connect = content.createEl('button', { text: 'Connect' });
    connect.onClickEvent(() => {
      const input = (tokenInput as unknown as { value: string }).value.trim();
      const serverUrl = (serverInput as unknown as { value: string }).value.trim();
      if (input.length === 0) {
        status.setText('Paste an invitation or pairing token first.');
        return;
      }
      status.setText('Connecting…');
      this.options.onConnect?.(input, serverUrl, (message) =>
        status.setText(message),
      );
    });
  }
}

class HavemindSettingTab extends PluginSettingTab {
  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl).setName('Havemind').setHeading();
    new Setting(this.containerEl)
      .setName('Connection')
      .setDesc('Not connected. Onboarding will be added in the next slice.');
  }
}

export default class HavemindPlugin extends Plugin {
  private activityOptions: ActivityViewOptions = {};
  private statusItem: HTMLElement | null = null;
  private connection: ConnectionHandle | null = null;
  private pendingInvitation: CreatedInvitation | null = null;

  override onload(): void {
    this.registerView(
      HAVEMIND_ACTIVITY_VIEW,
      (leaf: WorkspaceLeaf) =>
        new HavemindActivityView(leaf, this.activityOptions),
    );
    this.registerView(
      HAVEMIND_ONBOARDING_VIEW,
      (leaf: WorkspaceLeaf) =>
        new HavemindOnboardingView(leaf, {
          invitationProvider: () => this.pendingInvitation,
          onConnect: (input, serverUrl, report) => {
            void this.connectFromInput(input, serverUrl, report);
          },
        }),
    );

    this.addCommand({
      id: 'open-activity',
      name: 'Open activity',
      callback: () => this.openActivityView(),
    });
    this.addCommand({
      id: 'connect',
      name: 'Connect to Havemind',
      callback: () => this.openConnectView(),
    });
    this.addCommand({
      id: 'create-invitation',
      name: 'Create invitation (owner)',
      callback: () => this.createInvitation(),
    });

    this.addRibbonIcon('users-round', 'Open Havemind activity', () => {
      void this.openActivityView();
    });

    this.statusItem = this.addStatusBarItem();
    this.setStatus(formatStatusBar({ status: 'disconnected' }));

    this.addSettingTab(new HavemindSettingTab(this.app, this));

    this.registerEditorExtension([]);
    this.registerMarkdownPostProcessor(() => undefined);
    this.registerObsidianProtocolHandler('havemind-join', (data) => {
      // The secret invitation is never accepted from the URI query. Only the
      // parameter-free passive URI opens the local paste wizard; any query
      // field (token, envelope, secret, or otherwise) is refused.
      if (!isSafePassiveJoinProtocolData(data)) return;
      void this.openView(HAVEMIND_ONBOARDING_VIEW);
    });

    // On layout-ready, resume any stored onboarding to `connected` and start
    // the live sync loop. When there is no connection this reports disconnected
    // and starts nothing, so the loaded-but-disconnected shell stays passive.
    this.app.workspace.onLayoutReady(() => {
      void this.startConnection();
    });
  }

  override onunload(): void {
    this.connection?.stop();
    this.connection = null;
    this.app.workspace.detachLeavesOfType(HAVEMIND_ACTIVITY_VIEW);
    this.app.workspace.detachLeavesOfType(HAVEMIND_ONBOARDING_VIEW);
  }

  private openConnectView(): Promise<void> {
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  private async startConnection(): Promise<void> {
    this.connection = await startHavemindConnection(this, (view) =>
      this.setStatus(view),
    );
  }

  /**
   * Drives the Connect form: classifies the pasted input (invitation envelope or
   * owner pairing token), runs the matching flow, and once connected starts the
   * live sync loop. Progress is reported back to the view; secrets are never
   * logged.
   */
  private async connectFromInput(
    input: string,
    serverUrl: string,
    report: ConnectReporter,
  ): Promise<void> {
    const handle = await connectFromInput(this, input, serverUrl, {
      report,
      onStatus: (view) => this.setStatus(view),
    });
    if (handle !== null) {
      this.connection?.stop();
      this.connection = handle;
    }
  }

  /**
   * Owner action: create an invitation for the connected vault and show the
   * copyable envelope in the onboarding view. The envelope (a secret) is only
   * rendered for the owner to copy — never written to logs.
   */
  private async createInvitation(): Promise<void> {
    const invitation = await createInvitationForOwner(this, {
      intendedRole: 'editor',
    });
    if (invitation === null) return;
    this.setPendingInvitation(invitation);
    await this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /** Stores the created invitation so the onboarding view can display it. */
  setPendingInvitation(invitation: CreatedInvitation | null): void {
    this.pendingInvitation = invitation;
  }

  private setStatus(view: StatusBarView): void {
    this.statusItem?.setText(view.text);
  }

  /** Supplies the Activity view with a live feed and a restore action. */
  setActivityOptions(options: ActivityViewOptions): void {
    this.activityOptions = options;
  }

  private openActivityView(): Promise<void> {
    return this.openView(HAVEMIND_ACTIVITY_VIEW);
  }

  private async openView(type: string): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(type)[0];
    const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    if (!existingLeaf) {
      await leaf.setViewState({
        active: true,
        type,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }
}
