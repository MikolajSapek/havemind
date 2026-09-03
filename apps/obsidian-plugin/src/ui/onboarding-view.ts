/**
 * The Havemind onboarding/connection view, the plugin's one interactive panel.
 * It hosts every connection surface: the owner's unified "Create connection"
 * composer, the guest paste form, the guest waiting and invitation-invalid
 * screens, and the connected panel with its status indicator, send-queue,
 * conflicts, roster and collapsed help. All data and actions arrive through the
 * injected `OnboardingViewOptions`, so the view holds no connection state of its
 * own beyond in-progress typed input, and every section renders inside its own
 * error boundary so one failing provider can never blank the pane.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import { buildGettingStartedViewModel } from '../runtime/getting-started-render';
import type { RejoinRosterView } from '../runtime/rejoin-roster';
import { resolveViewState } from '../runtime/view-state';
import { renderGuestWaitingScreen } from './screens/guest-waiting';
import { renderInviteComposer } from './screens/invite-composer';
import { renderConnectionControls } from './screens/connection-controls';
import { renderEntryPath } from './screens/entry-path';
import { renderConnectForm } from './screens/connect-form';
import { renderPaneChrome } from './screens/pane-chrome';
import { renderPeopleTab } from './screens/people-tab';
import { buildHeaderMenuItems } from './screens/header-menu';
import { renderStatusIndicator } from './screens/status-indicator';
import {
  buildConnectionPanel,
  type ConnectionPanelView,
} from '../runtime/status';

import type { EntryChoice } from '../runtime/entry-choice';
import { buildSpentInvitation } from '../runtime/handshake';
import {
  buildPaneTabs,
  type PaneTabId,
  type PaneTabsView,
} from '../runtime/pane-tabs';

import { renderActivityRows } from './activity-section';
import { renderConflictSection } from './conflict-section';
import type { PaneMenuItem } from './pane-header';
import {
  PANE_TABPANEL_ID,
  paneTabDomId,
  renderPaneTabs,
} from './pane-tabs-section';
import { renderGettingStarted } from './getting-started-section';
import {
  DECORATIVE,
  renderSection,
  safeRead,
} from './primitives';
import { renderRejoinRoster } from './roster-section';
import {
  renderRecoveryNotice,
  renderSendQueueSection,
} from './send-queue-section';
import { HAVEMIND_ONBOARDING_VIEW } from './view-types';

// Re-exported so every existing import of these names keeps working: moving a
// type must not move a public name.
export type {
  ConnectReporter,
  CreateConnectionViewModel,
  GuestWaitingViewModel,
  InvitationRole,
  OnboardingViewOptions,
  PendingApprovalEntry,
} from './onboarding-types';

import type {
  CreateConnectionViewModel,
  GuestWaitingViewModel,
  InvitationRole,
  OnboardingViewOptions,
} from './onboarding-types';


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
   * Set for exactly one render after a keyboard or click selection, so focus
   * lands on the newly opened tab. Cleared as it is consumed: a status-driven
   * re-render must not move focus.
   */
  private focusTabOnRender = false;
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
    // The pane holds everything now, connecting, activity, people, conflicts,
    // so naming it after one of those would misdescribe the other three.
    return 'Havemind';
  }

  override getIcon(): string {
    return 'hexagon';
  }

  override getViewType(): string {
    return HAVEMIND_ONBOARDING_VIEW;
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.options.onClosed?.();
  }

  /** Re-renders from the current panel state, called on every status change. */
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

    // Every read below happens BEFORE any `renderSection` boundary exists, and
    // `content.empty()` has already run, so an unguarded throw here blanks the
    // pane completely, leaving no header and no way back. Each one degrades to
    // the value that keeps the most of the pane usable, and says so in the log.
    //
    // Read once, too: a provider called twice in one render can answer
    // differently, and then the tab strip and the tab body describe different
    // states of the same pane.

    // Disconnected is the safe default: it offers the connect form rather than
    // claiming a health the plugin cannot currently verify.
    const panel = safeRead(
      'panel',
      this.options.panelProvider,
      buildConnectionPanel({ status: 'disconnected' }),
    );

    // Which screen to draw is decided by one pure function rather than by the
    // order these branches happen to be written in (AT3-1). The precedence it
    // encodes, invalid → awaiting → connected → joining/hosting → choosing, is
    // the same one this chain always implemented; lifting it out is what makes
    // it assertable, which is what was missing when the composer hid the status
    // row in 1.1.3.
    // Read once and threaded through: `resolveViewState`, `paneTabs()` and
    // `renderTabBody` all need to know whether a composer is open, and two
    // reads could answer differently, leaving them describing different states
    // of the same pane.
    const composer = safeRead('composer', this.options.composerProvider, null);

    const state = resolveViewState({
      guestInvalid: safeRead('guestInvalid', this.options.guestInvalidProvider, false),
      guestWaiting: safeRead('guestWaiting', this.options.guestWaitingProvider, null),
      panel,
      entryChoice: this.entryChoice,
      joinLinkFollowed: this.draft.token.length > 0,
      composerOpen: composer !== null,
    });

    if (state.kind === 'invalid') {
      this.renderGuestInvalid(content);
      return;
    }

    if (state.kind === 'awaiting') {
      this.renderGuestWaiting(content, state.waiting);
      return;
    }

    renderPaneChrome(content, {
      panel,
      menuOpen: this.menuOpen,
      alarmed: this.attentionCount() > 0,
      overlayOn: safeRead('authorOverlay', this.options.authorOverlayProvider, undefined),
      items: this.headerMenuItems(panel),
      onToggleMenu: () => {
        this.menuOpen = !this.menuOpen;
        this.render();
      },
      onToggleAuthorOverlay: this.options.onToggleAuthorOverlay,
      onInvite: this.options.onOpenComposer,
    });

    // The invite composer is the Invite tab (see renderTabBody), not a block
    // above the strip: rendering it here as well pushed the tabs and the status
    // to the bottom of the pane, which is what the owner saw. It is reachable
    // from the action-bar icon, which selects that tab.
    // MAJOR 5: each section renders inside its own guard so a synchronous
    // provider throw degrades that one section to an inline fallback rather than
    // blanking the whole panel (content.empty() has already run above).

    // Not yet connected: no tabs, because there is only one thing to do. The
    // alarms still render, a conflict left over from a previous session does
    // not stop mattering because the vault is currently disconnected.
    //
    // An open composer is the exception: an owner minting an invitation has
    // something to do that is not "connect", and the connect form is not it.
    const composerOpen = composer != null;
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
    // failure the designer warned about, a pane reading "Synced" while two
    // files sit in conflict one click away, and lifting it out of the tabs is
    // what makes a tabbed pane safe rather than merely tidy.
    renderSection(content, 'send queue', () => this.renderSendQueue(content));
    renderSection(content, 'conflicts', () => this.renderConflicts(content));

    // AT3-2, the 1.1.3 defect made structural. The composer draws inside the
    // People tab, so while it is open the status row is a tab-switch away and a
    // connected vault can read as disconnected, which is exactly the failure
    // that shipped in 1.1.3. `resolveViewState` has no composer variant: the
    // composer is a momentary task drawn OVER the connected state, never
    // instead of it, so the status row is lifted above the strip for as long as
    // it is open. Everywhere else it stays in the Status tab, where a calm pane
    // wants it.
    if (composer !== null) {
      renderSection(content, 'status', () => this.renderIndicator(content, panel));
    }

    const tabs = this.paneTabs(composer != null);
    // Focus follows a keyboard selection, and only that one: the pane
    // re-renders on every status change, and taking focus each time would pull
    // the caret out of whatever the user was mid-way through typing.
    const focusActive = this.focusTabOnRender;
    this.focusTabOnRender = false;
    renderSection(content, 'tabs', () => {
      renderPaneTabs(content, {
        view: tabs,
        onSelect: (id) => {
          this.activeTab = id;
          this.focusTabOnRender = true;
          this.render();
        },
        ...(focusActive ? { focusActive: true } : {}),
      });
    });

    const body = content.createDiv();
    body.addClass('havemind-tab-body');
    // The panel names the tab that opened it, so a screen reader moving into
    // the body knows which tab it belongs to rather than landing in unnamed
    // content. `role="tabpanel"` completes the pairing the strip advertises
    // through `aria-controls`.
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('id', PANE_TABPANEL_ID);
    body.setAttribute('aria-labelledby', paneTabDomId(tabs.active));
    renderSection(body, `tab:${tabs.active}`, () => {
      this.renderTabBody(body, tabs.active, panel, composer);
    });
  }

  /**
   * The tab model, derived from the same providers the body reads.
   *
   * Every read is guarded: the strip is chrome, and a provider that throws must
   * cost the user its count, not their whole pane. `renderSection` protects the
   * sections it wraps, but this runs before them, an unguarded throw here would
   * blank everything, which is the failure MAJOR 5 exists to prevent.
   */
  private paneTabs(composerOpen: boolean): PaneTabsView {
    // `composerOpen` is passed in, not re-read: `render()` already asked the
    // provider once, and a second call could answer differently, leaving the
    // strip and the body describing different states of the same pane.
    return buildPaneTabs({
      // Inviting happens inside People now (round 2, Q3), so an open composer
      // selects that tab rather than a fourth one of its own.
      active: composerOpen ? 'people' : this.activeTab,
      attentionCount: this.attentionCount(),
    });
  }

  private renderTabBody(
    body: HTMLElement,
    tab: PaneTabId,
    panel: ConnectionPanelView,
    composer: CreateConnectionViewModel | null,
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

    if (tab === 'connect') {
      this.renderConnectionControls(body, panel);
      return;
    }

    renderPeopleTab(body, composer, {
      renderRoster: (target) => {
        // Read inside the boundary, not around it: a roster that cannot be
        // built should show the section fallback where the list would have
        // been, rather than vanishing silently and leaving the tab empty.
        const roster = this.options.rejoinRosterProvider?.();
        if (roster !== undefined) this.renderRoster(target, roster);
      },
      renderComposer: (target, model) => this.renderCreateConnection(target, model),
      onOpenComposer: this.options.onOpenComposer,
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

  private renderIndicator(
    content: HTMLElement,
    panel: ConnectionPanelView,
    includeRecovery = true,
  ): void {
    renderStatusIndicator(
      content,
      panel,
      { onRetry: this.options.onRetry, onReset: this.options.onReset },
      includeRecovery,
    );
  }

  /**
   * Keeps every connection action in the pane instead of requiring the header
   * overflow menu. Connecting a different server remains an explicit two-step
   * action: disconnect first, then the normal pairing form appears.
   */
  private renderConnectionControls(
    content: HTMLElement,
    panel: ConnectionPanelView,
  ): void {
    renderConnectionControls(content, panel, this.helpOpen, {
      onSyncNow: this.options.onSyncNow,
      onRetry: this.options.onRetry,
      onReset: this.options.onReset,
      onDisconnect: this.options.onDisconnect,
      onToggleHelp: () => {
        this.helpOpen = !this.helpOpen;
        this.render();
      },
    });
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
   * the form, correct for the half of users who will host a server, and fatal
   * for the half who only need to paste an invitation someone sent them.
   *
   * A user who arrived through `obsidian://havemind-join`, or who already has a
   * token typed, has self-evidently chosen: skip the question.
   */
  private renderEntryPath(content: HTMLElement): void {
    // An owner minting an invitation has already answered the question by
    // opening the composer; asking again would be asking twice. The
    // `!== undefined` guard matters: an absent provider is not an open composer.
    const alreadyAnswered =
      this.draft.token.length > 0 ||
      this.options.arrivedWithInvitationProvider?.() === true ||
      (this.options.composerProvider !== undefined &&
        this.options.composerProvider() !== null);

    renderEntryPath(
      content,
      {
        entryChoice: this.entryChoice,
        alreadyAnswered,
        canHost: this.options.canHost ?? true,
      },
      {
        onChoose: (choice) => {
          this.entryChoice = choice;
          this.render();
        },
        renderForm: (target) => this.renderForm(target),
        onOpenGuide: (url) => {
          window.open(url, '_blank');
        },
      },
    );
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
    const close = (run?: () => void) => () => {
      this.menuOpen = false;
      run?.();
    };
    return buildHeaderMenuItems(panel, this.helpOpen, {
      onSyncNow: this.options.onSyncNow,
      onDisconnect: this.options.onDisconnect,
      onReset: this.options.onReset,
      onSelectSyncNow: close(this.options.onSyncNow),
      onSelectDisconnect: close(this.options.onDisconnect),
      onSelectReset: close(this.options.onReset),
      onToggleHelp: () => {
        this.helpOpen = !this.helpOpen;
        this.menuOpen = false;
        this.render();
      },
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
    renderGuestWaitingScreen(content, model, {
      onCancel: this.options.onDisconnect,
    });
  }

  /**
   * Terminal guest screen after the owner rejected this device or the 3-attempt
   * cap was reached. The invitation is spent, so we present a clear message plus
   * the paste form to try a fresh invite, never offline, never a blank form.
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
    renderConnectForm(content, this.draft, this.liveInputs, this.options.onConnect);
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
    renderInviteComposer(content, model, this.draft, this.liveInputs, {
      onClose: this.options.onCloseComposer,
      onCreate: this.options.onCreateInvitation,
      onCopy: this.options.onCopyInvitation,
      onDismiss: this.options.onDismissInvitation,
      onApprove: this.options.onApprove,
    });
  }
}
