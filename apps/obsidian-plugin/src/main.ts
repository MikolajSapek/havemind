import {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import type { RevisionRecord } from './activity/activity';
import { buildActivityViewModel } from './runtime/activity-render';
import { restoreActivityEntry } from './runtime/activity-restore';
import {
  ActivityLog,
  activityEntriesToRecords,
  type ActivityLogEntry,
} from './runtime/activity-log';
import {
  buildRosterView,
  RosterStore,
  type MemberRole,
  type RosterMember,
  type RosterView,
} from './runtime/roster';
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
import { ApproveDeviceError } from './runtime/approve-device';
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

/** Compact local time for an activity row (e.g. "16 Jul, 15:42"). */
function formatActivityTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/**
 * Renders the "Connected" presence roster: one row per persistent member with a
 * green dot + a "connected" text label (never colour alone) + the member's
 * stable colour. Presence is CONNECTION STATE — a member stays connected until
 * an explicit teardown, never derived from activity.
 */
function renderRosterList(content: HTMLElement, roster: RosterView): void {
  content.createEl('h4', { text: 'Connected' });
  if (roster.empty) {
    content.createDiv({
      text: 'No members yet. Approved devices appear here as connected.',
    });
    return;
  }
  for (const row of roster.rows) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-roster-row');
    // Green connected dot, coloured by the member's stable token — paired with
    // the "connected" text label so colour is never the only signal.
    const dot = item.createEl('span');
    dot.addClass('havemind-roster-dot');
    dot.style.setProperty('color', `var(${row.colorToken})`);
    setIcon(dot, 'circle');
    const name = row.self ? `${row.displayName} (you)` : row.displayName;
    item.createEl('span', {
      text: ` ${name} · ${row.role} · connected`,
    });
    // FUTURE (seam, not built now): when a known contact's connection is torn
    // down (revoke) their row should offer a "Rejoin" button that re-admits
    // them without re-running the full pairing flow. Do not implement here.
  }
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
    this.render();
  }

  /** Re-renders from the live feed — called when the activity log changes. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.createEl('h3', { text: 'Havemind activity' });

    const model = buildActivityViewModel(this.options.feedProvider?.() ?? [], {
      formatTimestamp: formatActivityTime,
    });
    if (model.empty) {
      content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
      return;
    }

    for (const row of model.rows) {
      const entry = content.createDiv({ text: row.label });
      entry.addClass('havemind-activity-row');
      // Author colour as a left accent, paired with the author name already in
      // the label — colour is never the only signal (accessibility rule).
      entry.style.setProperty('--havemind-row-color', `var(${row.colorToken})`);
      // The Restore button stays the first child so the F5 restore contract is
      // unchanged; the time is appended after it.
      if (row.canRestore && this.options.onRestore) {
        const restore = entry.createEl('button', { text: 'Restore' });
        restore.onClickEvent(() => this.options.onRestore?.(row.revisionId));
      }
      const time = entry.createEl('span', { text: ` ${row.timeLabel}` });
      time.addClass('havemind-activity-time');
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
  /** Name the owner gave the intended member (e.g. "Magda"), if any. */
  readonly intendedMemberDisplayName?: string;
  /** Role the invitation was minted for; carried into the roster on approval. */
  readonly intendedRole?: MemberRole;
}

/** The invitee role the owner mints an invitation for. */
export type InvitationRole = 'editor' | 'owner';

/**
 * Single-panel model for the owner "Create connection" surface: the create
 * section (role + name + last-minted envelope) and the live waiting section
 * (devices awaiting approval) live together and never tear each other down.
 */
export interface CreateConnectionViewModel {
  /** Default role for the select on first render. */
  readonly role: InvitationRole;
  /** Default intended-member name for the input on first render. */
  readonly name: string;
  /** The most recently minted invitation, shown with a Copy button. */
  readonly invitation: CreatedInvitation | null;
  /** Devices waiting for the owner to approve them. */
  readonly pending: readonly PendingApprovalEntry[];
  /** True once the minted invitation is past its expiry (single-use, ~15 min). */
  readonly invitationExpired?: boolean;
  /** Transient confirmation line (e.g. "Invitation created."), if any. */
  readonly notice?: string;
  /**
   * Visual treatment for `notice`. 'success' renders the icon+label+colour
   * status-row convention (never colour alone); omitted/'info' renders the
   * plain text line used for routine progress messages.
   */
  readonly noticeKind?: 'info' | 'success';
}

/**
 * Durable guest-side state while waiting for the owner to approve this device.
 * Held in plugin state (not the ephemeral status line) so closing and reopening
 * the pane resumes the waiting screen instead of drawing a blank paste form —
 * which would tempt the guest into re-pasting a single-use invitation.
 */
export interface GuestWaitingViewModel {
  /** The phrase this device must read aloud to the owner. */
  readonly verificationPhrase: string;
}

/** Injected data + actions for the onboarding surface. */
export interface OnboardingViewOptions {
  /**
   * Owner "Create connection" composer model; when it returns non-null the
   * unified create + approve panel is shown instead of the guest connect
   * surfaces. Both sections render together so approving never unmounts create.
   */
  readonly composerProvider?: () => CreateConnectionViewModel | null;
  /**
   * Guest-side waiting model; when it returns non-null the "waiting for the
   * owner to approve" screen is shown (carrying the verification phrase) instead
   * of the paste form, so a pane reopen resumes the wait rather than re-prompting.
   */
  readonly guestWaitingProvider?: () => GuestWaitingViewModel | null;
  /**
   * When it returns true the guest sees a terminal "invitation no longer valid"
   * screen (with the paste form to try a fresh invite). Set after a server
   * rejection/lockout so the waiting screen is never left offline or blank.
   */
  readonly guestInvalidProvider?: () => boolean;
  /** Live connection indicator model; defaults to the disconnected panel. */
  readonly panelProvider?: () => ConnectionPanelView;
  /**
   * Presence roster (who is connected). Rendered in the owner composer and in
   * the connected panel so both the owner and the invitee see a clear
   * "Connected" list. Presence is persistent connection state, never activity.
   */
  readonly rosterProvider?: () => RosterView;
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
  /** Mint an invitation for the given role and intended-member name. */
  readonly onCreateInvitation?: (
    role: InvitationRole,
    name: string,
    report: ConnectReporter,
  ) => void;
  /** Dismiss the minted-invitation display (clears the dead-end envelope). */
  readonly onDismissInvitation?: () => void;
  /** Approve the joining device that read out the given verification phrase. */
  readonly onApprove?: (
    invitationId: string,
    verificationPhrase: string,
    report: ConnectReporter,
  ) => void;
}

export class HavemindOnboardingView extends ItemView {
  private readonly options: OnboardingViewOptions;
  /**
   * In-progress typed input that must survive a re-render. A status change can
   * re-render the view while the owner/guest is mid-typing; capturing these
   * before `empty()` and restoring them after keeps the flow resumable rather
   * than discarding work the user still needs.
   */
  private readonly draft: {
    token: string;
    server: string;
    role: InvitationRole;
    name: string;
  } = { token: '', server: '', role: 'editor', name: '' };
  /** Live input elements from the current render, read during the next one. */
  private liveInputs: {
    token?: HTMLElement;
    server?: HTMLElement;
    role?: HTMLElement;
    name?: HTMLElement;
  } = {};

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

    // Snapshot any typed-but-unsubmitted input before tearing the DOM down, so
    // a re-render (create → approve, status change) never loses in-progress work.
    this.captureDrafts();
    content.empty();
    this.liveInputs = {};

    const composer = this.options.composerProvider?.() ?? null;
    if (composer) {
      this.renderCreateConnection(content, composer);
      return;
    }

    // A server rejection/lockout takes precedence over the waiting screen: the
    // invitation is spent, so we never leave the guest waiting or offline.
    if (this.options.guestInvalidProvider?.() === true) {
      this.renderGuestInvalid(content);
      return;
    }

    const waiting = this.options.guestWaitingProvider?.() ?? null;
    if (waiting) {
      this.renderGuestWaiting(content, waiting);
      return;
    }

    content.createEl('h3', { text: 'Connect to Havemind' });

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

  /** Reads live input values into `draft` so the next render can restore them. */
  private captureDrafts(): void {
    const live = this.liveInputs;
    if (live.token) this.draft.token = live.token.value;
    if (live.server) this.draft.server = live.server.value;
    if (live.role) this.draft.role = live.role.value === 'owner' ? 'owner' : 'editor';
    if (live.name) this.draft.name = live.name.value;
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
    // Presence roster makes "connected" unambiguous for the invitee (and owner):
    // once approval succeeds the panel clearly lists who is connected.
    const roster = this.options.rosterProvider?.();
    if (roster !== undefined) {
      renderRosterList(content, roster);
    }
    const disconnect = content.createEl('button', { text: 'Disconnect' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
  }

  /**
   * Guest waiting screen: the invitation is already redeemed and this device is
   * waiting for the owner to approve it. The verification phrase is shown so it
   * survives a pane close/reopen; no paste form is drawn (re-pasting would try
   * to re-redeem a single-use invitation).
   */
  private renderGuestWaiting(
    content: HTMLElement,
    model: GuestWaitingViewModel,
  ): void {
    content.createEl('h3', { text: 'Connecting to Havemind' });
    // Icon + label + colour (never colour alone), matching the panel convention.
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-accent)');
    setIcon(row.createEl('span'), 'loader');
    row.createEl('span', { text: ' Waiting for the other device to approve…' });
    content.createDiv({
      text: 'Read this 6-digit code to the vault owner.',
    });
    const phrase = content.createDiv({ text: model.verificationPhrase });
    phrase.addClass('havemind-verification-phrase');
    content.createDiv({
      text: 'Keep Obsidian open — this resumes automatically once approved.',
    });
    const disconnect = content.createEl('button', { text: 'Cancel' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
  }

  /**
   * Terminal guest screen after the owner rejected this device or the 3-attempt
   * cap was reached. The invitation is spent, so we present a clear message plus
   * the paste form to try a fresh invite — never offline, never a blank form.
   */
  private renderGuestInvalid(content: HTMLElement): void {
    content.createEl('h3', { text: 'Connect to Havemind' });
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-error)');
    setIcon(row.createEl('span'), 'alert-triangle');
    row.createEl('span', { text: ' This invitation is no longer valid' });
    content.createDiv({
      text: 'Ask the vault owner for a new invitation, then paste it below.',
    });
    this.renderForm(content);
  }

  private renderForm(content: HTMLElement): void {
    content.createEl('label', {
      text: 'Invitation or owner pairing token',
    });
    const tokenInput = content.createEl('textarea', {
      placeholder: 'v1.… or hm_pt_…',
      value: this.draft.token,
    });
    content.createEl('label', { text: 'Server URL' });
    const serverInput = content.createEl('input', {
      type: 'text',
      placeholder: 'https://sapserver.tailnet.ts.net',
      value: this.draft.server,
    });
    this.liveInputs.token = tokenInput;
    this.liveInputs.server = serverInput;
    const status = content.createDiv({ text: '' });
    const connect = content.createEl('button', { text: 'Connect' });
    connect.addClass('mod-cta');
    connect.onClickEvent(() => {
      const input = tokenInput.value.trim();
      const serverUrl = serverInput.value.trim();
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

  /**
   * The unified owner "Create connection" panel. The create section (role +
   * name + Create invitation, plus the minted envelope with Copy) and the live
   * "waiting for the other device" section render together in one surface;
   * approving a waiting device never unmounts the create section.
   */
  private renderCreateConnection(
    content: HTMLElement,
    model: CreateConnectionViewModel,
  ): void {
    content.createEl('h3', { text: 'Creating connection' });
    if (model.notice) this.renderNotice(content, model.notice, model.noticeKind);

    this.renderCreateSection(content, model);

    // The persistent "Connected" roster — who is already a member of this vault.
    const roster = this.options.rosterProvider?.();
    if (roster !== undefined && !roster.empty) {
      const rosterDivider = content.createEl('hr');
      rosterDivider.addClass('havemind-divider');
      renderRosterList(content, roster);
    }

    const divider = content.createEl('hr');
    divider.addClass('havemind-divider');

    content.createEl('h4', { text: 'Waiting for the other device' });
    if (model.pending.length === 0) {
      content.createDiv({
        text: 'No device is waiting yet. When the other device redeems the invite, it appears here to approve.',
      });
      return;
    }
    for (const entry of model.pending) {
      this.renderPendingRow(content, entry);
    }
  }

  private renderCreateSection(
    content: HTMLElement,
    model: CreateConnectionViewModel,
  ): void {
    content.createEl('label', { text: 'Role' });
    const roleSelect = content.createEl('select');
    for (const value of ['editor', 'owner'] as const) {
      roleSelect.createEl('option', { text: value, value });
    }
    roleSelect.value = this.draft.role || model.role;

    content.createEl('label', { text: 'Name' });
    const nameInput = content.createEl('input', {
      type: 'text',
      placeholder: 'e.g. Magda',
      value: this.draft.name || model.name,
    });
    this.liveInputs.role = roleSelect;
    this.liveInputs.name = nameInput;

    const status = content.createDiv({ text: '' });
    const create = content.createEl('button', { text: 'Create invitation' });
    create.addClass('mod-cta');
    create.onClickEvent(() => {
      const role: InvitationRole = roleSelect.value === 'owner' ? 'owner' : 'editor';
      const name = nameInput.value.trim();
      status.setText('Creating invitation…');
      this.options.onCreateInvitation?.(role, name, (message) =>
        status.setText(message),
      );
    });

    if (model.invitation === null) return;
    const envelope = model.invitation.envelope;

    if (model.invitationExpired === true) {
      // No dead-end: an expired single-use invite can never be redeemed, so the
      // envelope is withheld and the owner is pointed back to Create invitation.
      content.createDiv({
        text: 'This invitation expired. Create a new one above to invite the other device.',
      });
      const dismiss = content.createEl('button', { text: 'Done' });
      dismiss.onClickEvent(() => this.options.onDismissInvitation?.());
      return;
    }

    content.createDiv({
      text: 'Invite created — copy it and send it to the other device. Single-use, expires in 15 minutes.',
    });
    content.createEl('code', { text: envelope });
    // Readonly field so the owner can select the envelope by hand if the
    // clipboard copy is unavailable or denied.
    content.createEl('textarea', {
      value: envelope,
      cls: 'havemind-invite-copy-fallback',
    });
    const copyStatus = content.createDiv({ text: '' });
    const copy = content.createEl('button', { text: 'Copy' });
    copy.addClass('mod-cta');
    copy.onClickEvent(() => {
      this.options.onCopyInvitation?.(envelope);
      copyStatus.setText('Copied to clipboard.');
    });
    content.createDiv({ text: `Expires: ${model.invitation.expiresAt}` });
    // Done clears the envelope display so it is not a permanent dead-end.
    const dismiss = content.createEl('button', { text: 'Done' });
    dismiss.onClickEvent(() => this.options.onDismissInvitation?.());
  }

  /**
   * Renders the composer's transient notice line. 'success' (e.g. a device
   * just connected) uses the icon+label+colour status-row convention shared
   * with the Connect panel indicator — never colour alone; other notices
   * (progress/info) stay a plain text line.
   */
  private renderNotice(
    content: HTMLElement,
    notice: string,
    kind: 'info' | 'success' | undefined,
  ): void {
    if (kind !== 'success') {
      content.createDiv({ text: notice });
      return;
    }
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-success)');
    setIcon(row.createEl('span'), 'check-circle');
    row.createEl('span', { text: ` ${notice}` });
  }

  private renderPendingRow(
    content: HTMLElement,
    entry: PendingApprovalEntry,
  ): void {
    // Icon + label + colour (never colour alone), matching the Connect panel
    // indicator convention.
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-pending-row');
    row.style.setProperty('color', 'var(--text-accent)');
    setIcon(row.createEl('span'), 'user-round-check');
    row.createEl('span', {
      text: ` ${entry.intendedMemberDisplayName ?? 'Pending device'} · expires ${entry.expiresAt}`,
    });
    // The owner never sees the code: they type in what the joining device
    // reads aloud, so the human read-aloud check is meaningful (rule: the code
    // travels only over the out-of-band voice channel).
    row.createEl('label', {
      text: 'Enter the 6-digit code your peer reads to you',
    });
    const phraseInput = row.createEl('input', {
      type: 'text',
      placeholder: '123456',
      attr: { inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*' },
    });
    const status = row.createDiv({ text: '' });
    const approve = row.createEl('button', { text: 'Approve' });
    approve.addClass('mod-cta');
    approve.onClickEvent(() => {
      const phrase = phraseInput.value.trim();
      if (phrase.length === 0) {
        status.setText('Enter the code you heard, then approve.');
        return;
      }
      status.setText('Approving…');
      // The row is not re-rendered on a wrong code, so the input keeps its
      // value and focus and the owner can simply correct the code and retry.
      this.options.onApprove?.(entry.invitationId, phrase, (message) =>
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
  private connectionActive = false;
  private connectionNotice: string | undefined;
  /** Visual treatment for `connectionNotice`; see CreateConnectionViewModel. */
  private connectionNoticeKind: 'info' | 'success' | undefined;
  private awaitingApproval: GuestWaitingViewModel | null = null;
  /**
   * True once the server reported this invitation is dead (owner rejected the
   * device or the 3-attempt cap was reached). Shows the "ask for a new invite"
   * screen instead of the waiting screen — never offline, never a blank form.
   */
  private guestInvitationInvalid = false;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private lastSyncedAt: number | undefined;
  private connectionError: string | undefined;
  private onboardingView: HavemindOnboardingView | null = null;
  private activityView: HavemindActivityView | null = null;
  /** Live feed behind the Activity view (previously orphaned — now wired). */
  private readonly activityLog = new ActivityLog();
  /** Disposer for the activityLog subscription set up in onload(); torn down in onunload(). */
  private activityLogUnsubscribe: (() => void) | null = null;
  /**
   * Persistent presence roster: the members connected to this vault. Sourced
   * from approve-time records + the local self membership and persisted in
   * data.json (endpoint-free). Never derived from sync activity.
   */
  private rosterMembers: RosterMember[] = [];

  override onload(): void {
    // Wire the Activity view to the live feed: the log snapshot is mapped through
    // the roster so each row shows the author's display name + colour. Without
    // this the view was orphaned and always rendered the empty placeholder.
    this.activityOptions = {
      feedProvider: () =>
        activityEntriesToRecords(this.activityLog.snapshot(), this.rosterMembers),
      onRestore: (revisionId) => this.handleRestore(revisionId),
    };
    this.activityLogUnsubscribe = this.activityLog.subscribe(() =>
      this.activityView?.refresh(),
    );

    this.registerView(HAVEMIND_ACTIVITY_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindActivityView(leaf, this.activityOptions);
      this.activityView = view;
      return view;
    });
    this.registerView(HAVEMIND_ONBOARDING_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindOnboardingView(leaf, {
        composerProvider: () =>
          this.connectionActive ? this.composerModel() : null,
        guestWaitingProvider: () => this.awaitingApproval,
        guestInvalidProvider: () => this.guestInvitationInvalid,
        panelProvider: () => this.connectionPanel(),
        rosterProvider: () => buildRosterView(this.rosterMembers),
        onConnect: (input, serverUrl, report) => {
          void this.connectFromInput(input, serverUrl, report);
        },
        onDisconnect: () => this.disconnect(),
        onCopyInvitation: (envelope) => {
          // Move the secret into the clipboard; never log the envelope.
          void copyTextToClipboard(envelope, browserClipboardCopyDeps());
        },
        onCreateInvitation: (role, name, report) => {
          void this.createInvitation(role, name, report);
        },
        onDismissInvitation: () => this.dismissInvitation(),
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
    // Single owner entry point: create the invitation and approve the joining
    // device in one living panel (replaces the old create/approve split).
    this.addCommand({
      id: 'create-connection',
      name: 'Create connection (owner)',
      callback: () => this.openCreateConnectionView(),
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
      // A passive join URI belongs to the guest paste wizard, not the owner
      // composer.
      this.connectionActive = false;
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
    this.activityLogUnsubscribe?.();
    this.activityLogUnsubscribe = null;
    this.app.workspace.detachLeavesOfType(HAVEMIND_ACTIVITY_VIEW);
    this.app.workspace.detachLeavesOfType(HAVEMIND_ONBOARDING_VIEW);
  }

  private openConnectView(): Promise<void> {
    this.connectionActive = false;
    this.onboardingView?.refresh();
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /**
   * Owner action: open the unified "Create connection" panel where the invite
   * is minted and the joining device is approved in one living surface.
   */
  private openCreateConnectionView(): Promise<void> {
    this.connectionActive = true;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.onboardingView?.refresh();
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /** Snapshot of the owner composer state for the unified panel. */
  private composerModel(): CreateConnectionViewModel {
    return {
      role: 'editor',
      name: '',
      invitation: this.pendingInvitation,
      pending: this.pendingApprovals,
      invitationExpired: this.isInvitationExpired(),
      ...(this.connectionNotice === undefined
        ? {}
        : { notice: this.connectionNotice }),
      ...(this.connectionNoticeKind === undefined
        ? {}
        : { noticeKind: this.connectionNoticeKind }),
    };
  }

  /** True once the minted invitation is past its ISO-8601 expiry. */
  private isInvitationExpired(): boolean {
    if (this.pendingInvitation === null) return false;
    const expiry = Date.parse(this.pendingInvitation.expiresAt);
    return Number.isFinite(expiry) && Date.now() >= expiry;
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
      // The device's display name is only known while its waiting row still
      // exists, so read it before filtering the row out.
      const approvedEntry = this.pendingApprovals.find(
        (entry) => entry.invitationId === invitationId,
      );
      const approvedName = approvedEntry?.intendedMemberDisplayName;
      const connectedMessage = `${approvedName ?? 'Device'} connected.`;
      // Record the approved device as a PERSISTENT roster member (green until an
      // explicit teardown). The owner's client already knows the display name,
      // role and server membershipId at approval time — endpoint-free.
      void this.recordRosterMember({
        membershipId: approved.membershipId,
        displayName: approvedName ?? 'Member',
        role: approvedEntry?.intendedRole ?? 'editor',
        self: false,
      });
      this.pendingApprovals = this.pendingApprovals.filter(
        (entry) => entry.invitationId !== invitationId,
      );
      this.connectionNotice = connectedMessage;
      this.connectionNoticeKind = 'success';
      report(connectedMessage);
      // Re-render to drop the approved row while keeping the create section
      // (invitation + role/name) fully alive.
      this.onboardingView?.refresh();
    } catch (error) {
      if (error instanceof ApproveDeviceError && error.locked) {
        // The invitation is spent after too many wrong codes: drop its waiting
        // row and point the owner back to Create invitation.
        this.pendingApprovals = this.pendingApprovals.filter(
          (entry) => entry.invitationId !== invitationId,
        );
        this.connectionNotice =
          'This invitation is now invalid. Create a new one above to try again.';
        this.connectionNoticeKind = undefined;
        report(error.message);
        this.onboardingView?.refresh();
        return;
      }
      if (error instanceof ApproveDeviceError) {
        // A wrong code (or other approval error): keep the row so the owner can
        // retry in place, and surface the "N attempts left" message inline.
        report(error.message);
        return;
      }
      report(
        `Could not approve: ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  private async startConnection(): Promise<void> {
    // Load the persisted roster first so a reopened, already-connected vault
    // shows its connected members immediately (never derived from activity).
    await this.loadRoster();
    this.connection = await startHavemindConnection(
      this,
      (status, view) => this.handleStatus(status, view),
      this.activityHooks(),
    );
    this.adoptSelfMembership(this.connection);
  }

  /** Runtime hooks handed to the sync loop so live surfaces stay fed. */
  private activityHooks(): {
    onLocalActivity: (entry: ActivityLogEntry) => void;
    onRemoteActivity: (entry: ActivityLogEntry) => void;
  } {
    return {
      onLocalActivity: (entry) => this.activityLog.record(entry),
      // FIX 1: a remote-applied revision reaches the Activity feed too, so
      // the other device's edits are no longer invisible.
      onRemoteActivity: (entry) => this.activityLog.record(entry),
    };
  }

  /**
   * Handles the Activity feed's "Restore" click: runs the append-only restore
   * over the current feed history and records the result as a new,
   * locally-attributed entry. A restore that cannot be performed (unknown or
   * deleted target, unreconciled history) is surfaced via a Notice rather
   * than silently doing nothing.
   */
  private handleRestore(revisionId: string): void {
    const self = this.rosterMembers.find((member) => member.self);
    if (self === undefined) {
      new Notice('Havemind: connect before restoring a revision.');
      return;
    }
    const history = activityEntriesToRecords(
      this.activityLog.snapshot(),
      this.rosterMembers,
    );
    const entry = restoreActivityEntry({
      history,
      targetRevisionId: revisionId,
      restorer: { actorId: self.membershipId, displayName: self.displayName },
      now: Date.now(),
      newRevisionId: globalThis.crypto.randomUUID(),
    });
    if (entry === null) {
      new Notice('Havemind: could not restore that revision.');
      return;
    }
    this.activityLog.record(entry);
  }

  /** Records the local member into the roster once the connection knows it. */
  private adoptSelfMembership(handle: ConnectionHandle | null): void {
    const self = handle?.selfMembership;
    if (self === undefined) return;
    void this.recordRosterMember({
      membershipId: self.membershipId,
      displayName: 'You',
      role: self.role,
      self: true,
    });
  }

  /** The durable roster store over the shared plugin-data blob. */
  private rosterStore(): RosterStore {
    return new RosterStore({
      persist: {
        load: () => this.loadData(),
        save: (data) => this.saveData(data),
      },
    });
  }

  private async loadRoster(): Promise<void> {
    this.rosterMembers = await this.rosterStore().readMembers();
    this.onboardingView?.refresh();
  }

  /** Upserts a member, persists the roster, and refreshes the live surfaces. */
  private async recordRosterMember(member: RosterMember): Promise<void> {
    this.rosterMembers = await this.rosterStore().recordMember(member);
    this.onboardingView?.refresh();
    this.activityView?.refresh();
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
    // A fresh paste clears any prior "invitation invalid" screen.
    this.guestInvitationInvalid = false;
    const handle = await connectFromInput(this, input, serverUrl, {
      report,
      onStatus: (status, view) => this.handleStatus(status, view),
      hooks: this.activityHooks(),
      // Durably record the waiting state so a pane reopen resumes the waiting
      // screen (with the code) instead of a blank paste form.
      onPendingApproval: (verificationPhrase) => {
        this.awaitingApproval = { verificationPhrase };
        this.onboardingView?.refresh();
      },
      // The owner rejected the device or the attempt cap was reached: leave the
      // waiting screen for the terminal "invitation invalid" screen. This is an
      // expected auth response, not a connection loss — status is untouched.
      onInvitationRejected: () => {
        this.awaitingApproval = null;
        this.guestInvitationInvalid = true;
        this.onboardingView?.refresh();
      },
    });
    if (handle !== null) {
      // Connected: the wait is over.
      this.awaitingApproval = null;
      this.guestInvitationInvalid = false;
      this.connection?.stop();
      this.connection = handle;
      // Record this device's own membership as a persistent roster member so the
      // invitee's UI clearly shows it is connected.
      this.adoptSelfMembership(handle);
    }
  }

  /** Stops the live sync loop; the paste form returns so the user can reconnect. */
  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.connectionStatus = 'disconnected';
    this.lastSyncedAt = undefined;
    this.connectionError = undefined;
    this.awaitingApproval = null;
    this.guestInvitationInvalid = false;
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
   * Owner action: mint an invitation for the connected vault, reveal the
   * copyable envelope, and register the joining device in the waiting list so
   * the owner can approve it by clicking a row (never by typing a UUID). The
   * envelope (a secret) is rendered only for the owner to copy — never logged.
   */
  private async createInvitation(
    role: InvitationRole,
    name: string,
    report: ConnectReporter,
  ): Promise<void> {
    try {
      const invitation = await createInvitationForOwner(this, {
        intendedRole: role,
        ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
      });
      if (invitation === null) {
        report('Connect as the vault owner before creating an invitation.');
        return;
      }
      // Minting an invite always belongs to the composer and must reveal the
      // invite section — never leave it hidden behind another surface.
      this.connectionActive = true;
      this.setPendingInvitation(invitation);
      this.pendingApprovals = [
        ...this.pendingApprovals.filter(
          (entry) => entry.invitationId !== invitation.invitationId,
        ),
        {
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
          intendedRole: role,
          ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
        },
      ];
      this.connectionNotice =
        'Invitation created. Copy it and send it to the other device.';
      this.connectionNoticeKind = undefined;
      this.onboardingView?.refresh();
    } catch (error) {
      report(
        `Could not create invitation: ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  /** Clears the minted-invitation display without touching the waiting list. */
  private dismissInvitation(): void {
    this.pendingInvitation = null;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.onboardingView?.refresh();
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
