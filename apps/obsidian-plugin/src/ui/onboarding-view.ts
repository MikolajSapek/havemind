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
import { captureDrafts, renderConnectForm } from './screens/connect-form';
import { renderConnectedBodyFor } from './screens/connected-body-wiring';
import { renderGuestInvalid } from './screens/guest-invalid';
import { readPaneState } from './screens/pane-state';
import { renderPaneChromeFor } from './screens/pane-chrome';

import type { EntryChoice } from '../runtime/entry-choice';
import type { PaneTabId } from '../runtime/pane-tabs';

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

import type { InvitationRole, OnboardingViewOptions } from './onboarding-types';


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
    captureDrafts(this.draft, this.liveInputs);
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

    renderPaneChromeFor(
      content,
      panel,
      this.options,
      { menuOpen: this.menuOpen, helpOpen: this.helpOpen },
      {
        setMenuOpen: (open) => {
          this.menuOpen = open;
        },
        setHelpOpen: (open) => {
          this.helpOpen = open;
        },
        repaint: () => this.render(),
      },
    );

    const { focusTabOnRender } = renderConnectedBodyFor(
      content,
      panel,
      composer,
      {
        options: this.options,
        draft: this.draft,
        liveInputs: this.liveInputs,
        entryChoice: this.entryChoice,
        helpOpen: this.helpOpen,
        activeTab: this.activeTab,
        focusTabOnRender: this.focusTabOnRender,
      },
      {
        setEntryChoice: (choice) => {
          this.entryChoice = choice;
          this.render();
        },
        setHelpOpen: (open) => {
          this.helpOpen = open;
        },
        setActiveTab: (id, viaKeyboard) => {
          this.activeTab = id;
          this.focusTabOnRender = viaKeyboard;
          this.render();
        },
        repaint: () => this.render(),
        openGuide: (url) => {
          window.open(url, '_blank');
        },
      },
    );
    // The body consumes the focus flag; mirror that back so the next render
    // does not steal focus again.
    this.focusTabOnRender = focusTabOnRender;
  }

  /**
   * Everything below the header: the alarms, the tab strip and the open tab.
   *
   * Split from `render()` so the dispatcher above stays readable as a list of
   * screens. The ordering rules it encodes are the load-bearing part, and they
   * are commented where they apply.
   */
  /** Renders the rejoin-aware roster with its owner actions from the options. */
}
