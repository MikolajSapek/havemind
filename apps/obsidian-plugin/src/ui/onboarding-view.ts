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

import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { renderGuestWaitingScreen } from './screens/guest-waiting';
import { renderEntryPath } from './screens/entry-path';
import { renderConnectForm } from './screens/connect-form';
import { renderConnectedBody } from './screens/connected-body';
import { renderConflicts, renderSendQueue } from './screens/alarms';
import { renderGuestInvalid } from './screens/guest-invalid';
import { renderTabBody } from './screens/tab-body';
import { readPaneState } from './screens/pane-state';
import { buildTabScreens } from './screens/tab-screens';
import { renderPaneChrome } from './screens/pane-chrome';
import { buildHeaderMenuItems } from './screens/header-menu';
import { renderStatusIndicator } from './screens/status-indicator';
import {
  type ConnectionPanelView,
} from '../runtime/status';

import type { EntryChoice } from '../runtime/entry-choice';
import {
  buildPaneTabs,
  type PaneTabId,
  type PaneTabsView,
} from '../runtime/pane-tabs';

import type { PaneMenuItem } from './pane-header';
import {
  safeRead,
} from './primitives';
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

    const { panel, composer, state } = readPaneState(
      this.options,
      this.entryChoice,
      this.draft.token,
    );

    if (state.kind === 'invalid') {
      renderGuestInvalid(content, this.options.guestWaitingProvider?.()?.ownerName, {
        renderForm: (target) =>
          renderConnectForm(target, this.draft, this.liveInputs, this.options.onConnect),
      });
      return;
    }

    if (state.kind === 'awaiting') {
      renderGuestWaitingScreen(content, state.waiting, {
        onCancel: this.options.onDisconnect,
      });
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

    this.renderConnectedBody(content, panel, composer);
  }

  /**
   * Everything below the header: the alarms, the tab strip and the open tab.
   *
   * Split from `render()` so the dispatcher above stays readable as a list of
   * screens. The ordering rules it encodes are the load-bearing part, and they
   * are commented where they apply.
   */
  private renderConnectedBody(
    content: HTMLElement,
    panel: ConnectionPanelView,
    composer: CreateConnectionViewModel | null,
  ): void {
    const bodyState = {
      activeTab: this.activeTab,
      focusTabOnRender: this.focusTabOnRender,
    };
    renderConnectedBody(content, panel, composer, bodyState, {
      renderIndicator: (target, p) =>
        renderStatusIndicator(target, p, {
          onRetry: this.options.onRetry,
          onReset: this.options.onReset,
        }),
      renderSendQueue: (target) =>
        renderSendQueue(target, {
          recoveryRequired: this.options.recoveryRequiredProvider?.() ?? false,
          view: this.options.sendQueueProvider?.() ?? null,
          onRetry: this.options.onRetrySend,
          onDiscard: this.options.onDiscardSend,
        }),
      renderConflicts: (target) =>
        renderConflicts(target, {
          copies: this.options.conflictsProvider?.() ?? [],
          onResolve: this.options.onResolveConflict,
        }),
      renderEntryPath: (target) => this.entryPath(target),
      paneTabs: (open) => this.paneTabs(open),
      renderTabBody: (target, tab, p, c) => this.renderTabBody(target, tab, p, c),
      onSelectTab: (id, viaKeyboard) => {
        this.activeTab = id;
        this.focusTabOnRender = viaKeyboard;
        this.render();
      },
    });
    // The body consumes the focus flag; mirror that back so the next render
    // does not steal focus again.
    this.focusTabOnRender = bodyState.focusTabOnRender;
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
    renderTabBody(
      body,
      tab,
      panel,
      composer,
      buildTabScreens({
        options: this.options,
        draft: this.draft,
        liveInputs: this.liveInputs,
        helpOpen: this.helpOpen,
        onToggleHelp: () => {
          this.helpOpen = !this.helpOpen;
          this.render();
        },
      }),
    );
  }

  /** Reads live input values into `draft` so the next render can restore them. */
  private captureDrafts(): void {
    const live = this.liveInputs;
    if (live.token) this.draft.token = live.token.value;
    if (live.server) this.draft.server = live.server.value;
    if (live.role) this.draft.role = live.role.value === 'owner' ? 'owner' : 'editor';
    if (live.name) this.draft.name = live.name.value;
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
  private entryPath(content: HTMLElement): void {
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
        renderForm: (target) =>
          renderConnectForm(target, this.draft, this.liveInputs, this.options.onConnect),
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
}
