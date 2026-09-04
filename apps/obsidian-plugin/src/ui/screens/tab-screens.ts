/**
 * Builds the four tab bodies from the pane's injected options.
 *
 * Everything here reads only the options bag, the draft and two flags, so the
 * view no longer carries a layer of methods whose whole job was repacking
 * `this.options` for a screen. The view keeps what it must own: the flags, the
 * draft, and the repaint.
 */

import { buildGettingStartedViewModel } from '../../runtime/getting-started-render';
import type { CreateConnectionViewModel, OnboardingViewOptions } from '../onboarding-types';
import { renderActivityRows } from '../activity-section';
import { renderGettingStarted } from '../getting-started-section';
import { renderRejoinRoster } from '../roster-section';

import { renderConnectionControls } from './connection-controls';
import type { ConnectDraft, ConnectLiveInputs } from './connect-form';
import { renderInviteComposer } from './invite-composer';
import { renderPeopleTab } from './people-tab';
import { renderStatusIndicator } from './status-indicator';
import type { TabBodyScreens } from './tab-body';

export interface TabScreensContext {
  readonly options: OnboardingViewOptions;
  readonly draft: ConnectDraft & { role: string; name: string };
  readonly liveInputs: ConnectLiveInputs & {
    role?: HTMLElement | undefined;
    name?: HTMLElement | undefined;
  };
  readonly helpOpen: boolean;
  /** Flips the getting-started disclosure and repaints; owned by the view. */
  readonly onToggleHelp: () => void;
}

export function buildTabScreens(context: TabScreensContext): TabBodyScreens {
  const { options } = context;
  return {
    renderStatus: (target, panel) => {
      renderStatusIndicator(target, panel, {
        onRetry: options.onRetry,
        onReset: options.onReset,
      });
      if (context.helpOpen) {
        renderGettingStarted(target, buildGettingStartedViewModel());
      }
    },
    renderActivity: (target) => {
      renderActivityRows(target, {
        feed: options.activityFeedProvider?.() ?? [],
        ...(options.onRestore ? { onRestore: options.onRestore } : {}),
      });
    },
    renderConnect: (target, panel) =>
      renderConnectionControls(target, panel, context.helpOpen, {
        onSyncNow: options.onSyncNow,
        onRetry: options.onRetry,
        onReset: options.onReset,
        onDisconnect: options.onDisconnect,
        onToggleHelp: context.onToggleHelp,
      }),
    renderPeople: (target, model: CreateConnectionViewModel | null) =>
      renderPeopleTab(target, model, {
        renderRoster: (rosterTarget) => {
          // Read inside the boundary, not around it: a roster that cannot be
          // built should show the section fallback where the list would have
          // been, rather than vanishing silently and leaving the tab empty.
          const roster = options.rejoinRosterProvider?.();
          if (roster === undefined) return;
          renderRejoinRoster(rosterTarget, roster, {
            waiting: options.rejoinWaitingProvider?.() ?? new Set<string>(),
            ...(options.onRejoin === undefined ? {} : { onRejoin: options.onRejoin }),
            ...(options.onMarkDisconnected === undefined
              ? {}
              : { onMarkDisconnected: options.onMarkDisconnected }),
            ...(options.onRemove === undefined ? {} : { onRemove: options.onRemove }),
          });
        },
        renderComposer: (composerTarget, m) =>
          renderInviteComposer(composerTarget, m, context.draft, context.liveInputs, {
            onClose: options.onCloseComposer,
            onCreate: options.onCreateInvitation,
            onCopy: options.onCopyInvitation,
            onDismiss: options.onDismissInvitation,
            onApprove: options.onApprove,
          }),
        onOpenComposer: options.onOpenComposer,
      }),
  };
}
