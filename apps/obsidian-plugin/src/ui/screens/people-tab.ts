/**
 * The People tab: who is in this vault, and how someone else gets in.
 *
 * Inviting is a momentary task, so it lives where "who is in this vault"
 * already lives rather than holding a permanent tab of its own (round 2, Q3).
 * The roster and the composer render through callbacks the caller supplies,
 * because both read providers the view owns.
 */

import type { CreateConnectionViewModel } from '../onboarding-view';
import { renderSection } from '../primitives';

export interface PeopleTabActions {
  readonly renderRoster: (content: HTMLElement) => void;
  readonly renderComposer: (
    content: HTMLElement,
    model: CreateConnectionViewModel,
  ) => void;
  readonly onOpenComposer?: (() => void) | undefined;
}

export function renderPeopleTab(
  body: HTMLElement,
  composer: CreateConnectionViewModel | null,
  actions: PeopleTabActions,
): void {
  renderSection(body, 'roster', () => actions.renderRoster(body));

  if (composer !== null) {
    actions.renderComposer(body, composer);
    return;
  }

  if (actions.onOpenComposer !== undefined) {
    const open = body.createEl('button', { text: 'Invite someone' });
    open.addClass('havemind-invite-cta');
    open.onClickEvent(() => actions.onOpenComposer?.());
  }
}
