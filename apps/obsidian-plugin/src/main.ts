import {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  type App,
  type WorkspaceLeaf,
} from 'obsidian';

import { hashPlaintext } from '@havemind/protocol';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import { parseFailedToQueuePath } from './runtime/sync-state';
import type { DurableSyncState } from './runtime/sync-state';
import {
  computeLineDiff,
  createConflictResolver,
  createObsidianConflictPort,
  listConflictCopies,
  type ConflictCopy,
  type ConflictVaultPort,
  type DiffLine,
  type ResolveAction,
} from './runtime/conflict-resolution';
import {
  buildSendQueueStatus,
  selectNewlyQuarantined,
  type SendQueueStatusView,
} from './runtime/send-queue-status';
import { sweepConflictCopies } from './runtime/conflict-sweep';
import type { RevisionRecord } from './activity/activity';
import { buildActivityViewModel } from './runtime/activity-render';
import { restoreActivityEntry } from './runtime/activity-restore';
import {
  ActivityLog,
  activityEntriesToRecords,
  type ActivityLogEntry,
} from './runtime/activity-log';
import {
  RosterStore,
  type MemberRole,
  type RosterMember,
} from './runtime/roster';
import {
  buildRejoinRosterView,
  type RejoinRosterView,
} from './runtime/rejoin-roster';
import {
  REJOIN_POLL_INTERVAL_MS,
  type RejoinController,
} from './runtime/rejoin';
import {
  buildConnectionPanel,
  formatStatusBar,
  type ConnectionPanelView,
  type ConnectionStatus,
  type StatusBarView,
} from './runtime/status';
import {
  approvePendingDeviceForOwner,
  buildRejoinControllerForInvitee,
  connectFromInput,
  createInvitationForOwner,
  requestRejoinGrantForOwner,
  revokeMembershipForOwner,
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

/** Debounce window for the MRG-05 auto-repair sweep — a burst becomes one pass. */
const CONFLICT_SWEEP_DEBOUNCE_MS = 2000;

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
 * Renders a panel's `h3` title with a small leading hexagon glyph — the
 * "hive mind" motif that gives every Havemind surface a shared identity. The
 * title text stays on the `h3` itself; the hexagon is an accent-tinted child
 * placed before the text via CSS (order), so it never becomes the only signal
 * and never changes the heading's text content.
 */
function renderViewTitle(content: HTMLElement, text: string): void {
  const heading = content.createEl('h3', { text });
  heading.addClass('havemind-view-title');
  const icon = heading.createEl('span');
  icon.addClass('havemind-title-icon');
  setIcon(icon, 'hexagon');
}

/**
 * MAJOR 5: render one panel section inside an error boundary. A synchronous
 * throw from a section's provider or render body is logged and degraded to a
 * small inline "Section unavailable" fallback so the failure is contained to
 * that section — every other section keeps rendering rather than the whole
 * panel blanking after `content.empty()`.
 */
function renderSection(
  content: HTMLElement,
  name: string,
  render: () => void,
): void {
  try {
    render();
  } catch (error) {
    console.error(`Havemind: the "${name}" panel section failed to render`, error);
    const fallback = content.createDiv({ text: 'Section unavailable' });
    fallback.addClass('havemind-section-error');
  }
}

/** Owner actions attached to each rejoin-aware roster row. */
interface RejoinRosterActions {
  /** Membership ids the owner has already asked to rejoin (awaiting reconnect). */
  readonly waiting: ReadonlySet<string>;
  /** Owner clicked Rejoin on a disconnected contact — issue the grant. */
  readonly onRejoin?: (membershipId: string) => void;
  /** Owner asserts a connected contact fell off, arming its Rejoin affordance. */
  readonly onMarkDisconnected?: (membershipId: string) => void;
  /** Owner permanently removes a member from the vault (destructive, two-step). */
  readonly onRemove?: (membershipId: string) => void;
}

/**
 * Renders the "Connected" presence roster with the F9 rejoin affordance. Each
 * row pairs the member's stable colour dot with a text status label (never
 * colour alone): a green dot + "connected" for a live member, or a muted dot +
 * "disconnected" + a Rejoin button for a known-dead contact. Presence is
 * CONNECTION STATE — a member stays connected until an explicit teardown, never
 * derived from activity.
 *
 * Pilot heuristic (documented choice): no server-side liveness signal reaches
 * the owner's client yet, so "disconnected" is owner-asserted — the owner marks
 * a contact's row disconnected, which arms its Rejoin button. Clicking Rejoin
 * re-admits that exact contact without re-running pairing.
 */
function renderRejoinRoster(
  content: HTMLElement,
  roster: RejoinRosterView,
  actions: RejoinRosterActions,
): void {
  content.createEl('h4', { text: 'Connected' });
  if (roster.empty) {
    const empty = content.createDiv({
      text: 'No members yet. Approved devices appear here as connected.',
    });
    empty.addClass('havemind-empty');
    return;
  }
  for (const row of roster.rows) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-roster-row');
    // Colour dot coloured by the member's stable token — paired with the text
    // status label below so colour is never the only signal.
    const dot = item.createEl('span');
    dot.addClass('havemind-roster-dot');
    dot.style.setProperty('color', `var(${row.colorToken})`);
    setIcon(dot, row.connected ? 'circle' : 'circle-off');
    const name = row.self ? `${row.displayName} (you)` : row.displayName;
    item.createEl('span', {
      text: ` ${name} · ${row.role} · ${row.statusLabel}`,
    });

    if (row.rejoinable && actions.onRejoin) {
      if (actions.waiting.has(row.membershipId)) {
        const status = item.createDiv({
          text: `Waiting for ${row.displayName} to reconnect…`,
        });
        status.addClass('havemind-rejoin-waiting');
      } else {
        const rejoin = item.createEl('button', { text: 'Rejoin' });
        rejoin.addClass('mod-cta');
        rejoin.addClass('havemind-roster-action');
        rejoin.onClickEvent(() => actions.onRejoin?.(row.membershipId));
      }
    } else if (row.connected && !row.self && actions.onMarkDisconnected) {
      // Owner-asserted disconnect: clicking arms this contact's Rejoin button.
      const mark = item.createEl('button', { text: 'Mark disconnected' });
      mark.addClass('havemind-roster-action');
      mark.onClickEvent(() => actions.onMarkDisconnected?.(row.membershipId));
    }

    // Remove is offered on every non-self member regardless of connection
    // state. It is destructive (mod-warning, never mod-cta) and gated behind an
    // inline two-step confirm: the first click arms "Confirm remove", the second
    // click within the same render executes. No window.confirm — it blocks
    // Electron and would freeze the pane.
    if (row.removable && actions.onRemove) {
      let armed = false;
      let executed = false;
      const remove = item.createEl('button', { text: 'Remove' });
      remove.addClass('mod-warning');
      remove.addClass('havemind-roster-action');
      remove.onClickEvent(() => {
        if (executed) {
          return;
        }
        if (!armed) {
          armed = true;
          remove.setText('Confirm remove');
          remove.addClass('havemind-roster-action-armed');
          return;
        }
        // Fire exactly once: the success path re-renders the roster (dropping
        // this row), but guard here too so a stray click before that re-render
        // can never submit a second removal.
        executed = true;
        actions.onRemove?.(row.membershipId);
      });
    }
  }
}

/**
 * A destructive two-step confirm button, mirroring the Remove-button idiom: the
 * first click arms the button (swapping its label to `confirmLabel`), the second
 * click within the same render executes. `executed` guards a stray third click
 * from re-firing after confirmation. No `window.confirm` — it blocks Electron.
 */
function armedButton(
  parent: HTMLElement,
  label: string,
  confirmLabel: string,
  cls: string,
  onConfirm: () => void,
): void {
  let armed = false;
  let executed = false;
  const button = parent.createEl('button', { text: label });
  button.addClass(cls);
  button.onClickEvent(() => {
    if (executed) return;
    if (!armed) {
      armed = true;
      button.setText(confirmLabel);
      button.addClass('havemind-conflict-action-armed');
      return;
    }
    executed = true;
    onConfirm();
  });
}

/** Actions attached to each conflict-copy row in the panel section. */
export interface ConflictSectionActions {
  /** Open the resolve modal for the copy at this vault path. */
  readonly onResolve: (copyPath: string) => void;
}

/**
 * Renders the "Conflicts" panel section: a header (git-merge icon + count
 * badge) and one row per conflict copy. The section is drawn only when copies
 * exist, so the caller must skip it for an empty list. Each row shows the target
 * note, author and timestamp — or the manual-resolution hint when the target is
 * unknown — plus a Resolve button opening the diff modal.
 */
export function renderConflictSection(
  content: HTMLElement,
  copies: readonly ConflictCopy[],
  actions: ConflictSectionActions,
): void {
  if (copies.length === 0) return;

  const header = content.createDiv({ text: '' });
  header.addClass('havemind-conflict-header');
  const icon = header.createEl('span');
  icon.addClass('havemind-conflict-icon');
  setIcon(icon, 'git-merge');
  header.createEl('span', { text: ' Conflicts' });
  const badge = header.createEl('span', { text: `${copies.length}` });
  badge.addClass('havemind-conflict-count');

  for (const copy of copies) {
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-conflict-row');

    const name = copy.noteName ?? copy.copyName;
    row.createEl('span', { text: name }).addClass('havemind-conflict-note');
    if (copy.author !== null && copy.timestamp !== null) {
      row.createEl('span', {
        text: ` · ${copy.author} · ${copy.timestamp}`,
      }).addClass('havemind-conflict-meta');
    }
    if (copy.manualHint !== null) {
      const hint = row.createDiv({ text: copy.manualHint });
      hint.addClass('havemind-conflict-hint');
    }

    const resolve = row.createEl('button', { text: 'Resolve' });
    resolve.addClass('mod-cta');
    resolve.addClass('havemind-conflict-action');
    resolve.onClickEvent(() => actions.onResolve(copy.copyPath));
  }
}

/** Actions wired to each failed-send row in the send-queue section (SND-01). */
export interface SendQueueSectionActions {
  /** Re-enqueue the quarantined send through the normal outbox machinery. */
  readonly onRetry: (revisionId: string) => void;
  /** Permanently drop the quarantined send (destructive → two-step confirm). */
  readonly onDiscard: (revisionId: string) => void;
}

/**
 * Renders the SND-01 send-queue visibility section: a muted "N change(s)
 * waiting to send" line when items have been queued too long, and — when the
 * quarantine is non-empty — a distinct "N change(s) failed to send" warning with
 * one row per failed item (path + reason) offering Retry and a two-step Discard.
 * Draws nothing when both signals are absent, so a healthy queue stays silent.
 */
export function renderSendQueueSection(
  content: HTMLElement,
  view: SendQueueStatusView,
  actions: SendQueueSectionActions,
): void {
  if (view.waitingCount > 0) {
    const waiting = content.createDiv({
      text: `${view.waitingCount} change(s) waiting to send`,
    });
    waiting.addClass('havemind-send-waiting');
  }

  if (view.failed.length === 0) return;

  const header = content.createDiv({
    text: `${view.failed.length} change(s) failed to send`,
  });
  header.addClass('havemind-send-failed');

  for (const row of view.failed) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-send-failed-row');
    item.createEl('span', { text: row.label }).addClass('havemind-send-file');
    item
      .createEl('span', { text: ` · ${row.reason}` })
      .addClass('havemind-send-reason');
    const retry = item.createEl('button', { text: 'Retry' });
    retry.addClass('havemind-send-action');
    retry.onClickEvent(() => actions.onRetry(row.revisionId));
    armedButton(
      item,
      'Discard',
      'Confirm discard',
      'mod-warning',
      () => actions.onDiscard(row.revisionId),
    );
  }
}

/** View model for the resolve modal — pure, built from a copy + optional diff. */
export interface ConflictModalModel {
  readonly title: string;
  readonly author: string | null;
  readonly timestamp: string | null;
  readonly isBinary: boolean;
  readonly targetKnown: boolean;
  /** Line diff (note vs copy), or null for binary/unknown-target copies. */
  readonly diff: readonly DiffLine[] | null;
  readonly manualHint: string | null;
}

/** Builds the modal model from a conflict copy and its computed diff (if any). */
export function buildConflictModalModel(
  copy: ConflictCopy,
  diff: readonly DiffLine[] | null,
): ConflictModalModel {
  return {
    title: copy.noteName ?? copy.copyName,
    author: copy.author,
    timestamp: copy.timestamp,
    isBinary: copy.isBinary,
    targetKnown: copy.targetKnown,
    diff,
    manualHint: copy.manualHint,
  };
}

/** Callbacks wired to the resolve modal's three buttons. */
export interface ConflictModalActions {
  /** Keep the live note, discard the copy (destructive → two-step confirm). */
  readonly onKeepMine?: () => void;
  /** Overwrite the note with the copy (destructive → two-step confirm). */
  readonly onKeepTheirs?: () => void;
  /** Leave both files in place and close the modal. */
  readonly onKeepBoth: () => void;
}

/**
 * Renders the resolve modal body: a heading, the manual hint (if any), the
 * colour-coded line diff (added lines tinted with --text-success, removed with
 * --text-error), and the three resolution buttons. "Keep theirs" is offered
 * only when a text target is known — a missing target or a binary copy cannot be
 * written from here, so those resolve by keeping mine or opening files manually.
 */
export function renderConflictModalBody(
  container: HTMLElement,
  model: ConflictModalModel,
  actions: ConflictModalActions,
): void {
  container.addClass('havemind-conflict-modal');
  renderViewTitle(container, `Resolve conflict — ${model.title}`);

  if (model.author !== null && model.timestamp !== null) {
    const meta = container.createDiv({
      text: `Conflict from ${model.author} · ${model.timestamp}`,
    });
    meta.addClass('havemind-conflict-modal-meta');
  }

  if (model.manualHint !== null) {
    const hint = container.createDiv({ text: model.manualHint });
    hint.addClass('havemind-conflict-hint');
  }

  if (model.diff !== null) {
    const diffBox = container.createDiv({ text: '' });
    diffBox.addClass('havemind-conflict-diff');
    for (const line of model.diff) {
      const prefix =
        line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ';
      const row = diffBox.createDiv({ text: `${prefix}${line.text}` });
      row.addClass('havemind-conflict-line');
      row.addClass(`havemind-conflict-line-${line.type}`);
    }
  }

  const buttons = container.createDiv({ text: '' });
  buttons.addClass('havemind-conflict-buttons');

  if (actions.onKeepMine) {
    armedButton(
      buttons,
      'Keep mine',
      'Confirm keep mine',
      'mod-warning',
      actions.onKeepMine,
    );
  }
  if (actions.onKeepTheirs && model.targetKnown && !model.isBinary) {
    armedButton(
      buttons,
      'Keep theirs',
      'Confirm keep theirs',
      'mod-warning',
      actions.onKeepTheirs,
    );
  }
  const keepBoth = buttons.createEl('button', { text: 'Keep both (close)' });
  keepBoth.addClass('havemind-conflict-action');
  keepBoth.onClickEvent(() => actions.onKeepBoth());
}

/** The in-app diff/merge modal for a single conflict copy (livesync-style). */
export class ConflictResolveModal extends Modal {
  private readonly model: ConflictModalModel;
  private readonly actions: ConflictModalActions;

  constructor(app: App, model: ConflictModalModel, actions: ConflictModalActions) {
    super(app);
    this.model = model;
    this.actions = actions;
  }

  override onOpen(): void {
    renderConflictModalBody(this.contentEl, this.model, this.actions);
  }

  override onClose(): void {
    this.contentEl.empty();
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
    return 'hexagon';
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
    content.addClass('havemind-view');
    renderViewTitle(content, 'Havemind activity');

    // MAJOR 5: a throw building or rendering the feed degrades to an inline
    // fallback rather than blanking the activity view.
    renderSection(content, 'activity', () => {
      const model = buildActivityViewModel(this.options.feedProvider?.() ?? [], {
        formatTimestamp: formatActivityTime,
      });
      if (model.empty) {
        const empty = content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
        empty.addClass('havemind-empty');
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
          restore.addClass('havemind-activity-action');
          restore.onClickEvent(() => this.options.onRestore?.(row.revisionId));
        }
        const time = entry.createEl('span', { text: ` ${row.timeLabel}` });
        time.addClass('havemind-activity-time');
      }
    });
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
    row.style.setProperty('color', `var(${panel.colorToken})`);
    const icon = row.createEl('span');
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

  private renderConnected(content: HTMLElement): void {
    // Presence roster makes "connected" unambiguous for the invitee (and owner):
    // once approval succeeds the panel clearly lists who is connected.
    const roster = this.options.rejoinRosterProvider?.();
    if (roster !== undefined) {
      this.renderRoster(content, roster);
    }
    const disconnect = content.createEl('button', { text: 'Disconnect' });
    disconnect.onClickEvent(() => this.options.onDisconnect?.());
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
    setIcon(row.createEl('span'), 'loader');
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
    setIcon(row.createEl('span'), 'alert-triangle');
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
      placeholder: 'https://sapserver.tailnet.ts.net',
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

class HavemindSettingTab extends PluginSettingTab {
  override display(): void {
    this.containerEl.empty();

    // MINOR 9: replace the stale "onboarding coming next slice" stub with the
    // live connection status plus a single action to open the pane, where the
    // real connect/onboarding surface already lives.
    const plugin = this.plugin as unknown as HavemindPlugin;
    new Setting(this.containerEl).setName('Havemind').setHeading();
    new Setting(this.containerEl)
      .setName('Connection')
      .setDesc(plugin.panelStatusLabel());
    const open = this.containerEl.createEl('button', {
      text: 'Open Havemind panel',
    });
    open.addClass('mod-cta');
    open.onClickEvent(() => plugin.revealPanel());
  }
}

export default class HavemindPlugin extends Plugin {
  private activityOptions: ActivityViewOptions = {};
  private statusItem: HTMLElement | null = null;
  private connection: ConnectionHandle | null = null;
  /**
   * Set true in `onunload`. `startConnection` runs on `onLayoutReady` and awaits
   * an async connection build; if the plugin is disabled while that await is in
   * flight, `onunload` runs first and the resolved handle must be stopped, never
   * assigned — otherwise its vault listeners and running sync loop leak with no
   * `stop()` ever reaching them.
   */
  private unloaded = false;
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
  /**
   * F9 Rejoin (owner side). Membership ids the owner has asserted are dead
   * (pilot heuristic — no server liveness signal yet, see renderRejoinRoster):
   * their roster rows draw as disconnected and offer Rejoin.
   */
  private deadMembershipIds: string[] = [];
  /** Membership ids the owner has issued a rejoin grant for (awaiting reconnect). */
  private rejoinWaiting = new Set<string>();
  /**
   * F9 Rejoin (invitee side). The live controller driving terminal-auth →
   * syncing while this device polls for the owner's grant, plus the interval id
   * so unload tears the poll down. Null when no rejoin is armed.
   */
  private rejoinController: RejoinController | null = null;
  private rejoinPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** Guards the post-rejoin restart so it fires exactly once (no double-start). */
  private rejoinRestarted = false;
  /**
   * Monotonic counter bumped each time a live connection is (re-)established
   * (`startConnection`/`connectFromInput` assign a handle). The invitee rejoin
   * poll captures it when it arms; a poll tick that sees the counter has advanced
   * knows the connection was rebuilt since it armed (Retry now, a fresh user
   * connect, a rejoin restart) and must not tear that healthy connection down —
   * see `pollRejoinOnce` (FINDING 1b).
   */
  private connectGeneration = 0;
  /** `connectGeneration` captured when the rejoin poll armed; null when disarmed. */
  private rejoinArmedGeneration: number | null = null;
  /**
   * Guards a user-initiated "Retry now" so a rapid double-click never spawns a
   * second connection build while the first is still in flight — two live
   * handles could otherwise be created (one would leak). Cleared once the retry
   * settles.
   */
  private retryInFlight = false;
  /**
   * MRG-03 conflict resolver. Its per-copy guard makes a double-clicked resolve
   * fire each destructive vault op at most once. Lazily bound to the live vault
   * port on first use so a headless test never needs a real vault.
   */
  private conflictResolver: ReturnType<typeof createConflictResolver> | null = null;
  /**
   * The live durable sync state (SND-01 + MRG-05), captured from the connection
   * handle. Null when disconnected — the send-queue panel then renders nothing
   * and the sweep is a no-op.
   */
  private syncState: DurableSyncState | null = null;
  /**
   * Quarantine revisionIds already announced with a Notice (SND-01). A Notice
   * fires only the FIRST time an item enters quarantine, never on every retry.
   */
  private notifiedQuarantineIds = new Set<string>();
  /**
   * Debounce timer for the MRG-05 auto-repair sweep. A burst of new conflict
   * copies coalesces into a single pass ~2s after the last write.
   */
  private conflictSweepTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** Guards against overlapping sweep runs (a pass in flight when the next fires). */
  private conflictSweepRunning = false;

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
        conflictsProvider: () => listConflictCopies(this.conflictPort()),
        onResolveConflict: (copyPath) => {
          void this.openConflictModal(copyPath);
        },
        sendQueueProvider: () => this.sendQueueView(),
        onRetrySend: (revisionId) => {
          void this.retrySend(revisionId);
        },
        onDiscardSend: (revisionId) => {
          void this.discardSend(revisionId);
        },
        rejoinRosterProvider: () => this.rejoinRosterView(),
        rejoinWaitingProvider: () => this.rejoinWaiting,
        onRejoin: (membershipId) => {
          void this.requestRejoin(membershipId);
        },
        onMarkDisconnected: (membershipId) =>
          this.markMemberDisconnected(membershipId),
        onRemove: (membershipId) => {
          void this.removeMember(membershipId);
        },
        onConnect: (input, serverUrl, report) => {
          void this.connectFromInput(input, serverUrl, report);
        },
        onDisconnect: () => this.disconnect(),
        onRetry: () => {
          void this.retryConnection();
        },
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

    this.addRibbonIcon('hexagon', 'Open Havemind activity', () => {
      void this.openActivityView();
    });

    this.statusItem = this.addStatusBarItem();
    this.statusItem.addClass('havemind-status-bar');
    // The status bar is text-only (setText clobbers children), so the Retry
    // button lives in the panel. Clicking the status bar item opens that panel —
    // the one place the button and full status detail render. The click listener
    // sits on the element itself, so subsequent setStatus text updates keep it.
    this.statusItem.onClickEvent(() => {
      void this.openView(HAVEMIND_ONBOARDING_VIEW);
    });
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
    // Mark unloaded BEFORE anything else so an in-flight `startConnection` await
    // that resolves after this point stops its handle instead of assigning it.
    this.unloaded = true;
    // Cancel any in-flight invitee rejoin poll so it never fires after unload.
    this.disarmRejoin();
    // Cancel any pending auto-repair sweep so it never fires after unload.
    if (this.conflictSweepTimer !== null) {
      globalThis.clearTimeout(this.conflictSweepTimer);
      this.conflictSweepTimer = null;
    }
    this.connection?.stop();
    this.connection = null;
    this.syncState = null;
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
    const handle = await startHavemindConnection(
      this,
      (status, view) => this.handleStatus(status, view),
      this.activityHooks(),
    );
    // Guard the assignment against two races that resolve only after the await:
    //  - FIX 1: the plugin was unloaded while this build was in flight. `onunload`
    //    already ran its `connection?.stop()` on a still-null field, so assigning
    //    now would leave a LIVE handle (vault listeners + sync loop) with no stop
    //    ever reaching it.
    //  - FIX 2: a user-initiated `connectFromInput` established a live connection
    //    while this passive layout-ready connect was still building. Assigning
    //    here would clobber and orphan that handle (its producer/timers never
    //    stopped). The user connection wins; this late handle yields.
    // Either way, stop THIS handle and do not assign — never orphan an existing
    // connection, never leak past unload.
    if (this.unloaded || this.connection !== null) {
      handle.stop();
      return;
    }
    this.connection = handle;
    // Capture the live durable state for the send-queue panel + auto-repair sweep.
    this.syncState = handle.state ?? null;
    // A live connection was (re-)established: advance the generation so any armed
    // rejoin poll that captured an earlier value no-ops instead of tearing this
    // one down (FINDING 1b).
    this.connectGeneration += 1;
    this.adoptSelfMembership(this.connection);
    // MRG-05: on start (after the canonicalization rebase inside the handle
    // build), sweep any pre-existing conflict copies that a persisted ancestor
    // can now auto-merge. Scheduled (debounced) so it runs alongside — not
    // ahead of — the first sync cycle.
    this.scheduleConflictSweep();
  }

  /** Runtime hooks handed to the sync loop so live surfaces stay fed. */
  private activityHooks(): {
    onLocalActivity: (entry: ActivityLogEntry) => void;
    onRemoteActivity: (entry: ActivityLogEntry) => void;
    onConflictWritten: () => void;
    onSendQueueChanged: () => void;
    onFailedToQueueNotified: (revisionId: string) => void;
  } {
    return {
      onLocalActivity: (entry) => this.activityLog.record(entry),
      // FIX 1: a remote-applied revision reaches the Activity feed too, so
      // the other device's edits are no longer invisible.
      onRemoteActivity: (entry) => this.activityLog.record(entry),
      // MRG-05: a new conflict copy schedules a debounced auto-repair sweep.
      onConflictWritten: () => this.scheduleConflictSweep(),
      // MAJOR 1: a successful commit that cleared a stale failed-to-queue row
      // refreshes the panel at once, so the phantom failure disappears.
      onSendQueueChanged: () => this.onboardingView?.refresh(),
      // MINOR 7: commit-recovery already showed a Notice for this failed-to-queue
      // row, so record its id as notified — the panel's quarantine-notice check
      // then skips it, preventing a duplicate Notice for the same event.
      onFailedToQueueNotified: (revisionId) =>
        this.notifiedQuarantineIds.add(revisionId),
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

  /**
   * The Obsidian-backed conflict vault port. `this.app.vault` is not modelled on
   * the ambient `App`, so cast through a local shape rather than patching the
   * shared interface (the port degrades to "no conflicts" for a stub vault).
   */
  private conflictPort(): ConflictVaultPort {
    const app = this.app as unknown as { vault: Parameters<typeof createObsidianConflictPort>[0] };
    return createObsidianConflictPort(app.vault);
  }

  /**
   * Opens the MRG-03 resolve modal for a conflict copy: computes the note-vs-copy
   * diff (text copies with a known target only), then wires the three actions to
   * the shared resolver. After a resolve, the panel re-renders so the resolved
   * row drops out and the section disappears once empty.
   */
  private async openConflictModal(
    copyPath: string,
  ): Promise<ConflictResolveModal | null> {
    const port = this.conflictPort();
    const copy = listConflictCopies(port).find((c) => c.copyPath === copyPath);
    if (copy === undefined) return null;

    let diff: DiffLine[] | null = null;
    if (copy.targetKnown && !copy.isBinary && copy.targetPath !== null) {
      const [mine, theirs] = await Promise.all([
        port.readText(copy.targetPath),
        port.readText(copy.copyPath),
      ]);
      // MINOR 6: a null read means one side is absent; show no diff rather than
      // diffing against a phantom empty string.
      if (mine !== null && theirs !== null) {
        diff = computeLineDiff(mine, theirs);
      }
    }

    if (this.conflictResolver === null) {
      this.conflictResolver = createConflictResolver(port);
    }
    const resolver = this.conflictResolver;
    const run = (action: ResolveAction, modal: ConflictResolveModal): void => {
      void resolver.resolve(copy, action).then((outcome) => {
        // The auto-sweep may have resolved and deleted this copy while the modal
        // was open. keepTheirs aborts as 'vanished' rather than blanking the
        // already-merged note; tell the user and refresh the stale panel/modal.
        if (outcome === 'vanished') {
          new Notice('This conflict was already auto-resolved.');
        }
        modal.close();
        this.onboardingView?.refresh();
      });
    };

    const modal: ConflictResolveModal = new ConflictResolveModal(
      this.app,
      buildConflictModalModel(copy, diff),
      {
        onKeepMine: () => run('keepMine', modal),
        ...(copy.targetKnown && !copy.isBinary
          ? { onKeepTheirs: () => run('keepTheirs', modal) }
          : {}),
        onKeepBoth: () => run('keepBoth', modal),
      },
    );
    modal.open();
    return modal;
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
    // Quiesce any previous connection BEFORE the new loop is built and fires its
    // first cycle. `startSyncLoop` triggers an initial sync synchronously on
    // `controller.start()`, so unless the prior connection is stopped first its
    // runner (and pending backoff) can race a push onto the wire under the old
    // identity during the reconnect window — the stale-identity 403 burst. This
    // is an explicit user-initiated (re)connect, so replacing the connection is
    // the intended outcome; the new identity is the only one that pushes after.
    this.connection?.stop();
    this.connection = null;
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
      // Guard against the plugin being unloaded while the invitee approval poll
      // (up to ~1h) was still in flight: `onunload` already ran its
      // `connection?.stop()` on a still-null field, so assigning this late-
      // resolved handle now would leave it LIVE forever (leaked vault listeners
      // + sync loop). Mirrors the `startConnection` unload guard (FIX 1) — stop
      // this handle and never assign.
      //
      // FIX 3: also yield to a connection assigned MEANWHILE (e.g. the rejoin
      // restart's startConnection completing during this ~1h approval poll).
      // Without the `connection !== null` arm this late handle would clobber and
      // orphan that live connection. Same stop-the-newcomer, keep-the-existing
      // invariant startConnection enforces.
      if (this.unloaded || this.connection !== null) {
        handle.stop();
        return;
      }
      // Connected: the wait is over. The prior connection was already stopped
      // above, before this new loop started, so nothing stale is left to tear
      // down here.
      this.awaitingApproval = null;
      this.guestInvitationInvalid = false;
      this.connection = handle;
      this.syncState = handle.state ?? null;
      // A live connection was (re-)established — advance the generation (FINDING 1b).
      this.connectGeneration += 1;
      // Record this device's own membership as a persistent roster member so the
      // invitee's UI clearly shows it is connected.
      this.adoptSelfMembership(handle);
      // MRG-05: sweep any pre-existing conflict copies now that a base is loaded.
      this.scheduleConflictSweep();
    }
  }

  /** Stops the live sync loop; the paste form returns so the user can reconnect. */
  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.syncState = null;
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
      // Terminal auth failure: arm the invitee rejoin poll so this device
      // re-admits itself once the owner clicks Rejoin — no re-pairing needed.
      void this.armRejoin();
    }
    // SND-01: fire a Notice the first time each item enters quarantine (never on
    // a retry). Runs on every status change — the point sends are dead-lettered.
    this.checkQuarantineNotices();
    this.setStatus(view);
    this.onboardingView?.refresh();
  }

  /**
   * SND-01 send-queue view for the panel, or null when disconnected (no state).
   * Reads outbox ages + quarantine straight from the persisted sync state and
   * resolves each quarantined fileId back to a vault path where one is known.
   */
  private sendQueueView(): SendQueueStatusView | null {
    const state = this.syncState;
    if (state === null) return null;
    return buildSendQueueStatus({
      outbox: state.outboxAges(),
      quarantine: state.quarantineSnapshot().map((item) => {
        const path = state.pathForFileId(item.fileId);
        return {
          revisionId: item.revisionId,
          fileId: item.fileId,
          reason: item.reason,
          ...(path === null ? {} : { path }),
        };
      }),
      now: Date.now(),
    });
  }

  /**
   * Retry a quarantined send. A server-rejected send (SND-01) re-enqueues its
   * stashed envelope through the outbox. A failed-to-queue row (SND-02, MAJOR 2)
   * has no envelope — it never reached the outbox — so Retry re-runs the commit
   * chain for the path against the current on-disk content; if the file has
   * since been deleted, surface a Notice and drop the stale row instead of
   * pushing a phantom empty create for a vanished file.
   */
  private async retrySend(revisionId: string): Promise<void> {
    // Failed-to-queue synthetic row (SND-02): never had an envelope. Leave the
    // row in place on a successful re-trigger — onCommitSuccess (MAJOR 1) clears
    // it once the commit actually goes through.
    const failedPath = parseFailedToQueuePath(revisionId);
    if (failedPath !== null) {
      await this.retryFromDisk(revisionId, failedPath, { discardOnRetrigger: false });
      return;
    }
    // Server-rejected send (SND-01): re-enqueue the stashed envelope. When the
    // stash was evicted under the byte budget (MAJOR 4) the requeue is inert, so
    // fall back to re-committing the file from disk (source of truth) and drop
    // the superseded dead-letter row.
    const requeued = (await this.syncState?.requeueQuarantined(revisionId)) ?? false;
    if (!requeued) {
      const path = this.pathForQuarantineRow(revisionId);
      if (path !== null) {
        await this.retryFromDisk(revisionId, path, { discardOnRetrigger: true });
        return;
      }
    }
    this.onboardingView?.refresh();
  }

  /** The vault path a quarantine row's fileId resolves to, or null. */
  private pathForQuarantineRow(revisionId: string): string | null {
    const state = this.syncState;
    if (state === null) return null;
    const row = state
      .quarantineSnapshot()
      .find((item) => item.revisionId === revisionId);
    return row === undefined ? null : state.pathForFileId(row.fileId);
  }

  /**
   * Re-run the commit chain for `path` from disk (the MAJOR 2 recovery for a row
   * with no usable stashed envelope). A vanished file cannot be re-committed:
   * surface a Notice and drop the stale row. `discardOnRetrigger` drops the row
   * immediately after a successful re-trigger for a superseded server-rejected
   * row (MAJOR 4); a failed-to-queue row keeps its row until the commit lands.
   */
  private async retryFromDisk(
    revisionId: string,
    path: string,
    options: { readonly discardOnRetrigger: boolean },
  ): Promise<void> {
    const retriggered = this.connection?.retryFailedCommit?.(path) ?? false;
    if (!retriggered) {
      new Notice(`${path} no longer exists — removing it from the queue.`);
      await this.syncState?.discardQuarantined(revisionId);
    } else if (options.discardOnRetrigger) {
      await this.syncState?.discardQuarantined(revisionId);
    }
    this.onboardingView?.refresh();
  }

  /** Permanently discard a quarantined send (SND-01). */
  private async discardSend(revisionId: string): Promise<void> {
    await this.syncState?.discardQuarantined(revisionId);
    this.onboardingView?.refresh();
  }

  /**
   * SND-01: emit one Notice per item the FIRST time it enters quarantine. A
   * retry that re-quarantines the same revision is silent — its id is already in
   * `notifiedQuarantineIds`. Discarding then re-quarantining a NEW revision for
   * the same file does notify, which is correct: it is a distinct failed send.
   */
  private checkQuarantineNotices(): void {
    const state = this.syncState;
    if (state === null) return;
    const quarantine = state.quarantineSnapshot().map((item) => ({
      revisionId: item.revisionId,
      fileId: item.fileId,
      reason: item.reason,
      ...(state.pathForFileId(item.fileId) === null
        ? {}
        : { path: state.pathForFileId(item.fileId) as string }),
    }));
    const { fresh, next } = selectNewlyQuarantined(
      this.notifiedQuarantineIds,
      quarantine,
    );
    this.notifiedQuarantineIds = new Set(next);
    for (const item of fresh) {
      const label = item.path ?? item.fileId;
      new Notice(
        `A change to ${label} could not be sent — see the Havemind panel.`,
      );
    }
  }

  /**
   * MRG-05: schedule a single debounced auto-repair sweep. A burst of new
   * conflict copies (or a start-up call plus a runtime write) collapses into one
   * pass ~2s after the last trigger. The sweep only writes notes (outside the
   * reserved folder) and deletes resolved copies (inside it), and the trigger
   * keys off NEW copy writes only, so a sweep never re-schedules itself.
   */
  private scheduleConflictSweep(): void {
    if (this.conflictSweepTimer !== null) {
      globalThis.clearTimeout(this.conflictSweepTimer);
    }
    this.conflictSweepTimer = globalThis.setTimeout(() => {
      this.conflictSweepTimer = null;
      void this.runConflictSweep();
    }, CONFLICT_SWEEP_DEBOUNCE_MS);
  }

  /**
   * Runs one auto-repair pass (MRG-05). Reuses the persisted merge ancestor +
   * base hash from the sync state; a copy with no hash-verified ancestor is left
   * untouched for the manual modal. A guard prevents overlapping runs. Refreshes
   * the panel afterwards so a resolved conflict's row drops out.
   */
  private async runConflictSweep(): Promise<void> {
    const state = this.syncState;
    if (state === null || this.conflictSweepRunning) return;
    this.conflictSweepRunning = true;
    try {
      await sweepConflictCopies({
        port: this.conflictPort(),
        fileIdAtPath: (path) => state.fileIdAtPath(path),
        baseContentFor: (fileId) => state.baseContentFor(fileId),
        baseHashFor: (fileId) => state.baseHashFor(fileId),
        hashContent: (content) => hashPlaintext(content),
        notify: (message) => {
          new Notice(`Havemind: ${message}`);
        },
      });
    } finally {
      this.conflictSweepRunning = false;
    }
    this.onboardingView?.refresh();
  }

  /** The rejoin-aware roster projection over the persistent members. */
  private rejoinRosterView(): RejoinRosterView {
    return buildRejoinRosterView(this.rosterMembers, this.deadMembershipIds);
  }

  /**
   * Owner action (pilot heuristic): assert a connected contact has fallen off so
   * their row offers Rejoin. No server liveness signal reaches the owner yet, so
   * "disconnected" is owner-driven — see renderRejoinRoster.
   */
  private markMemberDisconnected(membershipId: string): void {
    if (!this.deadMembershipIds.includes(membershipId)) {
      this.deadMembershipIds = [...this.deadMembershipIds, membershipId];
    }
    this.onboardingView?.refresh();
  }

  /**
   * Owner action: issue a rejoin grant for a known-dead contact via the existing
   * authenticated transport, then show "waiting for <name> to reconnect" until
   * the roster refreshes. Nothing secret is sent or shown.
   */
  private async requestRejoin(membershipId: string): Promise<void> {
    try {
      const waiting = await requestRejoinGrantForOwner(this, { membershipId });
      if (waiting === null) {
        new Notice('Havemind: connect as the vault owner before rejoining a member.');
        return;
      }
      this.rejoinWaiting = new Set([...this.rejoinWaiting, membershipId]);
      this.onboardingView?.refresh();
    } catch (error) {
      new Notice(
        `Havemind: could not request rejoin — ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  /**
   * Owner action: permanently remove a member from the vault. Revokes the
   * membership server-side (append-only — the member's past revisions and
   * attribution survive; their sessions are burned and they are terminally
   * locked out), then drops the member from the local roster and clears any
   * dead/waiting markers so no stale Rejoin affordance lingers. This is a
   * control-plane action and records nothing in the Activity feed. On success a
   * confirmation Notice names the removed member.
   */
  private async removeMember(membershipId: string): Promise<void> {
    const member = this.rosterMembers.find(
      (entry) => entry.membershipId === membershipId,
    );
    const displayName = member?.displayName ?? 'member';
    try {
      const removed = await revokeMembershipForOwner(this, { membershipId });
      if (removed === null) {
        new Notice(
          'Havemind: connect as the vault owner before removing a member.',
        );
        return;
      }
      this.rosterMembers = await this.rosterStore().removeMember(membershipId);
      this.deadMembershipIds = this.deadMembershipIds.filter(
        (id) => id !== membershipId,
      );
      this.rejoinWaiting = new Set(
        [...this.rejoinWaiting].filter((id) => id !== membershipId),
      );
      new Notice(`Removed ${displayName} from the vault.`);
      this.onboardingView?.refresh();
      this.activityView?.refresh();
    } catch (error) {
      new Notice(
        `Havemind: could not remove member — ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  /**
   * Invitee side: arm the rejoin poll after a terminal auth failure. Idempotent
   * — a second terminal status while a poll is already armed is a no-op, so the
   * poll is never doubled. Builds the controller from this device's persisted
   * (membershipId, deviceId); if none is stored there is nothing to rejoin with.
   */
  private async armRejoin(): Promise<void> {
    if (this.rejoinController !== null) return;
    const controller = await buildRejoinControllerForInvitee(this);
    // The build awaits plugin data; guard against unload racing it and against a
    // second arm having won while we awaited.
    if (controller === null || this.unloaded || this.rejoinController !== null) {
      return;
    }
    this.rejoinController = controller;
    this.rejoinRestarted = false;
    // Snapshot the connect generation so a poll tick can tell whether the
    // connection has been rebuilt since (FINDING 1b).
    this.rejoinArmedGeneration = this.connectGeneration;
    // registerInterval so unload tears the poll down; the panel polls redemption
    // every REJOIN_POLL_INTERVAL_MS until the owner's grant lands.
    const timer = globalThis.setInterval(() => {
      void this.pollRejoinOnce();
    }, REJOIN_POLL_INTERVAL_MS);
    // `registerInterval` clears the timer on unload; the Obsidian runtime hands
    // a numeric id while Node's types surface a Timeout object — cast the id at
    // this single boundary rather than reshaping the platform declaration.
    this.registerInterval(timer as unknown as number);
    this.rejoinPollTimer = timer;
  }

  /**
   * One rejoin poll tick. Presents the persisted binding; on the first
   * 'syncing' result it disarms and restarts the connection exactly once (the
   * `rejoinRestarted` guard plus the controller's own idempotency prevent a
   * double-start). If unload raced the in-flight attempt, it cancels cleanly.
   */
  private async pollRejoinOnce(): Promise<void> {
    const controller = this.rejoinController;
    if (controller === null || this.rejoinRestarted || this.unloaded) return;
    // FINDING 1b: if the connection was re-established since this poll armed
    // (Retry now, a fresh user connect, a rejoin restart — anything that assigns
    // a new handle bumps `connectGeneration`), this poll is stale. Presenting the
    // binding now would drive a 'syncing' result that stops + restarts the
    // healthy connection. Disarm and bail instead of thrashing it.
    if (
      this.rejoinArmedGeneration !== null &&
      this.connectGeneration !== this.rejoinArmedGeneration
    ) {
      this.disarmRejoin();
      return;
    }
    const result = await controller.attempt();
    if (this.unloaded || this.rejoinRestarted) return;
    if (typeof result === 'object' && result.status === 'syncing') {
      this.rejoinRestarted = true;
      this.disarmRejoin();
      await this.restartConnectionAfterRejoin();
      return;
    }
    // FIX 4: 'rejoin-failed' is terminal and unrecoverable by polling (the
    // server returned a 200 the controller could not use). Leaving the 30 s
    // poll armed spins forever in silence, so disarm it and surface the failure
    // to the user. The manual retry path: a later terminal-auth status (the user
    // reconnecting) re-arms the poll from scratch, since disarmRejoin cleared
    // `rejoinController`.
    if (result === 'rejoin-failed') {
      this.disarmRejoin();
      this.connectionError =
        'Rejoin failed — the server rejected the automatic rejoin. Reconnect manually to resume syncing.';
      this.setStatus(formatStatusBar({ status: 'reconnect-required' }));
      new Notice(
        'Havemind: rejoin failed. Reconnect manually to resume syncing.',
      );
      this.onboardingView?.refresh();
    }
  }

  /** Tears the invitee rejoin poll down (idempotent). */
  private disarmRejoin(): void {
    if (this.rejoinPollTimer !== null) {
      globalThis.clearInterval(this.rejoinPollTimer);
      this.rejoinPollTimer = null;
    }
    this.rejoinController = null;
    this.rejoinArmedGeneration = null;
  }

  /**
   * Restarts the connection after a successful rejoin. The fresh refresh token
   * is already persisted, so startConnection resumes sync under the SAME
   * membership. Follows the established invariant: stop-previous → await →
   * guard-against-unload → assign (the guard lives inside startConnection).
   */
  private async restartConnectionAfterRejoin(): Promise<void> {
    this.connection?.stop();
    this.connection = null;
    await this.startConnection();
  }

  /**
   * User-initiated "Retry now": force an immediate reconnect from a non-synced
   * backoff/terminal state instead of waiting out the sync runner's backoff.
   * Reuses the SAME startConnection code path as the layout-ready autostart
   * (stop-previous → await → guard-against-unload/clobber → assign, the guard
   * lives inside startConnection) rather than inventing a parallel connect.
   *
   * Idempotent under a rapid double-click: the `retryInFlight` guard makes the
   * second click a no-op while the first build is still awaiting, so two live
   * handles can never be created.
   *
   * Terminal reconnect-required (auth-dead) choice: restart FIRST. The persisted
   * refresh token may still work, so a plain restart is the option that cannot
   * make things worse.
   *
   * FINDING 1a: disarm any armed invitee rejoin poll BEFORE restarting. Leaving
   * it armed lets a stale 30 s tick fire against the connection this retry just
   * rebuilt — attempt() → 'syncing' → stop + restart — thrashing a healthy
   * connection up to 30 s after the user fixed it. The fallback is not lost: if
   * the restart lands back in reconnect-required, `handleStatus` re-arms the poll
   * from scratch.
   */
  private async retryConnection(): Promise<void> {
    if (this.retryInFlight) return;
    this.retryInFlight = true;
    try {
      this.disarmRejoin();
      this.connection?.stop();
      this.connection = null;
      await this.startConnection();
    } finally {
      this.retryInFlight = false;
    }
  }

  /**
   * A short human-readable connection status line for the settings tab (MINOR 9).
   * Reuses the same panel view-model the pane renders, so the wording stays in
   * lockstep with the live indicator.
   */
  panelStatusLabel(): string {
    return this.connectionPanel().label;
  }

  /** Opens (or reveals) the Havemind pane — the settings tab's one action. */
  revealPanel(): void {
    void this.openView(HAVEMIND_ONBOARDING_VIEW);
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
