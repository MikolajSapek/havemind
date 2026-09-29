import {
  Notice,
  Platform,
  Plugin,
  type WorkspaceLeaf,
} from 'obsidian';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';
import type { DurableSyncState } from './runtime/sync-state';
import { getPluginDataMutex } from './runtime/plugin-data-mutex';
import { restoreRevision, type RestoreDeps } from './runtime/activity-restore';
import { ActivityLog, activityEntriesToRecords } from './runtime/activity-log';
import type { RuntimeHooks } from './runtime/adapters/runtime-hooks';
import { forgetSharedAccessProvider } from './runtime/adapters/shared-access-provider';
import { buildRejoinRosterView } from './runtime/rejoin-roster';
import {
  buildConnectionPanel,
  formatStatusBar,
  type ConnectionPanelView,
  type ConnectionStatus,
  type StatusBarView,
} from './runtime/status';
import {
  connectFromInput,
  resetHavemindConnectionState,
  startHavemindConnection,
  type ConnectionHandle,
} from './runtime/obsidian-adapters';
import {
  browserClipboardCopyDeps,
  copyTextToClipboard,
} from './runtime/clipboard';

import { registerCommands } from './plugin/commands';
import { Conflicts } from './plugin/conflicts';
import { errorMessage } from './plugin/error-message';
import { Invitations } from './plugin/invitations';
import { People } from './plugin/people';
import { InviteeRejoin } from './plugin/rejoin';
import { SendQueue } from './plugin/send-queue';
import { StatusBar } from './plugin/status-bar';
import { ConfirmModal } from './ui/confirm-modal';
import {
  HavemindOnboardingView,
  type ConnectReporter,
  type GuestWaitingViewModel,
} from './ui/onboarding-view';
import { formatActivityTime, prefersReducedMotion } from './ui/primitives';
import { HavemindSettingTab, formatMemberCount } from './ui/setting-tab';
import { PluginViewRegistry } from './ui/view-registry';
import type {
  HavemindConnectionActions,
  HavemindSettingsInfo,
} from './ui/settings-model';
import { HAVEMIND_ONBOARDING_VIEW } from './ui/view-types';

export default class HavemindPlugin extends Plugin {
  connection: ConnectionHandle | null = null;
  /**
   * Set true in `onunload`. `startConnection` runs on `onLayoutReady` and awaits
   * an async connection build; if the plugin is disabled while that await is in
   * flight, `onunload` runs first and the resolved handle must be stopped, never
   * assigned, otherwise its vault listeners and running sync loop leak with no
   * `stop()` ever reaching them.
   */
  unloaded = false;
  /**
   * True once the user opened an `obsidian://havemind-join` link, which answers
   * the entry chooser on their behalf: they hold an invitation (design 1d).
   */
  private arrivedWithInvitation = false;
  private awaitingApproval: GuestWaitingViewModel | null = null;
  /**
   * True once the server reported this invitation is dead (owner rejected the
   * device or the 3-attempt cap was reached). Shows the "ask for a new invite"
   * screen instead of the waiting screen, never offline, never a blank form.
   */
  private guestInvitationInvalid = false;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private lastSyncedAt: number | undefined;
  connectionError: string | undefined;
  /** Lifecycle-safe bridge between long-lived plugin state and short-lived leaves. */
  readonly views = new PluginViewRegistry();
  /** Live feed behind the Activity view (previously orphaned, now wired). */
  private readonly activityLog = new ActivityLog();
  /** Disposer for the activityLog subscription set up in onload(); torn down in onunload(). */
  private activityLogUnsubscribe: (() => void) | null = null;
  /**
   * Monotonic counter bumped each time a live connection is (re-)established
   * (`startConnection`/`connectFromInput` assign a handle). The invitee rejoin
   * poll captures it when it arms; a poll tick that sees the counter has advanced
   * knows the connection was rebuilt since it armed (Retry now, a fresh user
   * connect, a rejoin restart) and must not tear that healthy connection down,
   * see `pollRejoinOnce` (FINDING 1b).
   */
  connectGeneration = 0;
  /**
   * Guards a user-initiated "Retry now" so a rapid double-click never spawns a
   * second connection build while the first is still in flight, two live
   * handles could otherwise be created (one would leak). Cleared once the retry
   * settles.
   */
  private retryInFlight = false;
  /** Abort signals for all connection builds that are still awaiting onboarding I/O. */
  private readonly connectionAttemptAborters = new Set<AbortController>();
  /**
   * Guards the user-initiated "Reset connection" (P1 #5) so a double-click can
   * never run two overlapping clear-and-rewrite passes over `data.json`.
   */
  private resetInFlight = false;
  /**
   * The live durable sync state (SND-01 + MRG-05), captured from the connection
   * handle. Null when disconnected, the send-queue panel then renders nothing
   * and the sweep is a no-op.
   */
  syncState: DurableSyncState | null = null;
  readonly people = new People(this);
  readonly invitations = new Invitations(this);
  readonly rejoin = new InviteeRejoin(this);
  readonly conflicts = new Conflicts(this);
  readonly sendQueue = new SendQueue(this);
  readonly statusBar = new StatusBar(this);

  override onload(): void {
    // The pane carries the activity feed as a tab (plans/007 Stage 0) and is the
    // only registered surface, so one repaint covers it.
    this.activityLogUnsubscribe = this.activityLog.subscribe(() => {
      this.views.refreshOnboarding();
    });

    // UI-00 / plans/007 Stage 0: one registered view type. The standalone
    // Activity view is no longer registered. Every route to it, the ribbon, the
    // `open-activity` command, the protocol handler, already lands on the single
    // pane's Activity tab, so registering the old type only kept a second,
    // orphaned surface that a restored workspace layout could rebuild and that
    // would then drift from the tab reading the same feed.
    this.registerView(HAVEMIND_ONBOARDING_VIEW, (leaf: WorkspaceLeaf) => {
      const view = new HavemindOnboardingView(leaf, {
        // A phone joins vaults, it does not run them: hosting needs Docker, a
        // terminal and a machine that stays awake. The entry chooser drops the
        // host branch there rather than walking the user to a dead end.
        canHost: !Platform.isMobileApp,
        // The activity feed is a tab of this pane (plans/007 Stage 0): the log
        // snapshot mapped through the roster, so each row shows the author's
        // display name and colour.
        activityFeedProvider: () =>
          activityEntriesToRecords(this.activityLog.snapshot(), this.people.rosterMembers),
        onRestore: (revisionId) => {
          void this.handleRestore(revisionId);
        },
        arrivedWithInvitationProvider: () => this.arrivedWithInvitation,
        onOpenComposer: () => {
          void this.invitations.openCreateConnectionView();
        },
        onCloseComposer: () => this.invitations.closeCreateConnectionView(),
        onSyncNow: () => {
          void this.syncNow();
        },
        composerProvider: () =>
          this.invitations.connectionActive ? this.invitations.composerModel() : null,
        guestWaitingProvider: () => this.awaitingApproval,
        guestInvalidProvider: () => this.guestInvitationInvalid,
        panelProvider: () => this.connectionPanel(),
        conflictsProvider: () => this.conflicts.list.read(),
        onResolveConflict: (copyPath) => {
          void this.conflicts.openConflictModal(copyPath);
        },
        sendQueueProvider: () => this.sendQueue.sendQueueView(),
        recoveryRequiredProvider: () =>
          this.syncState?.isRecoveryRequired() ?? false,
        onRetrySend: (revisionId) => {
          void this.sendQueue.retrySend(revisionId).catch(() => {
            new Notice('Havemind: could not retry this queued change.');
            this.views.refreshOnboardingNow();
          });
        },
        onDiscardSend: (revisionId) => {
          void this.sendQueue.discardSend(revisionId).catch(() => {
            new Notice('Havemind: could not discard this queued change.');
            this.views.refreshOnboardingNow();
          });
        },
        rejoinRosterProvider: () => buildRejoinRosterView(this.people.rosterMembers),
        rejoinWaitingProvider: () => this.people.rejoinWaiting,
        onRejoin: (membershipId) => {
          void this.people.requestRejoin(membershipId);
        },
        onRemove: (membershipId) => {
          void this.people.removeMember(membershipId);
        },
        onConnect: (input, serverUrl, report) => {
          void this.connectFromInput(input, serverUrl, report).catch(() => {
            report('Could not connect. Check the invitation, pairing token, and server URL.');
            this.views.refreshOnboardingNow();
          });
        },
        onDisconnect: () => this.disconnect(),
        onRetry: () => {
          void this.retryConnection();
        },
        onReset: () => {
          this.confirmResetConnection();
        },
        onCopyInvitation: (envelope) => {
          // Move the secret into the clipboard; never log the envelope.
          return copyTextToClipboard(envelope, browserClipboardCopyDeps());
        },
        onCreateInvitation: (role, name, report) => {
          void this.invitations.createInvitation(role, name, report);
        },
        onDismissInvitation: () => this.invitations.dismissInvitation(),
        onApprove: (invitationId, verificationPhrase, report) => {
          void this.invitations.approvePendingDevice(invitationId, verificationPhrase, report);
        },
        onReject: (invitationId, report) => {
          void this.invitations.rejectPendingDevice(invitationId, report);
        },
        onClosed: () => this.views.unregisterOnboarding(view),
      });
      this.views.registerOnboarding(view);
      return view;
    });

    registerCommands(this);

    this.statusBar.attach();

    this.addSettingTab(new HavemindSettingTab(this.app, this));

    this.registerObsidianProtocolHandler('havemind-join', (data) => {
      // The secret invitation is never accepted from the URI query. Only the
      // parameter-free passive URI opens the local paste wizard; any query
      // field (token, envelope, secret, or otherwise) is refused.
      if (!isSafePassiveJoinProtocolData(data)) return;
      // A passive join URI belongs to the guest paste wizard, not the owner
      // composer.
      this.invitations.connectionActive = false;
      // Arriving through havemind-join *is* the answer to the entry chooser:
      // this user has an invitation. Asking them anyway would be asking a
      // question they have already answered by clicking the link (design 1d).
      this.arrivedWithInvitation = true;
      void this.openPane();
    });

    this.conflicts.watchVault();

    // On layout-ready, resume any stored onboarding to `connected` and start
    // the live sync loop. When there is no connection this reports disconnected
    // and starts nothing, so the loaded-but-disconnected shell stays passive.
    this.app.workspace.onLayoutReady(() => {
      void this.startConnection();
    });
  }

  /**
   * Obsidian calls this when data.json changed on disk from outside the plugin
   * (another sync tool, a hand edit). The data mutex keeps the blob in memory
   * (P4), so it must read the file again.
   */
  onExternalSettingsChange(): void {
    getPluginDataMutex(this).invalidate();
  }

  override onunload(): void {
    // Mark unloaded BEFORE anything else so an in-flight `startConnection` await
    // that resolves after this point stops its handle instead of assigning it.
    this.unloaded = true;
    this.abortConnectionAttempts();
    // Cancel any in-flight invitee rejoin poll so it never fires after unload.
    this.rejoin.disarmRejoin();
    // Cancel any pending auto-repair sweep so it never fires after unload.
    this.conflicts.cancelConflictSweep();
    this.connection?.stop();
    this.connection = null;
    this.syncState = null;
    this.activityLogUnsubscribe?.();
    this.activityLogUnsubscribe = null;
  }

  /** Starts sync without allowing startup failures to escape UI/event callbacks. */
  async startConnection(): Promise<void> {
    try {
      await this.startConnectionOnce();
    } catch {
      if (this.unloaded) return;
      this.connectionStatus = 'offline';
      this.connectionError = 'Havemind could not start syncing. Try reconnecting.';
      this.statusBar.setStatus(formatStatusBar({ status: 'offline' }));
      new Notice('Havemind: could not start syncing. Try reconnecting.');
      this.views.refreshOnboarding();
    }
  }

  /** The fallible connection build, kept separate from the UI-facing boundary. */
  private async startConnectionOnce(): Promise<void> {
    const attempt = this.beginConnectionAttempt();
    try {
    // Load the persisted roster first so a reopened, already-connected vault
    // shows its connected members immediately (never derived from activity).
    await this.people.loadRoster();
    if (attempt.signal.aborted) return;
    const handle = await startHavemindConnection(
      this,
      (status, view, detail) => this.handleStatus(status, view, detail),
      this.activityHooks(),
      attempt.signal,
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
    //  - Disconnect or Reset ran while it was in flight (they abort the
    //    attempt). Assigning would restart syncing the user just stopped, and
    //    after a reset write sync state back into the wiped plugin data.
    // Either way, stop THIS handle and do not assign, never orphan an existing
    // connection, never leak past unload.
    if (this.unloaded || this.connection !== null || attempt.signal.aborted) {
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
    this.people.adoptSelfMembership(this.connection);
    // P3: the People list comes from the server, not from what this device
    // witnessed. Runs on every connect AND reconnect (retryConnection routes
    // through startConnection), so a guest sees the whole vault.
    void this.people.refreshRoster();
    // B8: only the owner has pending approvals; asking from a guest device is
    // a 403 at every start and a wasted token rotation.
    if (handle.selfMembership?.role === 'owner') {
      void this.invitations.restorePendingApprovals();
    }
    // MRG-05: on start (after the canonicalization rebase inside the handle
    // build), sweep any pre-existing conflict copies that a persisted ancestor
    // can now auto-merge. Scheduled (debounced) so it runs alongside, not
    // ahead of, the first sync cycle.
    this.conflicts.scheduleConflictSweep();
    } finally {
      this.connectionAttemptAborters.delete(attempt);
    }
  }

  /** Runtime hooks handed to the sync loop so live surfaces stay fed. */
  private activityHooks(): RuntimeHooks {
    return {
      onLocalActivity: (entry) => this.activityLog.record(entry),
      // FIX 1: a remote-applied revision reaches the Activity feed too, so
      // the other device's edits are no longer invisible.
      onRemoteActivity: (entry) => this.activityLog.record(entry),
      // MRG-05: a new conflict copy schedules a debounced auto-repair sweep.
      onConflictWritten: () => this.conflicts.scheduleConflictSweep(),
      // MAJOR 1: a successful commit that cleared a stale failed-to-queue row
      // refreshes the panel at once, so the phantom failure disappears.
      onSendQueueChanged: () => this.views.refreshOnboarding(),
      // MINOR 7: commit-recovery already showed a Notice for this failed-to-queue
      // row, so record its id as notified, the panel's quarantine-notice check
      // then skips it, preventing a duplicate Notice for the same event.
      onFailedToQueueNotified: (revisionId) =>
        this.sendQueue.notifiedQuarantineIds.add(revisionId),
    };
  }

  /**
   * The Activity feed's Restore: writes the note's text from that revision as a
   * normal edit, which then syncs like any other. Reports what happened.
   */
  private async handleRestore(revisionId: string): Promise<void> {
    const connection = this.connection;
    const state = this.syncState;
    if (connection?.revisionContent === undefined || state === null) {
      new Notice('Havemind: connect before restoring a revision.');
      return;
    }
    try {
      const result = await restoreRevision(
        {
          revisionContent: connection.revisionContent,
          currentPath: (fileId) => state.pathForFileId(fileId),
          vault: (this.app as unknown as { vault: RestoreDeps['vault'] }).vault,
        },
        revisionId,
      );
      if (result.outcome === 'unavailable') {
        new Notice('Havemind: that version cannot be restored (a deletion or an attachment).');
      } else if (result.outcome === 'unchanged') {
        new Notice(`Havemind: ${result.path} already has that text.`);
      } else {
        new Notice(`Havemind: restored ${result.path} to that version.`);
      }
    } catch (error) {
      new Notice(
        `Havemind: could not restore that version, ${errorMessage(error)}`,
      );
    }
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
    const attempt = this.beginConnectionAttempt();
    try {
    // A fresh paste clears any prior "invitation invalid" screen.
    this.guestInvitationInvalid = false;
    // Keep a working connection until the replacement flow has actually
    // succeeded. A malformed paste, rejected code, or transient outage must not
    // disconnect a healthy vault.
    const previousConnection = this.connection;
    const handle = await connectFromInput(this, input, serverUrl, {
      report,
      onStatus: (status, view, detail) => this.handleStatus(status, view, detail),
      hooks: this.activityHooks(),
      // Durably record the waiting state so a pane reopen resumes the waiting
      // screen (with the code) instead of a blank paste form.
      onPendingApproval: (verificationPhrase) => {
        if (attempt.signal.aborted || this.unloaded) return;
        this.awaitingApproval = { verificationPhrase };
        this.views.refreshOnboardingNow();
      },
      // The owner rejected the device or the attempt cap was reached: leave the
      // waiting screen for the terminal "invitation invalid" screen. This is an
      // expected auth response, not a connection loss, status is untouched.
      onInvitationRejected: () => {
        if (attempt.signal.aborted || this.unloaded) return;
        this.awaitingApproval = null;
        this.guestInvitationInvalid = true;
        this.views.refreshOnboardingNow();
      },
      signal: attempt.signal,
    });
    if (handle !== null) {
      // Guard against the plugin being unloaded while the invitee approval poll
      // (up to ~1h) was still in flight: `onunload` already ran its
      // `connection?.stop()` on a still-null field, so assigning this late-
      // resolved handle now would leave it LIVE forever (leaked vault listeners
      // + sync loop). Mirrors the `startConnection` unload guard (FIX 1), stop
      // this handle and never assign.
      //
      // FIX 3: also yield to a connection assigned MEANWHILE (e.g. the rejoin
      // restart's startConnection completing during this ~1h approval poll).
      // Without the `connection !== null` arm this late handle would clobber and
      // orphan that live connection. Same stop-the-newcomer, keep-the-existing
      // invariant startConnection enforces.
      if (this.unloaded || this.connection !== previousConnection) {
        handle.stop();
        return;
      }
      // The replacement is live; only now is it safe to stop the old handle.
      previousConnection?.stop();
      this.awaitingApproval = null;
      this.guestInvitationInvalid = false;
      this.connection = handle;
      this.syncState = handle.state ?? null;
      // A live connection was (re-)established, advance the generation (FINDING 1b).
      this.connectGeneration += 1;
      // Record this device's own membership as a persistent roster member so the
      // invitee's UI clearly shows it is connected.
      this.people.adoptSelfMembership(handle);
      // P3: pull the server-authoritative roster for this freshly paired vault.
      void this.people.refreshRoster();
      // MRG-05: sweep any pre-existing conflict copies now that a base is loaded.
      this.conflicts.scheduleConflictSweep();
    }
    } finally {
      this.connectionAttemptAborters.delete(attempt);
    }
  }

  /**
   * Command-palette "Sync now": force an immediate cycle instead of waiting for
   * the loop's own schedule. A live loop runs one cycle through the handle;
   * anything else falls back to the panel's "Retry now" rebuild.
   *
   * The palette greys the command out while nothing is connected, so this guard
   * is the belt to that braces: a direct invocation explains itself rather than
   * looking like a silent no-op.
   */
  private async syncNow(): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      new Notice('Havemind: connect before syncing.');
      return;
    }
    // One cycle, not a rebuild: rebuilding aborts work in flight and re-reads
    // the whole vault. The no-op handle has no loop, and a refused session has
    // stopped its loop for good, so both are rebuilt instead.
    if (
      connection.syncNow !== undefined &&
      this.connectionStatus !== 'reconnect-required'
    ) {
      await connection.syncNow();
      return;
    }
    await this.retryConnection();
  }

  /** Stops the live sync loop; the paste form returns so the user can reconnect. */
  private disconnect(): void {
    this.abortConnectionAttempts();
    this.connection?.stop();
    this.connection = null;
    this.syncState = null;
    // Tear down any armed invitee rejoin poll, matching retryConnection/onunload
    //, otherwise a disconnected device keeps polling the server for a rejoin
    // grant it will never act on (NIT).
    this.rejoin.disarmRejoin();
    this.connectionStatus = 'disconnected';
    this.lastSyncedAt = undefined;
    this.connectionError = undefined;
    this.awaitingApproval = null;
    this.guestInvitationInvalid = false;
    this.statusBar.setStatus(formatStatusBar({ status: 'disconnected' }));
    this.views.refreshOnboardingNow();
  }

  /** Starts a tracked connection build; all live attempts are cancelled on teardown. */
  private beginConnectionAttempt(): AbortController {
    const attempt = new AbortController();
    this.connectionAttemptAborters.add(attempt);
    return attempt;
  }

  private abortConnectionAttempts(): void {
    for (const attempt of this.connectionAttemptAborters) {
      attempt.abort();
    }
    this.connectionAttemptAborters.clear();
  }

  /** Updates the status bar and live Connect indicator from a cycle status. */
  private handleStatus(
    status: ConnectionStatus,
    view: StatusBarView,
    detail?: string,
  ): void {
    this.connectionStatus = status;
    if (status === 'offline' || status === 'retrying') {
      this.connectionError = detail;
    }
    if (status === 'synced') {
      this.lastSyncedAt = Date.now();
      this.connectionError = undefined;
      void this.statusBar.refreshLastEdited();
    }
    if (status === 'reset-required') {
      // The stored connection is damaged (P1 #5): drop any stale server-side
      // error so the panel shows its own "reset and pair again" explanation, and
      // never arm the rejoin poll, a rejoin cannot fix a broken local record.
      this.connectionError = undefined;
    }
    if (status === 'reconnect-required') {
      this.connectionError = 'The server refused the session, reconnect.';
      // Terminal auth failure: arm the invitee rejoin poll so this device
      // re-admits itself once the owner clicks Rejoin, no re-pairing needed.
      void this.rejoin.armRejoin();
    }
    // SND-01: fire a Notice the first time each item enters quarantine (never on
    // a retry). Runs on every status change, the point sends are dead-lettered.
    this.sendQueue.checkQuarantineNotices();
    this.statusBar.setStatus(view);
    this.views.refreshOnboarding();
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
   * rebuilt, attempt() → 'syncing' → stop + restart, thrashing a healthy
   * connection up to 30 s after the user fixed it. The fallback is not lost: if
   * the restart lands back in reconnect-required, `handleStatus` re-arms the poll
   * from scratch.
   */
  private async retryConnection(): Promise<void> {
    if (this.retryInFlight) return;
    const connection = this.connection;
    // Offline with a live loop: the session is fine, only a cycle failed.
    if (
      connection?.syncNow !== undefined &&
      (this.connectionStatus === 'offline' || this.connectionStatus === 'retrying')
    ) {
      await connection.syncNow();
      return;
    }
    this.retryInFlight = true;
    try {
      this.rejoin.disarmRejoin();
      this.connection?.stop();
      this.connection = null;
      await this.startConnection();
    } finally {
      this.retryInFlight = false;
    }
  }

  /**
   * U2: every entry point to Reset connection asks first. It wipes the pairing
   * and the sync state, and only the owner's approval brings the device back.
   */
  private confirmResetConnection(): void {
    new ConfirmModal(this.app, {
      title: 'Reset connection?',
      body:
        'This device forgets its pairing and sync state. No note is touched, ' +
        'but syncing stops until you paste a new invitation and the owner approves it.',
      confirmLabel: 'Reset connection',
      onConfirm: () => {
        void this.resetConnection();
      },
    }).open();
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
      this.abortConnectionAttempts();
      this.rejoin.disarmRejoin();
      this.connection?.stop();
      this.connection = null;
      this.syncState = null;
      await resetHavemindConnectionState(this);
      // No later action may reuse an access token cached for the old pairing.
      forgetSharedAccessProvider(this);
      this.people.rosterMembers = [];
      this.people.rejoinWaiting = new Set<string>();
      this.invitations.pendingInvitation = null;
      this.invitations.pendingApprovals = [];
      this.sendQueue.notifiedQuarantineIds = new Set<string>();
      this.awaitingApproval = null;
      this.guestInvitationInvalid = false;
      this.invitations.connectionActive = false;
      this.invitations.connectionNotice = undefined;
      this.invitations.connectionNoticeKind = undefined;
      this.connectionStatus = 'disconnected';
      this.lastSyncedAt = undefined;
      this.connectionError = undefined;
      this.statusBar.setStatus(formatStatusBar({ status: 'disconnected' }));
      new Notice(
        'Havemind: connection reset. Paste a new invitation or pairing token to connect.',
      );
    } catch (error) {
      new Notice(`Havemind: could not reset the connection, ${errorMessage(error)}`);
    } finally {
      this.resetInFlight = false;
      this.views.refreshOnboarding();
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
    void this.openPane();
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
        this.confirmResetConnection();
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
      members: formatMemberCount(this.people.rosterMembers.length),
      connected: this.connection !== null,
    };
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
   * The single door into the plugin (plans/007 Stage 0). Every entry point,
   * the ribbon hexagon, `open-activity`, `connect`, resolves here, so the user
   * never has to know which of two panes holds the thing they want. It reuses
   * an existing leaf, so asking twice focuses the pane rather than opening a
   * second copy of it.
   */
  async openPane(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(HAVEMIND_ONBOARDING_VIEW)[0];
    const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existingLeaf) {
      await leaf.setViewState({ active: true, type: HAVEMIND_ONBOARDING_VIEW });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
}
