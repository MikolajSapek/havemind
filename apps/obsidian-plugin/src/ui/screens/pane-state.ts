/**
 * Reads every provider the pane's screen decision rests on, once, behind
 * guards.
 *
 * Two rules are enforced here rather than at each call site.
 *
 * GUARDED: these reads happen before any `renderSection` boundary exists, and
 * after `content.empty()`, so an unguarded throw would blank the pane
 * completely, leaving no header and no way back. Each degrades to the value
 * that keeps the most of the pane usable, and says so in the log.
 *
 * ONCE: a provider called twice in one render can answer differently, and then
 * the tab strip and the tab body describe different states of the same pane.
 */

import type { EntryChoice } from '../../runtime/entry-choice';
import {
  buildConnectionPanel,
  type ConnectionPanelView,
} from '../../runtime/status';
import { resolveViewState, type ViewState } from '../../runtime/view-state';
import type { CreateConnectionViewModel, OnboardingViewOptions } from '../onboarding-types';
import { safeRead } from '../primitives';

export interface PaneState {
  readonly panel: ConnectionPanelView;
  readonly composer: CreateConnectionViewModel | null;
  readonly state: ViewState;
}

export function readPaneState(
  options: OnboardingViewOptions,
  entryChoice: EntryChoice,
  draftToken: string,
): PaneState {
  // Disconnected is the safe default: it offers the connect form rather than
  // claiming a health the plugin cannot currently verify.
  const panel = safeRead(
    'panel',
    options.panelProvider,
    buildConnectionPanel({ status: 'disconnected' }),
  );

  const composer = safeRead('composer', options.composerProvider, null);

  // Which screen to draw is decided by one pure function rather than by the
  // order branches happen to be written in (AT3-1). The precedence it encodes,
  // invalid → awaiting → connected → joining/hosting → choosing, is the one the
  // old if-chain always implemented; lifting it out is what made it assertable,
  // which is what was missing when the composer hid the status row in 1.1.3.
  const state = resolveViewState({
    guestInvalid: safeRead('guestInvalid', options.guestInvalidProvider, false),
    guestWaiting: safeRead('guestWaiting', options.guestWaitingProvider, null),
    panel,
    entryChoice,
    joinLinkFollowed: draftToken.length > 0,
    composerOpen: composer !== null,
  });

  return { panel, composer, state };
}
