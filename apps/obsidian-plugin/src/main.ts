import {
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import type { RevisionRecord } from './activity/activity';
import { buildActivityViewModel } from './runtime/activity-render';
import {
  buildConnectionPanel,
  formatStatusBar,
  type ConnectionPanelView,
  type ConnectionStatus,
  type StatusBarView,
} from './runtime/status';
import {
  approvePendingDeviceForOwner,
  connectFromInput,
  createInvitationForOwner,
  startHavemindConnection,
  type ConnectionHandle,
} from './runtime/obsidian-adapters';
import type { CreatedInvitation } from './runtime/create-invitation';
import {
  browserClipboardCopyDeps,
  copyTextToClipboard,
} from './runtime/clipboard';

export const HAVEMIND_ACTIVITY_VIEW = 'havemind-activity';
export const HAVEMIND_ONBOARDING_VIEW = 'havemind-onboarding';

const EMPTY_ACTIVITY_TEXT =
  'Connect a disposable vault to begin the private pilot.';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

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

/** A device the owner minted an invitation for and can now approve. */
export interface PendingApprovalEntry {
  /** Server-issued invitation id (a UUID, not a secret). */
  readonly invitationId: string;
  /** ISO-8601 expiry of the invitation. */
  readonly expiresAt: string;
}

/** Model for the owner "Approve pending device" surface (F8-02d gap 2). */
export interface ApprovalViewModel {
  readonly pending: readonly PendingApprovalEntry[];
}

/** Injected data + actions for the onboarding surface. */
export interface OnboardingViewOptions {
  readonly invitationProvider?: () => CreatedInvitation | null;
  /** Live connection indicator model; defaults to the disconnected panel. */
  readonly panelProvider?: () => ConnectionPanelView;
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
  /** Stop the live sync loop so the paste form returns. */
  readonly onDisconnect?: () => void;
  /** Copy the rendered invitation envelope to the clipboard (never logged). */
  readonly onCopyInvitation?: (envelope: string) => void;
  /**
   * Owner-approval model; when it returns non-null the approval form is shown
   * instead of the connect/invitation surfaces.
   */
  readonly approvalProvider?: () => ApprovalViewModel | null;
  /** Approve the joining device that read out the given verification phrase. */
  readonly onApprove?: (
    invitationId: string,
    verificationPhrase: string,
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
    this.render();
  }

  /** Re-renders from the current panel state — called on every status change. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();

    const approval = this.options.approvalProvider?.() ?? null;
    if (approval) {
      this.renderApproval(content, approval);
      return;
    }

    content.createEl('h3', { text: 'Connect to Havemind' });

    const invitation = this.options.invitationProvider?.() ?? null;
    if (invitation) {
      this.renderInvitation(content, invitation);
      return;
    }

    const panel =
      this.options.panelProvider?.() ??
      buildConnectionPanel({ status: 'disconnected' });
    this.renderIndicator(content, panel);

    if (panel.showForm) {
      this.renderForm(content);
    } else {
      this.renderConnected(content);
    }
  }

  private renderIndicator(content: HTMLElement, panel: ConnectionPanelView): void {
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    if (panel.spin) row.addClass('havemind-status-spin');
    row.style.setProperty('color', `var(${panel.colorToken})`);
    const icon = row.createEl('span');
    setIcon(icon, panel.icon);
    row.createEl('span', { text: ` ${panel.label}` });
    content.createDiv({ text: panel.detail });
  }

  private renderConnected(content: HTMLElement): void {
    const disconnect = content.createEl('button', { text: 'Disconnect' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
  }

  private renderForm(content: HTMLElement): void {
    content.createEl('label', {
      text: 'Invitation or owner pairing token',
    });
    const tokenInput = content.createEl('textarea', {
      placeholder: 'v1.… or hm_pt_…',
    });
    content.createEl('label', { text: 'Server URL' });
    const serverInput = content.createEl('input', {
      type: 'text',
      placeholder: 'https://sapserver.tailnet.ts.net',
    });
    const status = content.createDiv({ text: '' });
    const connect = content.createEl('button', { text: 'Connect' });
    connect.addClass('mod-cta');
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

  private renderInvitation(
    content: HTMLElement,
    invitation: CreatedInvitation,
  ): void {
    content.createDiv({
      text: 'Invitation created. Copy it now — it is single-use and expires in 15 minutes.',
    });
    content.createEl('code', { text: invitation.envelope });
    // Readonly field so the owner can select the envelope by hand if the
    // clipboard copy is unavailable or denied.
    content.createEl('textarea', {
      value: invitation.envelope,
      cls: 'havemind-invite-copy-fallback',
    });
    const status = content.createDiv({ text: '' });
    const copy = content.createEl('button', { text: 'Copy' });
    copy.addClass('mod-cta');
    copy.onClickEvent(() => {
      this.options.onCopyInvitation?.(invitation.envelope);
      status.setText('Copied to clipboard.');
    });
    content.createDiv({ text: `Expires: ${invitation.expiresAt}` });
  }

  private renderApproval(
    content: HTMLElement,
    model: ApprovalViewModel,
  ): void {
    content.createEl('h3', { text: 'Approve pending device' });
    content.createDiv({
      text: 'A device that redeemed an invitation waits for your approval. Confirm the verification phrase it shows out loud, then approve it.',
    });

    if (model.pending.length === 0) {
      content.createDiv({
        text: 'No invitations were created on this device this session. Paste the invitation ID from the server below.',
      });
    } else {
      for (const entry of model.pending) {
        // Icon + label + colour (never colour alone), matching the Connect
        // panel indicator convention.
        const row = content.createDiv({
          text: `Invitation ${entry.invitationId} · expires ${entry.expiresAt}`,
        });
        row.style.setProperty('color', 'var(--text-accent)');
        setIcon(row.createEl('span'), 'user-round-check');
      }
    }

    content.createEl('label', { text: 'Invitation ID' });
    const idInput = content.createEl('input', {
      type: 'text',
      value: model.pending[0]?.invitationId ?? '',
      placeholder: '00000000-0000-0000-0000-000000000000',
    });
    content.createEl('label', {
      text: 'Verification phrase (read aloud by the joining device)',
    });
    const phraseInput = content.createEl('input', {
      type: 'text',
      placeholder: 'three short words',
    });
    const status = content.createDiv({ text: '' });
    const approve = content.createEl('button', { text: 'Approve' });
    approve.addClass('mod-cta');
    approve.onClickEvent(() => {
      const invitationId = (
        idInput as unknown as { value: string }
      ).value.trim();
      const phrase = (phraseInput as unknown as { value: string }).value.trim();
      if (invitationId.length === 0 || phrase.length === 0) {
        status.setText('Enter the invitation ID and the phrase you heard.');
        return;
      }
      status.setText('Approving…');
      this.options.onApprove?.(invitationId, phrase, (message) =>
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
  private pendingApprovals: PendingApprovalEntry[] = [];
  private approvalActive = false;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private lastSyncedAt: number | undefined;
  private connectionError: string | undefined;
  private onboardingView: HavemindOnboardingView | null = null;

  override onload(): void {
    this.registerView(
      HAVEMIND_ACTIVITY_VIEW,
      (leaf: WorkspaceLeaf) =>
        new HavemindActivityView(leaf, this.activityOptions),
    );
    this.registerView(HAVEMIND_ONBOARDING_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindOnboardingView(leaf, {
        invitationProvider: () => this.pendingInvitation,
        panelProvider: () => this.connectionPanel(),
        onConnect: (input, serverUrl, report) => {
          void this.connectFromInput(input, serverUrl, report);
        },
        onDisconnect: () => this.disconnect(),
        onCopyInvitation: (envelope) => {
          // Move the secret into the clipboard; never log the envelope.
          void copyTextToClipboard(envelope, browserClipboardCopyDeps());
        },
        approvalProvider: () =>
          this.approvalActive ? { pending: this.pendingApprovals } : null,
        onApprove: (invitationId, verificationPhrase, report) => {
          void this.approvePendingDevice(invitationId, verificationPhrase, report);
        },
      });
      this.onboardingView = view;
      return view;
    });

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
    this.addCommand({
      id: 'approve-pending-device',
      name: 'Approve pending device',
      callback: () => this.openApprovalView(),
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
    this.approvalActive = false;
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /** Owner action: open the approval surface for pending devices. */
  private openApprovalView(): Promise<void> {
    this.approvalActive = true;
    this.onboardingView?.refresh();
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /**
   * Owner action: approve the joining device that read out `verificationPhrase`
   * against `POST …/invitations/:invitationId/approve`. The phrase is a
   * second-channel secret and is never logged; failures are reported to the view.
   */
  private async approvePendingDevice(
    invitationId: string,
    verificationPhrase: string,
    report: ConnectReporter,
  ): Promise<void> {
    try {
      const approved = await approvePendingDeviceForOwner(this, {
        invitationId,
        verificationPhrase,
      });
      if (approved === null) {
        report('Connect as the vault owner before approving a device.');
        return;
      }
      this.pendingApprovals = this.pendingApprovals.filter(
        (entry) => entry.invitationId !== invitationId,
      );
      report('Device approved. It can now sync.');
    } catch (error) {
      report(
        `Could not approve: ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  private async startConnection(): Promise<void> {
    this.connection = await startHavemindConnection(this, (status, view) =>
      this.handleStatus(status, view),
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
      onStatus: (status, view) => this.handleStatus(status, view),
    });
    if (handle !== null) {
      this.connection?.stop();
      this.connection = handle;
    }
  }

  /** Stops the live sync loop; the paste form returns so the user can reconnect. */
  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.connectionStatus = 'disconnected';
    this.lastSyncedAt = undefined;
    this.connectionError = undefined;
    this.setStatus(formatStatusBar({ status: 'disconnected' }));
    this.onboardingView?.refresh();
  }

  /** Updates the status bar and live Connect indicator from a cycle status. */
  private handleStatus(status: ConnectionStatus, view: StatusBarView): void {
    this.connectionStatus = status;
    if (status === 'synced') {
      this.lastSyncedAt = Date.now();
      this.connectionError = undefined;
    }
    if (status === 'reconnect-required') {
      this.connectionError = 'The server refused the session — reconnect.';
    }
    this.setStatus(view);
    this.onboardingView?.refresh();
  }

  private connectionPanel(): ConnectionPanelView {
    return buildConnectionPanel({
      status: this.connectionStatus,
      serverName: this.connection?.serverName ?? '',
      reducedMotion: prefersReducedMotion(),
      ...(this.lastSyncedAt === undefined
        ? {}
        : { lastSyncedAt: this.lastSyncedAt }),
      ...(this.connectionError === undefined
        ? {}
        : { errorMessage: this.connectionError }),
    });
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
