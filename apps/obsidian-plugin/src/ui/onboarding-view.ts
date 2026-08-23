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

import {
  buildEntryChooser,
  buildHostView,
  type EntryChoice,
} from '../runtime/entry-choice';
import {
  buildGuestHandshake,
  buildSpentInvitation,
} from '../runtime/handshake';
import {
  buildPaneTabs,
  type PaneTabId,
  type PaneTabsView,
} from '../runtime/pane-tabs';

import { renderActivityRows } from './activity-section';
import { renderConflictSection } from './conflict-section';
import {
  renderEntryChooser,
  renderHostPath,
} from './entry-chooser-section';
import { renderPaneHeader, type PaneMenuItem } from './pane-header';
import { renderPaneTabs } from './pane-tabs-section';
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
  /**
   * Who invited them, when known. Naming the other person turns an instruction
   * into a conversation — "read these to Mira" beats "read these to the vault
   * owner" (design 1e). An unnamed owner is still a valid state.
   */
  readonly ownerName?: string;
}

/** Injected data + actions for the onboarding surface. */
export interface OnboardingViewOptions {
  /**
   * The revision feed, rendered as a collapsed section of this pane rather
   * than a separate destination (plans/007 Stage 0). Reads the same provider
   * the standalone Activity view uses, so the two cannot disagree.
   */
  readonly activityFeedProvider?: () => readonly RevisionRecord[];
  /** Current author-overlay state, for the footer toggle. */
  readonly authorOverlayProvider?: () => boolean;
  /** Flips the author overlay from the footer (the toggle lost its ribbon icon). */
  readonly onToggleAuthorOverlay?: () => void;
  /** Opens the owner's invite composer from the action bar. */
  readonly onOpenComposer?: () => void;
  /** Forces a sync cycle from the action bar, matching the `sync-now` command. */
  readonly onSyncNow?: () => void;
  /**
   * True when the user reached the pane through an `obsidian://havemind-join`
   * link. That click already answers the entry chooser — they hold an
   * invitation — so the question is skipped (design 1d).
   */
  readonly arrivedWithInvitationProvider?: () => boolean;
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
  /** Whether the header overflow menu is open. */
  private menuOpen = false;
  /** Which tab the connected pane is showing. */
  private activeTab: PaneTabId = 'status';
  /**
   * Which entry path the user picked on the connect screen (design 1d).
   * `undecided` shows the chooser; a typed token or a `havemind-join` URI
   * counts as having chosen, so those users never see the question.
   */
  private entryChoice: EntryChoice = 'undecided';
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
    // The pane holds everything now — connecting, activity, people, conflicts —
    // so naming it after one of those would misdescribe the other three.
    return 'Havemind';
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

    const panel =
      this.options.panelProvider?.() ??
      buildConnectionPanel({ status: 'disconnected' });

    // Header strip with the overflow menu (design 1a). Disconnect, Reset and
    // the server address live behind it rather than costing standing lines in
    // a 300px column.
    const overlayOn = this.options.authorOverlayProvider?.();
    renderPaneHeader(content, {
      title: 'Havemind',
      menuOpen: this.menuOpen,
      onToggleMenu: () => {
        this.menuOpen = !this.menuOpen;
        this.render();
      },
      items: this.headerMenuItems(panel),
      alarmed: this.attentionCount() > 0,
      // View actions live in the header, not in a second row (round 2, Q1).
      // Only once connected: before that there is nothing to colour and nobody
      // to invite.
      ...(panel.showForm || overlayOn === undefined
        ? {}
        : { authorOverlayOn: overlayOn }),
      ...(panel.showForm || this.options.onToggleAuthorOverlay === undefined
        ? {}
        : { onToggleAuthorOverlay: this.options.onToggleAuthorOverlay }),
      ...(panel.showForm || this.options.onOpenComposer === undefined
        ? {}
        : { onInvite: this.options.onOpenComposer }),
    });

    // The invite composer is the Invite tab (see renderTabBody), not a block
    // above the strip: rendering it here as well pushed the tabs and the status
    // to the bottom of the pane, which is what the owner saw. It is reachable
    // from the action-bar icon, which selects that tab.
    // MAJOR 5: each section renders inside its own guard so a synchronous
    // provider throw degrades that one section to an inline fallback rather than
    // blanking the whole panel (content.empty() has already run above).

    // Not yet connected: no tabs, because there is only one thing to do. The
    // alarms still render — a conflict left over from a previous session does
    // not stop mattering because the vault is currently disconnected.
    //
    // An open composer is the exception: an owner minting an invitation has
    // something to do that is not "connect", and the connect form is not it.
    const composerOpen = this.options.composerProvider?.() != null;
    if (panel.showForm && !composerOpen) {
      renderSection(content, 'status', () =>
        this.renderIndicator(content, panel),
      );
      renderSection(content, 'send queue', () => this.renderSendQueue(content));
      renderSection(content, 'conflicts', () => this.renderConflicts(content));
      renderSection(content, 'connection', () => this.renderEntryPath(content));
      return;
    }

    // Anything that needs the user renders ABOVE the strip, on every tab. A tab
    // may hide content; it must never hide an alarm. This is the specific
    // failure the designer warned about — a pane reading "Synced" while two
    // files sit in conflict one click away — and lifting it out of the tabs is
    // what makes a tabbed pane safe rather than merely tidy.
    renderSection(content, 'send queue', () => this.renderSendQueue(content));
    renderSection(content, 'conflicts', () => this.renderConflicts(content));

    const tabs = this.paneTabs();
    renderSection(content, 'tabs', () => {
      renderPaneTabs(content, {
        view: tabs,
        onSelect: (id) => {
          this.activeTab = id;
          this.render();
        },
      });
    });

    const body = content.createDiv();
    body.addClass('havemind-tab-body');
    renderSection(body, `tab:${tabs.active}`, () => {
      this.renderTabBody(body, tabs.active, panel);
    });
  }

  /**
   * The tab model, derived from the same providers the body reads.
   *
   * Every read is guarded: the strip is chrome, and a provider that throws must
   * cost the user its count, not their whole pane. `renderSection` protects the
   * sections it wraps, but this runs before them — an unguarded throw here would
   * blank everything, which is the failure MAJOR 5 exists to prevent.
   */
  private paneTabs(): PaneTabsView {
    const count = (read: () => number): number => {
      try {
        return read();
      } catch {
        return 0;
      }
    };

    // An open composer means the user is mid-invitation, so that is the tab
    // they are on — not whichever one they last happened to leave selected.
    // `!= null` is deliberate: an absent provider returns undefined, and
    // `undefined === null` is false — reading it that way made every pane
    // without a composer think one was open.
    const composerOpen =
      count(() => (this.options.composerProvider?.() != null ? 1 : 0)) > 0;

    return buildPaneTabs({
      // Inviting happens inside People now (round 2, Q3), so an open composer
      // selects that tab rather than a fourth one of its own.
      active: composerOpen ? 'people' : this.activeTab,
      activityCount: count(
        () => this.options.activityFeedProvider?.().length ?? 0,
      ),
      peopleCount: count(
        () => this.options.rejoinRosterProvider?.()?.rows.length ?? 0,
      ),
      attentionCount:
        count(() => this.options.conflictsProvider?.().length ?? 0) +
        count(() => this.options.sendQueueProvider?.()?.failed.length ?? 0),
    });
  }

  private renderTabBody(
    body: HTMLElement,
    tab: PaneTabId,
    panel: ConnectionPanelView,
  ): void {
    if (tab === 'status') {
      this.renderIndicator(body, panel);
      if (this.helpOpen) {
        renderGettingStarted(body, buildGettingStartedViewModel());
      }
      return;
    }

    if (tab === 'activity') {
      const feed = this.options.activityFeedProvider?.() ?? [];
      renderActivityRows(body, {
        feed,
        ...(this.options.onRestore ? { onRestore: this.options.onRestore } : {}),
      });
      return;
    }

    // People holds both who is here and how someone else gets here (round 2,
    // Q3): inviting is a momentary task, so it lives where "who is in this
    // vault" already lives rather than holding a permanent tab of its own.
    const roster = this.options.rejoinRosterProvider?.();
    if (roster !== undefined) this.renderRoster(body, roster);

    const composer = this.options.composerProvider?.() ?? null;
    if (composer !== null) {
      this.renderCreateConnection(body, composer);
      return;
    }

    if (this.options.onOpenComposer !== undefined) {
      const open = body.createEl('button', { text: 'Invite someone' });
      open.addClass('havemind-invite-cta');
      open.onClickEvent(() => this.options.onOpenComposer?.());
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
   * The disconnected pane: a chooser, then only the branch the user picked
   * (design 1d). The five-step tutorial used to render unconditionally above
   * the form — correct for the half of users who will host a server, and fatal
   * for the half who only need to paste an invitation someone sent them.
   *
   * A user who arrived through `obsidian://havemind-join`, or who already has a
   * token typed, has self-evidently chosen: skip the question.
   */
  private renderEntryPath(content: HTMLElement): void {
    const decided =
      this.entryChoice !== 'undecided' ||
      this.draft.token.length > 0 ||
      this.options.arrivedWithInvitationProvider?.() === true ||
      // An owner minting an invitation has already answered the question by
      // opening the composer; asking again would be asking twice. Note the
      // `=== undefined` guard: an absent provider is not an open composer.
      (this.options.composerProvider !== undefined &&
        this.options.composerProvider() !== null);

    if (!decided) {
      renderEntryChooser(content, {
        model: buildEntryChooser(),
        onChoose: (choice) => {
          this.entryChoice = choice;
          this.render();
        },
      });
      return;
    }

    if (this.entryChoice === 'hosting') {
      renderHostPath(content, {
        model: buildHostView(),
        onBack: () => {
          this.entryChoice = 'undecided';
          this.render();
        },
        onContinue: () => {
          this.entryChoice = 'joining';
          this.render();
        },
        onOpenGuide: (url) => {
          window.open(url, '_blank');
        },
      });
      return;
    }

    // The joining path: three fields and one button, with no tutorial above it.
    const back = content.createEl('button', { text: 'Back' });
    back.addClass('havemind-entry-back');
    back.onClickEvent(() => {
      this.entryChoice = 'undecided';
      this.render();
    });
    this.renderForm(content);
  }


  /**
   * What the header overflow menu holds. Only offered once connected: on the
   * connect screen there is nothing to disconnect from, and Reset is already
   * surfaced as its own affordance in the state that needs it.
   */
  /** How many things need the user right now, across every guarded provider. */
  private attentionCount(): number {
    const count = (read: () => number): number => {
      try {
        return read();
      } catch {
        return 0;
      }
    };
    return (
      count(() => this.options.conflictsProvider?.().length ?? 0) +
      count(() => this.options.sendQueueProvider?.()?.failed.length ?? 0)
    );
  }

  private headerMenuItems(panel: ConnectionPanelView): PaneMenuItem[] {
    if (panel.showForm) return [];

    const items: PaneMenuItem[] = [];

    // Sync is automatic; a standing button implies it might not be. It lives
    // here for the rare case where forcing a cycle actually helps (round 2, Q5).
    if (this.options.onSyncNow) {
      items.push({
        label: 'Sync now',
        onSelect: () => {
          this.menuOpen = false;
          this.options.onSyncNow?.();
        },
      });
    }

    // Getting started lost its icon with the action row. It is read once and
    // then never again, which is exactly what the overflow menu is for — but it
    // must stay reachable, so it moves here rather than disappearing.
    items.push({
      label: this.helpOpen ? 'Hide getting started' : 'Show getting started',
      onSelect: () => {
        this.helpOpen = !this.helpOpen;
        this.menuOpen = false;
        this.render();
      },
    });
    if (panel.serverName !== undefined) {
      items.push({
        label: `Server: ${panel.serverName}`,
        onSelect: () => {},
        readOnly: true,
      });
    }
    if (this.options.onDisconnect) {
      items.push({
        label: 'Disconnect',
        onSelect: () => {
          this.menuOpen = false;
          this.options.onDisconnect?.();
        },
      });
    }
    if (this.options.onReset) {
      items.push({
        label: 'Reset connection',
        onSelect: () => {
          this.menuOpen = false;
          this.options.onReset?.();
        },
      });
    }
    return items;
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
    // The code is the only thing at full size (design 1e): this screen exists
    // for one job, and everything competing with the digits makes that job
    // harder while another person waits on the phone.
    const view = buildGuestHandshake({
      code: model.verificationPhrase,
      ...(model.ownerName !== undefined ? { ownerName: model.ownerName } : {}),
    });

    content.createDiv({ text: view.instruction }).addClass('havemind-handshake-lead');

    const digits = content.createDiv();
    digits.addClass('havemind-handshake-code');
    // Announced as one string so a screen reader reads "482917", not two
    // unrelated numbers; sighted users get the 3+3 grouping that makes it
    // speakable.
    digits.setAttribute('aria-label', view.code.join(''));
    for (const group of view.code) {
      digits.createEl('span', { text: group });
    }

    content
      .createDiv({ text: view.mismatchWarning })
      .addClass('havemind-handshake-warning');

    if (view.expiryLabel !== null) {
      content
        .createDiv({ text: `Expires in ${view.expiryLabel}` })
        .addClass('havemind-hint');
    }
    content.createDiv({ text: view.liveNote }).addClass('havemind-hint');

    const cancel = content.createEl('button', { text: 'Cancel' });
    cancel.onClickEvent(() => this.options.onDisconnect?.());
  }

  /**
   * Terminal guest screen after the owner rejected this device or the 3-attempt
   * cap was reached. The invitation is spent, so we present a clear message plus
   * the paste form to try a fresh invite — never offline, never a blank form.
   */
  private renderGuestInvalid(content: HTMLElement): void {
    // Never a blank screen (design 1e): name the cause, price the fix in the
    // other person's time so asking feels cheap, and offer both ways forward.
    const view = buildSpentInvitation(
      this.options.guestWaitingProvider?.()?.ownerName,
    );

    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    row.style.setProperty('color', 'var(--text-error)');
    setIcon(row.createEl('span', { attr: DECORATIVE }), 'alert-triangle');
    row.createEl('span', { text: ` ${view.heading}` });

    content.createDiv({ text: view.explanation }).addClass('havemind-hint');
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
      // Four lines explaining that nothing has happened is the pane talking
      // about itself (round 2, Q4). One quiet line says the same and leaves the
      // space for the device that is about to arrive — which is when this
      // section has something to say.
      if (model.pending.length === 0) {
        // Only meaningful once an invitation exists: before that there is
        // nothing to wait for.
        if (model.invitation !== null) {
          content
            .createDiv({ text: 'Waiting for the other device…' })
            .addClass('havemind-hint');
        }
        return;
      }

      const divider = content.createEl('hr');
      divider.addClass('havemind-divider');
      content.createEl('h4', { text: 'Waiting for the other device' });
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
