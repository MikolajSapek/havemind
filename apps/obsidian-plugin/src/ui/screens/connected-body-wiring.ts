/**
 * Wires the connected body from the pane's injected options.
 *
 * Split from `connected-body.ts` so each file stays under the screens ceiling:
 * that file owns the LAYOUT and the ordering rules, this one owns the plumbing
 * from the options bag to the renderers.
 */

import { buildPaneTabs, type PaneTabId } from '../../runtime/pane-tabs';
import type { EntryChoice } from '../../runtime/entry-choice';
import type { ConnectionPanelView } from '../../runtime/status';
import type { CreateConnectionViewModel, OnboardingViewOptions } from '../onboarding-types';

import {
  renderConnectedBody,
  type ConnectedBodyState,
} from './connected-body';
import { renderConnectForm, type PaneDraft, type PaneLiveInputs } from './connect-form';
import { renderEntryPath } from './entry-path';
import { renderTabBody } from './tab-body';
import { attentionCount, buildBodyRenderers, buildTabScreens } from './tab-screens';

/** The pane state the body reads and writes, all owned by the view. */
export interface BodyContext {
  readonly options: OnboardingViewOptions;
  readonly draft: PaneDraft;
  readonly liveInputs: PaneLiveInputs;
  readonly entryChoice: EntryChoice;
  readonly helpOpen: boolean;
  readonly activeTab: PaneTabId;
  readonly focusTabOnRender: boolean;
}

/** What selecting something in the body has to be able to change. */
export interface BodyCallbacks {
  readonly setEntryChoice: (choice: EntryChoice) => void;
  readonly setHelpOpen: (open: boolean) => void;
  readonly setActiveTab: (id: PaneTabId, viaKeyboard: boolean) => void;
  readonly repaint: () => void;
  readonly openGuide: (url: string) => void;
}

/**
 * Wires the body from the options bag, and reports back whether the focus flag
 * was consumed so the next render does not steal focus again.
 */
export function renderConnectedBodyFor(
  content: HTMLElement,
  panel: ConnectionPanelView,
  composer: CreateConnectionViewModel | null,
  context: BodyContext,
  callbacks: BodyCallbacks,
): { readonly focusTabOnRender: boolean } {
  const { options } = context;
  const state: ConnectedBodyState = {
    activeTab: context.activeTab,
    focusTabOnRender: context.focusTabOnRender,
  };

  renderConnectedBody(content, panel, composer, state, {
    ...buildBodyRenderers(options),
    renderEntryPath: (target) =>
      renderEntryPath(
        target,
        {
          entryChoice: context.entryChoice,
          draftToken: context.draft.token,
          canHost: options.canHost ?? true,
        },
        {
          arrivedWithInvitation: options.arrivedWithInvitationProvider,
          composer: options.composerProvider,
        },
        {
          onChoose: callbacks.setEntryChoice,
          renderForm: (formTarget) =>
            renderConnectForm(formTarget, context.draft, context.liveInputs, options.onConnect),
          onOpenGuide: callbacks.openGuide,
        },
      ),
    // `open` is passed in, not re-read: the provider was asked once already, and
    // a second call could answer differently, leaving the strip and the body
    // describing different states. An open composer selects People rather than
    // a tab of its own (round 2, Q3).
    paneTabs: (open) =>
      buildPaneTabs({
        active: open ? 'people' : context.activeTab,
        attentionCount: attentionCount(options),
      }),
    renderTabBody: (target, tab, p, c) =>
      renderTabBody(
        target,
        tab,
        p,
        c,
        buildTabScreens({
          options,
          draft: context.draft,
          liveInputs: context.liveInputs,
          helpOpen: context.helpOpen,
          onToggleHelp: () => {
            callbacks.setHelpOpen(!context.helpOpen);
            callbacks.repaint();
          },
        }),
      ),
    onSelectTab: callbacks.setActiveTab,
  });

  return { focusTabOnRender: state.focusTabOnRender };
}
