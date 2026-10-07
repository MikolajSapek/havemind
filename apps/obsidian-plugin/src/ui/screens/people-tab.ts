/**
 * The People tab: who is in this vault, and how someone else gets in.
 *
 * Inviting is a momentary task, so it lives where "who is in this vault"
 * already lives rather than holding a permanent tab of its own (round 2, Q3).
 * The roster and the composer render through callbacks the caller supplies,
 * because both read providers the view owns.
 */

import type { CreateConnectionViewModel, PendingApprovalEntry } from '../onboarding-view';
import { renderSection } from '../primitives';

export interface PeopleTabActions {
  readonly renderRoster: (content: HTMLElement) => void;
  readonly renderComposer: (
    content: HTMLElement,
    model: CreateConnectionViewModel,
  ) => void;
  readonly onOpenComposer?: (() => void) | undefined;
  /** Devices waiting for approval, shown even while the composer is closed. */
  readonly pending?: readonly PendingApprovalEntry[];
  readonly now?: number;
}

/** "Magda wants to join · As editor · expires in 12 min", and the way to approve. */
function renderPendingCards(body: HTMLElement, actions: PeopleTabActions): void {
  const now = actions.now ?? Date.now();
  for (const entry of actions.pending ?? []) {
    const left = Date.parse(entry.expiresAt) - now;
    if (!(left > 0)) continue;
    const name = entry.intendedMemberDisplayName;
    const card = body.createDiv();
    card.addClass('havemind-pending-card');
    card.createDiv({ text: `${name ?? 'A new device'} wants to join` }).addClass('havemind-pending-title');
    const minutes = Math.max(1, Math.round(left / 60_000));
    card
      .createDiv({ text: `As ${entry.intendedRole ?? 'editor'} · expires in ${minutes} min` })
      .addClass('havemind-pending-meta');
    if (actions.onOpenComposer !== undefined) {
      const open = actions.onOpenComposer;
      const enter = card.createEl('button', {
        text: name === undefined ? 'Enter the code' : `Enter ${name}’s code`,
      });
      enter.addClass('mod-cta');
      enter.onClickEvent(() => open());
    }
  }
}

export function renderPeopleTab(
  body: HTMLElement,
  composer: CreateConnectionViewModel | null,
  actions: PeopleTabActions,
): void {
  // A waiting device comes first: it is the one thing on this tab that needs
  // the owner. The composer draws its own approval rows, so not twice.
  if (composer === null) renderPendingCards(body, actions);
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
