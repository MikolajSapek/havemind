import {
  Notice,
  Plugin,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';

import { hashPlaintext } from '@havemind/protocol';

import {
  buildLivePreviewOverlay,
  buildReadingViewOverlay,
} from './attribution/attribution';
import { buildFileOverlayInput } from './attribution/overlay-source';
import { createAuthorOverlayExtension } from './attribution/editor-extension';
import {
  createAuthorReadingViewProcessor,
  type ReadingViewSectionInfo,
} from './attribution/reading-view';
import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import { parseFailedToQueuePath } from './runtime/sync-state';
import type { DurableSyncState } from './runtime/sync-state';
import {
  computeLineDiff,
  createConflictResolver,
  createObsidianConflictPort,
  listConflictCopies,
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
import {
  createSerializedDataPort,
  getPluginDataMutex,
} from './runtime/plugin-data-mutex';
import { RerunGuard } from './runtime/rerun-guard';
import { restoreActivityEntry } from './runtime/activity-restore';
import {
  ActivityLog,
  activityEntriesToRecords,
  type ActivityLogEntry,
} from './runtime/activity-log';
import { RosterStore, type RosterMember } from './runtime/roster';
import {
  buildRejoinRosterView,
  type RejoinRosterView,
} from './runtime/rejoin-roster';
import {
  REJOIN_POLL_INTERVAL_MS,
  type RejoinController,
  type RejoinResumed,
  type RejoinState,
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
  resetHavemindConnectionState,
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

import {
  HavemindActivityView,
  type ActivityViewOptions,
} from './ui/activity-view';
import {
  ConflictResolveModal,
  buildConflictModalModel,
} from './ui/conflict-modal';
import {
  HavemindOnboardingView,
  type ConnectReporter,
  type CreateConnectionViewModel,
  type GuestWaitingViewModel,
  type InvitationRole,
  type PendingApprovalEntry,
} from './ui/onboarding-view';
import {
  DECORATIVE,
  formatActivityTime,
  prefersReducedMotion,
} from './ui/primitives';
import {
  planQuarantineRequeueFallback,
  planRetryFromDisk,
} from './ui/retry-plan';
import { HavemindSettingTab, formatMemberCount } from './ui/setting-tab';
import type {
  HavemindConnectionActions,
  HavemindSettingsInfo,
} from './ui/settings-model';
import {
  HAVEMIND_ACTIVITY_VIEW,
  HAVEMIND_ONBOARDING_VIEW,
} from './ui/view-types';

// The view classes, section renderers, modal, settings tab and pure planners now
// live under `./ui`. They are re-exported here so `./main` remains the single
// import surface it has always been for the plugin's tests and for anything that
// reads the bundle entry point — moving a file must not move a public name.
export {
  HAVEMIND_ACTIVITY_VIEW,
  HAVEMIND_ONBOARDING_VIEW,
} from './ui/view-types';
export type { ActivityViewOptions } from './ui/activity-view';
export {
  renderConflictSection,
  type ConflictSectionActions,
} from './ui/conflict-section';
export {
  renderRecoveryNotice,
  renderSendQueueSection,
  type SendQueueSectionActions,
} from './ui/send-queue-section';
export {
  ConflictResolveModal,
  buildConflictModalModel,
  renderConflictModalBody,
  type ConflictModalActions,
  type ConflictModalModel,
} from './ui/conflict-modal';
export {
  HavemindOnboardingView,
  type ConnectReporter,
  type CreateConnectionViewModel,
  type GuestWaitingViewModel,
  type InvitationRole,
  type OnboardingViewOptions,
  type PendingApprovalEntry,
} from './ui/onboarding-view';
export type {
  HavemindConnectionActions,
  HavemindSettingsInfo,
} from './ui/settings-model';
export {
  planQuarantineRequeueFallback,
  planRetryFromDisk,
  type QuarantineRequeueFallback,
  type RetryFromDiskEffect,
} from './ui/retry-plan';

/** Debounce window for the MRG-05 auto-repair sweep — a burst becomes one pass. */
const CONFLICT_SWEEP_DEBOUNCE_MS = 2000;

/** `data.json` key holding the F6 "Show authors" toggle. */
const SHOW_AUTHORS_KEY = 'showAuthors';

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
  /**
   * True once the user opened an `obsidian://havemind-join` link, which answers
   * the entry chooser on their behalf: they hold an invitation (design 1d).
   */
  private arrivedWithInvitation = false;
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
   * Guards the user-initiated "Reset connection" (P1 #5) so a double-click can
   * never run two overlapping clear-and-rewrite passes over `data.json`.
   */
  private resetInFlight = false;
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
  /**
   * Serialises sweep runs AND re-arms one more pass when a trigger arrives
   * mid-run — so a conflict copy written while a sweep is in flight is not
   * dropped (MINOR); the guarded no-op used to leave it un-swept.
   */
  private readonly conflictSweepGuard = new RerunGuard(() =>
    this.runConflictSweepOnce(),
  );
  /**
   * F6 author overlay: whether "Show authors" is on for this vault. OFF by
   * default — attribution decoration changes how every note looks, so it is
   * opt-in. Persisted under `showAuthors` in `data.json` through the shared
   * plugin-data mutex; a data.json that cannot be read leaves the flag
   * session-only rather than blocking load.
   */
  private showAuthors = false;
  /**
   * True once the user has decided for this session. `restoreAuthorOverlayFlag`
   * runs asynchronously from `onload`, so a toggle can land BEFORE the stored
   * value comes back off disk; without this guard the restore would silently
   * undo that toggle and then persist the undone value.
   */
  private authorOverlayChosen = false;

  override onload(): void {
    // Wire the Activity view to the live feed: the log snapshot is mapped through
    // the roster so each row shows the author's display name + colour. Without
    // this the view was orphaned and always rendered the empty placeholder.
    this.activityOptions = {
      feedProvider: () =>
        activityEntriesToRecords(this.activityLog.snapshot(), this.rosterMembers),
      onRestore: (revisionId) => this.handleRestore(revisionId),
    };
    // Both surfaces read the same log, so both must repaint when it moves: the
    // pane now carries the activity feed as a section (plans/007 Stage 0) while
    // the standalone view stays registered for anyone who already has it open
    // in a leaf.
    this.activityLogUnsubscribe = this.activityLog.subscribe(() => {
      this.activityView?.refresh();
      this.onboardingView?.refresh();
    });

    this.registerView(HAVEMIND_ACTIVITY_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindActivityView(leaf, this.activityOptions);
      this.activityView = view;
      return view;
    });
    this.registerView(HAVEMIND_ONBOARDING_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindOnboardingView(leaf, {
        // The activity feed is a section of this pane now, not a separate
        // destination (plans/007 Stage 0) — same providers the standalone
        // Activity view reads, so the two can never disagree.
        activityFeedProvider: () => this.activityOptions.feedProvider?.() ?? [],
        onRestore: (revisionId) => this.handleRestore(revisionId),
        // The overlay toggle lost its ribbon icon in Stage 0 and lives in the
        // pane footer now, beside the vault it annotates.
        authorOverlayProvider: () => this.authorOverlayEnabled(),
        onToggleAuthorOverlay: () => this.toggleAuthorOverlay(),
        arrivedWithInvitationProvider: () => this.arrivedWithInvitation,
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
        recoveryRequiredProvider: () =>
          this.syncState?.isRecoveryRequired() ?? false,
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
        onReset: () => {
          void this.resetConnection();
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
    // The three connection actions the panel exposes as buttons also belong in
    // the palette, so they can be run — and bound to a hotkey — without hunting
    // for the pane. `checkCallback` reports availability: syncing and
    // disconnecting are meaningless with nothing connected, so they grey out
    // rather than fail on invocation.
    const actions = this.connectionActions();
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      checkCallback: (checking) => {
        if (checking) return actions.connected();
        actions.syncNow();
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect',
      name: 'Disconnect',
      checkCallback: (checking) => {
        if (checking) return actions.connected();
        actions.disconnect();
        return true;
      },
    });
    // Reset carries no availability guard on purpose: it exists for the state in
    // which the stored pairing is damaged, and that state is not always
    // detectable up front — a user who needs it must always be able to reach it.
    this.addCommand({
      id: 'reset-connection',
      name: 'Reset connection',
      callback: () => {
        actions.resetConnection();
      },
    });
    // F6 author overlay: the one control that turns both surfaces on and off.
    // No availability guard — with nothing recorded yet the overlay simply draws
    // nothing, which is a legitimate state rather than an unavailable action.
    this.addCommand({
      id: 'show-authors',
      name: 'Show authors',
      callback: () => this.toggleAuthorOverlay(),
    });

    // One hexagon, one pane (plans/007 Stage 0). The plugin used to offer three
    // doors — this icon for the activity feed, a second icon for the author
    // overlay, and the command palette for the panel that actually connects a
    // vault. A new user found the hexagon, got an activity list, and had no
    // route to connecting anything. The overlay toggle now lives inside the
    // pane and keeps its `show-authors` command, so removing its icon costs no
    // keyboard or screen-reader access (F8-02d).
    this.addRibbonIcon('hexagon', 'Open Havemind', () => {
      void this.openHavemindPane();
    });

    // FINDING 1: both author-overlay surfaces promised by `specs/001-mvp.md`.
    // Obsidian owns their lifecycle — a registered editor extension and markdown
    // post processor are torn down with the plugin — and both read the live flag
    // and the live Activity feed through closures, so nothing else is retained.
    this.registerEditorExtension(
      createAuthorOverlayExtension({
        overlayFor: (path, content) => {
          const input = this.overlayInputFor(path, content);
          return input === null ? null : buildLivePreviewOverlay(input);
        },
      }),
    );
    this.registerMarkdownPostProcessor(
      createAuthorReadingViewProcessor({
        overlayFor: (path, content, section) =>
          this.readingViewOverlay(path, content, section),
      }),
    );
    // Restore the persisted toggle. Fire-and-forget: onload must not wait on
    // disk, and a failure leaves the overlay off rather than blocking startup.
    void this.restoreAuthorOverlayFlag();

    this.statusItem = this.addStatusBarItem();
    this.statusItem.addClass('havemind-status-bar');
    // The status bar is text-only (setText clobbers children), so the Retry
    // button lives in the panel. Clicking the status bar item opens that panel —
    // the one place the button and full status detail render. The click listener
    // sits on the element itself, so subsequent setStatus text updates keep it.
    this.statusItem.onClickEvent(() => {
      void this.openView(HAVEMIND_ONBOARDING_VIEW);
    });
    // The item is a real control, so it must say so and be reachable without a
    // mouse: the role and name make it announce itself as "Open Havemind panel,
    // button", the tabindex puts it in the tab order, and Enter/Space open the
    // same panel the click opens. Attributes live on the element itself, so the
    // setStatus rebuild (which only replaces children) keeps them.
    this.statusItem.setAttribute('role', 'button');
    this.statusItem.setAttribute('tabindex', '0');
    this.statusItem.setAttribute('aria-label', 'Open Havemind panel');
    this.statusItem.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Space would otherwise scroll the pane behind the status bar.
      event.preventDefault();
      void this.openView(HAVEMIND_ONBOARDING_VIEW);
    });
    this.setStatus(formatStatusBar({ status: 'disconnected' }));

    this.addSettingTab(new HavemindSettingTab(this.app, this));

    this.registerObsidianProtocolHandler('havemind-join', (data) => {
      // The secret invitation is never accepted from the URI query. Only the
      // parameter-free passive URI opens the local paste wizard; any query
      // field (token, envelope, secret, or otherwise) is refused.
      if (!isSafePassiveJoinProtocolData(data)) return;
      // A passive join URI belongs to the guest paste wizard, not the owner
      // composer.
      this.connectionActive = false;
      // Arriving through havemind-join *is* the answer to the entry chooser:
      // this user has an invitation. Asking them anyway would be asking a
      // question they have already answered by clicking the link (design 1d).
      this.arrivedWithInvitation = true;
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
    // Route the roster's read-modify-save through the shared per-plugin mutex so
    // a concurrent write to another data.json key (sync state, producer,
    // onboarding) is never clobbered (MAJOR).
    return new RosterStore({
      persist: createSerializedDataPort(getPluginDataMutex(this)),
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

  /**
   * Command-palette "Sync now": force an immediate cycle instead of waiting for
   * the loop's own schedule. The connection handle exposes no direct sync entry
   * point, so this reuses the panel's "Retry now" path — stop the running loop,
   * start a fresh one — which is exactly the forced cycle the button performs.
   *
   * The palette greys the command out while nothing is connected, so this guard
   * is the belt to that braces: a direct invocation explains itself rather than
   * looking like a silent no-op.
   */
  private async syncNow(): Promise<void> {
    if (this.connection === null) {
      new Notice('Havemind: connect before syncing.');
      return;
    }
    await this.retryConnection();
  }

  /** Stops the live sync loop; the paste form returns so the user can reconnect. */
  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.syncState = null;
    // Tear down any armed invitee rejoin poll, matching retryConnection/onunload
    // — otherwise a disconnected device keeps polling the server for a rejoin
    // grant it will never act on (NIT).
    this.disarmRejoin();
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
    if (status === 'reset-required') {
      // The stored connection is damaged (P1 #5): drop any stale server-side
      // error so the panel shows its own "reset and pair again" explanation, and
      // never arm the rejoin poll — a rejoin cannot fix a broken local record.
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
    // the superseded dead-letter row. FINDING 2: when the fileId no longer
    // resolves to a path there is nothing to re-commit, so surface a Notice and
    // discard the dead-letter row rather than leaving Retry a silent no-op.
    const requeued = (await this.syncState?.requeueQuarantined(revisionId)) ?? false;
    const fallback = planQuarantineRequeueFallback(
      requeued,
      this.pathForQuarantineRow(revisionId),
    );
    if (fallback.kind === 'retry-from-disk') {
      await this.retryFromDisk(revisionId, fallback.path, {
        discardOnRetrigger: true,
      });
      return;
    }
    if (fallback.kind === 'discard-dead-letter') {
      new Notice(fallback.notice);
      await this.syncState?.discardQuarantined(revisionId);
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
   * with no usable stashed envelope). FINDING 1: the retry outcome is tri-state.
   * Only a CONFIRMED-missing file drops the row; `unavailable` (debouncer
   * disposed) and a null/uncallable connection — the common state for a durable
   * row after a restart, before reconnect — keep the row and tell the user to
   * reconnect, so a real unsynced change is never silently discarded.
   * `discardOnRetrigger` drops the row immediately after a real re-trigger for a
   * superseded server-rejected row (MAJOR 4); a failed-to-queue row keeps its
   * row until the commit lands.
   */
  private async retryFromDisk(
    revisionId: string,
    path: string,
    options: { readonly discardOnRetrigger: boolean },
  ): Promise<void> {
    const outcome = this.connection?.retryFailedCommit?.(path);
    const effect = planRetryFromDisk(outcome, path, options.discardOnRetrigger);
    if (effect.notice !== null) new Notice(effect.notice);
    if (effect.discard) await this.syncState?.discardQuarantined(revisionId);
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
    if (this.syncState === null) return;
    // The guard serialises passes and re-arms one more run if a copy is written
    // mid-sweep, so a mid-run trigger is never silently dropped (MINOR).
    await this.conflictSweepGuard.trigger();
  }

  /** One sweep pass. Called only via {@link conflictSweepGuard}. */
  private async runConflictSweepOnce(): Promise<void> {
    const state = this.syncState;
    if (state === null) return;
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
    let result: RejoinState | RejoinResumed;
    try {
      result = await controller.attempt();
    } catch {
      // FIX C1: attempt() can reject if the post-200 refresh-token save throws
      // (SecretStorage/keychain write). The controller normally converts that to
      // 'rejoin-failed', but a raw throw must never escape here as an unhandled
      // rejection that leaves the 30 s poll spinning against a burned grant in
      // silence. Route it to the same surfaced terminal path.
      if (this.unloaded || this.rejoinRestarted) return;
      this.surfaceRejoinFailed();
      return;
    }
    if (this.unloaded || this.rejoinRestarted) return;
    if (typeof result === 'object' && result.status === 'syncing') {
      this.rejoinRestarted = true;
      this.disarmRejoin();
      await this.restartConnectionAfterRejoin();
      return;
    }
    // FIX 4: 'rejoin-failed' is terminal and unrecoverable by polling (the
    // server returned a 200 the controller could not use, or the post-200 save
    // failed). Leaving the 30 s poll armed spins forever in silence, so disarm
    // it and surface the failure to the user. The manual retry path: a later
    // terminal-auth status (the user reconnecting) re-arms the poll from
    // scratch, since disarmRejoin cleared `rejoinController`.
    if (result === 'rejoin-failed') {
      this.surfaceRejoinFailed();
    }
  }

  /**
   * Disarm the doomed poll and surface a terminal rejoin failure to the user
   * (status + Notice), leaving a manual reconnect as the only retry path. Shared
   * by the 'rejoin-failed' controller result and a raw throw from attempt().
   */
  private surfaceRejoinFailed(): void {
    this.disarmRejoin();
    this.connectionError =
      'Rejoin failed — the server rejected the automatic rejoin. Reconnect manually to resume syncing.';
    this.setStatus(formatStatusBar({ status: 'reconnect-required' }));
    new Notice(
      'Havemind: rejoin failed. Reconnect manually to resume syncing.',
    );
    this.onboardingView?.refresh();
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
   * User-initiated "Reset connection" (P1 #5): clear the damaged persisted
   * pairing so this device can be paired again. This is the supported form of the
   * manual "delete data.json" the field incident needed.
   *
   * Order: quiesce first (stop the loop, disarm the rejoin poll) so nothing
   * re-writes the keys mid-reset, then clear disk + secrets, then drop the
   * in-memory mirrors of what was just cleared (roster, send-queue state,
   * pending invitation/approval) and return the panel to `disconnected`.
   *
   * Idempotent under a rapid double-click via `resetInFlight`. No vault content
   * is touched: notes on disk are the source of truth and are re-reconciled once
   * the device is paired again.
   */
  private async resetConnection(): Promise<void> {
    if (this.resetInFlight) return;
    this.resetInFlight = true;
    try {
      this.disarmRejoin();
      this.connection?.stop();
      this.connection = null;
      this.syncState = null;
      await resetHavemindConnectionState(this);
      this.rosterMembers = [];
      this.deadMembershipIds = [];
      this.rejoinWaiting = new Set<string>();
      this.pendingInvitation = null;
      this.pendingApprovals = [];
      this.notifiedQuarantineIds = new Set<string>();
      this.awaitingApproval = null;
      this.guestInvitationInvalid = false;
      this.connectionActive = false;
      this.connectionNotice = undefined;
      this.connectionNoticeKind = undefined;
      this.connectionStatus = 'disconnected';
      this.lastSyncedAt = undefined;
      this.connectionError = undefined;
      this.setStatus(formatStatusBar({ status: 'disconnected' }));
      new Notice(
        'Havemind: connection reset. Paste a new invitation or pairing token to connect.',
      );
    } catch (error) {
      new Notice(
        `Havemind: could not reset the connection — ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    } finally {
      this.resetInFlight = false;
      this.onboardingView?.refresh();
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

  /** Opens (or reveals) the Havemind pane. */
  revealPanel(): void {
    void this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  /**
   * The three connection actions plus their availability, in one place. Both the
   * command palette entries (see `onload`) and the settings-tab buttons call
   * through here, so neither surface holds its own copy of what an action does.
   */
  connectionActions(): HavemindConnectionActions {
    return {
      syncNow: () => {
        void this.syncNow();
      },
      disconnect: () => {
        this.disconnect();
      },
      resetConnection: () => {
        void this.resetConnection();
      },
      connected: () => this.connection !== null,
    };
  }

  /** The read-only summary the settings tab renders (FINDING 7). */
  settingsInfo(): HavemindSettingsInfo {
    const serverName = this.connection?.serverName ?? '';
    return {
      server: serverName.length === 0 ? 'Not connected' : serverName,
      status: this.panelStatusLabel(),
      lastSync:
        this.lastSyncedAt === undefined
          ? 'Not yet'
          : formatActivityTime(this.lastSyncedAt),
      members: formatMemberCount(this.rosterMembers.length),
      connected: this.connection !== null,
    };
  }

  /** Whether the F6 author overlay is currently drawing. */
  authorOverlayEnabled(): boolean {
    return this.showAuthors;
  }

  /**
   * The "Show authors" action, shared by the command, the ribbon and the
   * settings tab. Holds no listener of its own: both overlay surfaces read this
   * flag through a closure, so flipping it plus asking Obsidian to re-run the
   * registered editor extensions is the whole effect. Reading view redraws on
   * its next render, which the Notice says out loud rather than leaving the user
   * wondering why one pane changed and the other did not.
   */
  toggleAuthorOverlay(): void {
    this.showAuthors = !this.showAuthors;
    this.authorOverlayChosen = true;
    this.app.workspace.updateOptions?.();
    new Notice(
      `Havemind: author overlay ${
        this.showAuthors ? 'on' : 'off'
      }. Reading view updates on its next render.`,
    );
    void this.persistAuthorOverlayFlag();
  }

  /** Reads the persisted "Show authors" flag; absent or unreadable means off. */
  private async restoreAuthorOverlayFlag(): Promise<void> {
    try {
      const stored = await getPluginDataMutex(this).load();
      // A toggle that landed while this read was in flight wins: the user's
      // explicit choice must never be undone by the value it just replaced.
      if (this.authorOverlayChosen) return;
      this.showAuthors = stored[SHOW_AUTHORS_KEY] === true;
      if (this.showAuthors) {
        this.app.workspace.updateOptions?.();
      }
    } catch {
      // data.json is unreadable (the corrupt-file state P1 #5 exists for). The
      // overlay stays off for this session; never block load over a preference.
    }
  }

  /** Persists the flag without disturbing any other `data.json` key. */
  private async persistAuthorOverlayFlag(): Promise<void> {
    try {
      await getPluginDataMutex(this).update((current) => ({
        ...current,
        [SHOW_AUTHORS_KEY]: this.showAuthors,
      }));
    } catch {
      // Same as above: the toggle simply stays session-only.
    }
  }

  /**
   * Overlay input for one file, honestly degraded to whole-file attribution —
   * see `attribution/overlay-source.ts` for why per-line is not derivable yet.
   */
  private overlayInputFor(
    path: string | null,
    content: string,
  ): ReturnType<typeof buildFileOverlayInput> {
    return buildFileOverlayInput({
      enabled: this.showAuthors,
      path,
      content,
      entries: this.activityLog.snapshot(),
      roster: this.rosterMembers,
      reducedMotion: prefersReducedMotion(),
      formatTimestamp: formatActivityTime,
    });
  }

  /** The Reading-view overlay for the one block Obsidian just rendered. */
  private readingViewOverlay(
    path: string,
    content: string,
    section: ReadingViewSectionInfo,
  ): ReturnType<typeof buildReadingViewOverlay> | null {
    const input = this.overlayInputFor(path, content);
    if (input === null) return null;
    return buildReadingViewOverlay(input, [
      {
        blockId: `${path}:${section.lineStart}-${section.lineEnd}`,
        section: { lineStart: section.lineStart, lineEnd: section.lineEnd },
      },
    ]);
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
  /**
   * Closes the owner composer and returns to the connection panel. Clearing
   * `connectionActive` is what makes Done a real exit: `render()` gives the
   * composer priority and returns before drawing the status indicator, so
   * leaving the composer open would hide "Connected — synced" indefinitely and
   * read as if the vault had disconnected.
   */
  private dismissInvitation(): void {
    this.pendingInvitation = null;
    this.connectionActive = false;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.onboardingView?.refresh();
  }

  /** Stores the created invitation so the onboarding view can display it. */
  setPendingInvitation(invitation: CreatedInvitation | null): void {
    this.pendingInvitation = invitation;
  }

  private setStatus(view: StatusBarView): void {
    const item = this.statusItem;
    if (item === null) return;
    // A leading hive-hexagon glyph precedes the stable label. setText would
    // clobber the glyph, so rebuild the item: glyph first, then the same text
    // in a trailing span. The label string and tooltip are unchanged.
    item.empty();
    const glyph = item.createEl('span', { attr: DECORATIVE });
    setIcon(glyph, 'hexagon');
    item.createEl('span', { text: view.text });
  }

  /** Supplies the Activity view with a live feed and a restore action. */
  setActivityOptions(options: ActivityViewOptions): void {
    this.activityOptions = options;
  }

  /**
   * The single door into the plugin (plans/007 Stage 0). Every entry point —
   * the ribbon hexagon, `open-activity`, `connect` — resolves here, so the user
   * never has to know which of two panes holds the thing they want. `openView`
   * reuses an existing leaf, so asking twice focuses the pane rather than
   * opening a second copy of it.
   */
  private openHavemindPane(): Promise<void> {
    return this.openView(HAVEMIND_ONBOARDING_VIEW);
  }

  private openActivityView(): Promise<void> {
    return this.openHavemindPane();
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
