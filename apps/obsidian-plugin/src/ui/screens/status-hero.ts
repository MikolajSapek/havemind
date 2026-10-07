/**
 * The Status tab: the flower, the state in a word or two, one line under it,
 * and the one recovery action the state allows. Nothing else, by design.
 *
 * Every provider read is guarded on its own: a roster or conflict scan that
 * throws costs the flower its seats, never the whole tab.
 */

import { buildFlowerModel } from '../../runtime/flower-model';
import type { RosterMember } from '../../runtime/roster';
import { statusHeroText } from '../../runtime/status-hero';
import type { ConnectionPanelView } from '../../runtime/status';
import type { OnboardingViewOptions } from '../onboarding-types';
import { renderFlower } from '../flower';

import { renderRecoveryActions } from './status-indicator';

function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function rosterMembers(options: OnboardingViewOptions): RosterMember[] {
  return guarded(
    () =>
      (options.rejoinRosterProvider?.().rows ?? []).map((row) => ({
        membershipId: row.membershipId,
        displayName: row.displayName,
        role: row.role,
        self: row.self,
      })),
    [],
  );
}

export function renderStatusHero(
  target: HTMLElement,
  panel: ConnectionPanelView,
  options: OnboardingViewOptions,
  /** Read once per render by the caller; a second read could disagree with it. */
  pendingJoins: number,
): void {
  const members = rosterMembers(options);
  const conflicts = guarded(() => options.conflictsProvider?.() ?? [], []);
  const recentActorIds = guarded(
    () =>
      (options.activityFeedProvider?.() ?? []).flatMap((record) =>
        record.actor.kind === 'author' ? [record.actor.actorId] : [],
      ),
    [],
  );
  const model = buildFlowerModel({
    members,
    status: panel.status,
    conflictAuthors: conflicts.map((copy) => copy.author),
    pendingJoins,
    recentActorIds,
  });
  const text = statusHeroText({
    status: panel.status,
    detail: panel.detail,
    deviceCount: members.length,
    waitingCount: guarded(() => options.sendQueueProvider?.()?.waitingCount ?? 0, 0),
    conflictCount: conflicts.length,
  });

  const hero = target.createDiv();
  hero.addClass('havemind-hero');
  renderFlower(hero, model);
  hero.createDiv({ text: text.title }).addClass('havemind-hero-title');
  if (text.subline !== '') hero.createDiv({ text: text.subline }).addClass('havemind-hero-sub');
  renderRecoveryActions(hero, panel, { onRetry: options.onRetry, onReset: options.onReset });
}
