/**
 * The Havemind onboarding/connection view — the plugin's one interactive panel.
 * It hosts every connection surface: the owner's unified "Create connection"
 * composer, the guest paste form, the guest waiting and invitation-invalid
 * screens, and the connected panel with its status indicator, send-queue,
 * conflicts, roster and collapsed help. All data and actions arrive through the
 * injected `OnboardingViewOptions`, so the view holds no connection state of its
 * own beyond in-progress typed input, and every section renders inside its own
 * error boundary so one failing provider can never blank the pane.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { RevisionRecord } from '../activity/activity';
import type { ConflictCopy } from '../runtime/conflict-resolution';
import type { CreatedInvitation } from '../runtime/create-invitation';
import { buildGettingStartedViewModel } from '../runtime/getting-started-render';
import type { RejoinRosterView } from '../runtime/rejoin-roster';
import type { MemberRole } from '../runtime/roster';
import type { SendQueueStatusView } from '../runtime/send-queue-status';
import {
  buildConnectionPanel,
  type ConnectionPanelView,
} from '../runtime/status';

import { renderActivityRows } from './activity-section';
import { renderConflictSection } from './conflict-section';
import { renderGettingStarted } from './getting-started-section';
import { DECORATIVE, renderSection, renderViewTitle } from './primitives';
import { renderRejoinRoster } from './roster-section';
import {
  renderRecoveryNotice,
  renderSendQueueSection,
} from './send-queue-section';
import { HAVEMIND_ONBOARDING_VIEW } from './view-types';

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
   * The revision feed, rendered as a collapsed section of this pane rather
   * than a separate destination (plans/007 Stage 0). Reads the same provider
   * the standalone Activity view uses, so the two cannot disagree.
   */
  readonly activityFeedProvider?: () => readonly RevisionRecord[];
  /** Restores a revision from an activity row. */
  readonly onRestore?: (revisionId: string) => void;
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
   * MRG-03 conflict copies awaiting resolution. When it returns a non-empty
   * list the "Conflicts" section is drawn in the panel; an empty list (or an
   * omitted provider) hides it entirely.
   */
  readonly conflictsProvider?: () => readonly ConflictCopy[];
  /** Open the resolve modal for the conflict copy at this vault path. */
  readonly onResolveConflict?: (copyPath: string) => void;
  /**
   * SND-01 send-queue status. When it returns a view with a waiting count or
   * any failed items the "waiting/failed to send" section is drawn beneath the
   * status indicator; null (disconnected) or an all-clear view draws nothing.
   */
  readonly sendQueueProvider?: () => SendQueueStatusView | null;
  /**
   * GAP-1 recovery signal. Returns true when the durable sync state could not
   * read its persisted outbox and resumed from a clean empty state — the panel
   * then draws a "local queue needs recovery" warning so the loss is never
   * silent. Defaults to false (nothing to recover) when omitted.
   */
  readonly recoveryRequiredProvider?: () => boolean;
  /** Retry a quarantined send: re-enqueue it through the outbox machinery. */
  readonly onRetrySend?: (revisionId: string) => void;
  /** Discard a quarantined send permanently (panel confirms in two steps). */
  readonly onDiscardSend?: (revisionId: string) => void;
  /**
   * Presence roster (who is connected) with the F9 rejoin affordance. Rendered
   * in the owner composer and in the connected panel so both the owner and the
   * invitee see a clear "Connected" list. Presence is persistent connection
   * state, never activity; a known-dead contact is drawn as disconnected with a
   * Rejoin button.
   */
  readonly rejoinRosterProvider?: () => RejoinRosterView;
  /** Membership ids the owner has asked to rejoin (awaiting reconnect). */
  readonly rejoinWaitingProvider?: () => ReadonlySet<string>;
  /** Owner clicked Rejoin on a disconnected contact — issue the rejoin grant. */
  readonly onRejoin?: (membershipId: string) => void;
  /** Owner marks a connected contact disconnected, arming its Rejoin button. */
  readonly onMarkDisconnected?: (membershipId: string) => void;
  /** Owner permanently removes a member from the vault (two-step confirm in UI). */
  readonly onRemove?: (membershipId: string) => void;
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
  /**
   * Force an immediate reconnect from a non-synced backoff/terminal state
   * (offline or reconnect-required), instead of waiting out the sync runner's
   * backoff. Rendered as the "Retry now" button in the status section.
   */
  readonly onRetry?: () => void;
  /**
   * Clear the broken persisted connection so this device can be paired again
   * (P1 #5). Rendered as the "Reset connection" button, and ONLY in the
   * `reset-required` state — a state in which sync is provably dead, so the
   * button can never be mistaken for an action on a healthy connection.
   */
  readonly onReset?: () => void;
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
  /**
   * Whether the collapsed "Getting started" help is expanded in the connected
   * panel. Disconnected users always see the tutorial; once connected it hides
   * behind a small help button so it is discoverable without nagging.
   */
  private helpOpen = false;
  /**
   * Whether the activity section is expanded. Collapsed by default: the calm
   * pane spends its lines on what needs attention, not on history (plans/007).
   */
  private activityOpen = false;
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
    content.addClass('havemind-view');
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

    renderViewTitle(content, 'Connect to Havemind');

    const panel =
      this.options.panelProvider?.() ??
      buildConnectionPanel({ status: 'disconnected' });
    // MAJOR 5: each section renders inside its own guard so a synchronous
    // provider throw degrades that one section to an inline fallback rather than
    // blanking the whole panel (content.empty() has already run above).
    renderSection(content, 'status', () => this.renderIndicator(content, panel));
    renderSection(content, 'send queue', () => this.renderSendQueue(content));
    renderSection(content, 'conflicts', () => this.renderConflicts(content));
    renderSection(content, 'connection', () => {
      if (panel.showForm) {
        // Disconnected/empty state is the tutorial's natural home: show the
        // numbered "Getting started" steps above the connect form so a fresh
        // user knows exactly what to do before pasting anything.
        renderGettingStarted(content, buildGettingStartedViewModel());
        content.createEl('hr').addClass('havemind-divider');
        this.renderForm(content);
      } else {
        this.renderConnected(content);
      }
    });
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
    // synced / conflict read as a small filled dot; the icon name, label and
    // colour token stay exactly as status.ts provides them.
    if (panel.status === 'synced' || panel.status === 'conflict') {
      row.addClass('havemind-status-dot');
    }
    row.style.setProperty('color', `var(${panel.colorToken})`);
    const icon = row.createEl('span', { attr: DECORATIVE });
    setIcon(icon, panel.icon);
    row.createEl('span', { text: ` ${panel.label}` });
    const detail = content.createDiv({ text: panel.detail });
    detail.addClass('havemind-status-detail');

    // A "Retry now" affordance for the non-synced backoff/terminal states
    // (offline waiting on the sync runner's backoff, or a terminal
    // reconnect-required). It lets the user force an immediate reconnect rather
    // than waiting the backoff out. Never shown while synced/syncing (nothing to
    // retry) or conflict/disconnected (retry cannot help those). Lives in the
    // panel, not the status bar, since setText clobbers status-bar children.
    if (
      this.options.onRetry !== undefined &&
      (panel.status === 'offline' || panel.status === 'reconnect-required')
    ) {
      const retry = content.createEl('button', { text: 'Retry now' });
      retry.addClass('mod-cta');
      retry.addClass('havemind-retry');
      retry.onClickEvent(() => this.options.onRetry?.());
    }

    // P1 #5: the stored connection is damaged, so retrying and rejoining are
    // both dead ends — the one way forward is clearing it and pairing again.
    // Deliberately NOT rendered for any other status: this is the only state in
    // which sync is provably dead, so the button can never be an accidental
    // click on a healthy connection.
    if (this.options.onReset !== undefined && panel.status === 'reset-required') {
      const reset = content.createEl('button', {
        text: 'Reset connection',
        attr: {
          'aria-label':
            'Reset the stored Havemind connection and pair this device again',
        },
      });
      reset.addClass('mod-warning');
      reset.addClass('havemind-reset');
      reset.onClickEvent(() => this.options.onReset?.());
    }
  }

  /**
   * Draws the MRG-03 "Conflicts" section when copies exist. The provider reads
   * the vault synchronously; an empty list renders nothing so the section
   * appears only while there is something to resolve.
   */
  private renderConflicts(content: HTMLElement): void {
    const copies = this.options.conflictsProvider?.() ?? [];
    const onResolveConflict = this.options.onResolveConflict;
    if (copies.length === 0 || onResolveConflict === undefined) return;
    renderConflictSection(content, copies, {
      onResolve: (copyPath) => onResolveConflict(copyPath),
    });
  }

  /**
   * Draws the SND-01 send-queue section (waiting + failed) beneath the status
   * indicator. The provider reads the persisted sync state; a null return
   * (disconnected) or an all-clear view renders nothing.
   */
  private renderSendQueue(content: HTMLElement): void {
    // GAP-1: surface the recovery warning first, so it shows even when there is
    // no send-queue view (or an all-clear one) to draw beneath it.
    renderRecoveryNotice(content, this.options.recoveryRequiredProvider?.() ?? false);
    const view = this.options.sendQueueProvider?.() ?? null;
    if (view === null) return;
    const onRetry = this.options.onRetrySend;
    const onDiscard = this.options.onDiscardSend;
    if (onRetry === undefined || onDiscard === undefined) return;
    renderSendQueueSection(content, view, {
      onRetry: (revisionId) => onRetry(revisionId),
      onDiscard: (revisionId) => onDiscard(revisionId),
    });
  }

  /**
   * The collapsed help affordance for the connected panel: a small life-buoy
   * icon button that toggles the "Getting started" steps in place. It never
   * nags — the steps stay hidden until the user asks for them, and re-opening
   * them touches no connection state.
   */
  private renderHelpAffordance(content: HTMLElement): void {
    const bar = content.createDiv();
    bar.addClass('havemind-help-bar');
    const toggle = bar.createEl('button', {
      attr: {
        'aria-label': this.helpOpen
          ? 'Hide getting started'
          : 'Show getting started',
        'aria-expanded': this.helpOpen ? 'true' : 'false',
      },
    });
    toggle.addClass('havemind-help-toggle');
    setIcon(toggle.createEl('span', { attr: DECORATIVE }), 'life-buoy');
    toggle.onClickEvent(() => {
      this.helpOpen = !this.helpOpen;
      this.render();
    });
    if (this.helpOpen) {
      renderGettingStarted(content, buildGettingStartedViewModel());
      content.createEl('hr').addClass('havemind-divider');
    }
  }

  private renderConnected(content: HTMLElement): void {
    // Once connected the tutorial collapses to a small, unobtrusive help button
    // near the panel title; clicking it re-opens the same "Getting started"
    // steps in place, so the guidance stays discoverable without nagging.
    this.renderHelpAffordance(content);

    // The revision feed lives here now rather than in a second pane
    // (plans/007 Stage 0), collapsed by default: in the calm state it is one
    // summary row carrying a count, so the pane proves it is awake without
    // spending the whole column on history nobody asked for.
    renderSection(content, 'activity', () => this.renderActivity(content));

    // Presence roster makes "connected" unambiguous for the invitee (and owner):
    // once approval succeeds the panel clearly lists who is connected.
    const roster = this.options.rejoinRosterProvider?.();
    if (roster !== undefined) {
      this.renderRoster(content, roster);
    }
    const disconnect = content.createEl('button', { text: 'Disconnect' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
  }

  /**
   * The activity feed as a collapsible section. Collapsed it is a single row
   * with a count; expanded it renders the same rows the standalone Activity
   * view draws, through the same shared helper.
   */
  private renderActivity(content: HTMLElement): void {
    const feed = this.options.activityFeedProvider?.() ?? [];

    // The section renders even with an empty feed. The log is in-memory and
    // rebuilds on every start, so "empty" is the normal state right after a
    // reload — vanishing then would leave the user unable to tell whether the
    // feed moved, broke, or simply has nothing to report yet.
    const header = content.createEl('button');
    header.addClass('havemind-collapse-header');
    header.setAttribute('aria-expanded', this.activityOpen ? 'true' : 'false');
    header.createEl('span', { text: 'Activity' });
    header.createEl('span', {
      text: feed.length === 0 ? 'none yet' : `${feed.length}`,
      cls: 'havemind-collapse-count',
    });
    header.onClickEvent(() => {
      this.activityOpen = !this.activityOpen;
      this.render();
    });

    // An empty feed shows its one-line explanation without needing a click:
    // collapsing "nothing to report" hides no noise, it only hides the reason.
    if (!this.activityOpen && feed.length > 0) return;

    const body = content.createDiv();
    body.addClass('havemind-collapse-body');
    renderActivityRows(body, {
      feed,
      ...(this.options.onRestore ? { onRestore: this.options.onRestore } : {}),
    });
  }

  /** Renders the rejoin-aware roster with its owner actions from the options. */
  private renderRoster(content: HTMLElement, roster: RejoinRosterView): void {
    renderRejoinRoster(content, roster, {
      waiting: this.options.rejoinWaitingProvider?.() ?? new Set<string>(),
      ...(this.options.onRejoin === undefined
        ? {}
        : { onRejoin: this.options.onRejoin }),
      ...(this.options.onMarkDisconnected === undefined
        ? {}
        : { onMarkDisconnected: this.options.onMarkDisconnected }),
      ...(this.options.onRemove === undefined
        ? {}
        : { onRemove: this.options.onRemove }),
    });
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
    renderViewTitle(content, 'Connecting to Havemind');
    // Icon + label + colour (never colour alone), matching the panel convention.
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-accent)');
    setIcon(row.createEl('span', { attr: DECORATIVE }), 'loader');
    row.createEl('span', { text: ' Waiting for the other device to approve…' });
    content
      .createDiv({ text: 'Read this 6-digit code to the vault owner.' })
      .addClass('havemind-hint');
    const phrase = content.createDiv({ text: model.verificationPhrase });
    phrase.addClass('havemind-verification-phrase');
    content
      .createDiv({
        text: 'Keep Obsidian open — this resumes automatically once approved.',
      })
      .addClass('havemind-hint');
    const disconnect = content.createEl('button', { text: 'Cancel' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
  }

  /**
   * Terminal guest screen after the owner rejected this device or the 3-attempt
   * cap was reached. The invitation is spent, so we present a clear message plus
   * the paste form to try a fresh invite — never offline, never a blank form.
   */
  private renderGuestInvalid(content: HTMLElement): void {
    renderViewTitle(content, 'Connect to Havemind');
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-error)');
    setIcon(row.createEl('span', { attr: DECORATIVE }), 'alert-triangle');
    row.createEl('span', { text: ' This invitation is no longer valid' });
    content
      .createDiv({
        text: 'Ask the vault owner for a new invitation, then paste it below.',
      })
      .addClass('havemind-hint');
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
      placeholder: 'https://your-server.example',
      value: this.draft.server,
    });
    this.liveInputs.token = tokenInput;
    this.liveInputs.server = serverInput;
    const status = content.createDiv({ text: '' });
    status.addClass('havemind-form-status');
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
    renderViewTitle(content, 'Creating connection');
    if (model.notice) this.renderNotice(content, model.notice, model.noticeKind);

    // MAJOR 5: isolate the create, roster and waiting sections so a throw in
    // one degrades to an inline fallback rather than blanking the composer.
    renderSection(content, 'create invitation', () =>
      this.renderCreateSection(content, model),
    );

    renderSection(content, 'roster', () => {
      // The persistent "Connected" roster — who is already a member of this vault.
      const roster = this.options.rejoinRosterProvider?.();
      if (roster !== undefined && !roster.empty) {
        const rosterDivider = content.createEl('hr');
        rosterDivider.addClass('havemind-divider');
        this.renderRoster(content, roster);
      }
    });

    renderSection(content, 'waiting devices', () => {
      const divider = content.createEl('hr');
      divider.addClass('havemind-divider');

      content.createEl('h4', { text: 'Waiting for the other device' });
      if (model.pending.length === 0) {
        content
          .createDiv({
            text: 'No device is waiting yet. When the other device redeems the invite, it appears here to approve.',
          })
          .addClass('havemind-empty');
        return;
      }
      for (const entry of model.pending) {
        this.renderPendingRow(content, entry);
      }
    });
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
    status.addClass('havemind-form-status');
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
      content
        .createDiv({
          text: 'This invitation expired. Create a new one above to invite the other device.',
        })
        .addClass('havemind-hint');
      const dismiss = content.createEl('button', { text: 'Done' });
      dismiss.onClickEvent(() => this.options.onDismissInvitation?.());
      return;
    }

    content
      .createDiv({
        text: 'Invite created — copy it and send it to the other device. Single-use, expires in 15 minutes.',
      })
      .addClass('havemind-hint');
    const code = content.createEl('code', { text: envelope });
    code.addClass('havemind-invite-envelope');
    // Readonly field so the owner can select the envelope by hand if the
    // clipboard copy is unavailable or denied.
    content.createEl('textarea', {
      value: envelope,
      cls: 'havemind-invite-copy-fallback',
    });
    const copyStatus = content.createDiv({ text: '' });
    copyStatus.addClass('havemind-form-status');
    const copy = content.createEl('button', { text: 'Copy' });
    copy.addClass('mod-cta');
    copy.onClickEvent(() => {
      this.options.onCopyInvitation?.(envelope);
      copyStatus.setText('Copied to clipboard.');
    });
    content
      .createDiv({ text: `Expires: ${model.invitation.expiresAt}` })
      .addClass('havemind-hint');
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
      content.createDiv({ text: notice }).addClass('havemind-hint');
      return;
    }
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-success)');
    setIcon(row.createEl('span', { attr: DECORATIVE }), 'check-circle');
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
    setIcon(row.createEl('span', { attr: DECORATIVE }), 'user-round-check');
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
    status.addClass('havemind-form-status');
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
