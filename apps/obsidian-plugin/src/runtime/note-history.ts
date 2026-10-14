/**
 * The versions of one note, as the history window lists them (plan 012).
 * Pure: the events come from the client's own accepted log, the names from
 * the roster, the times from the receipts. No content here; the window loads
 * a version's text only when one is picked.
 */

import type { RemoteEvent } from '../sync/sync-runner';
import { activityDayLabel, clockLabel } from './activity-render';
import type { RosterMember } from './roster';

export interface NoteHistoryRow {
  readonly revisionId: string;
  readonly author: string;
  readonly when: string;
}

export function buildNoteHistory(
  events: readonly RemoteEvent[],
  roster: readonly RosterMember[],
  now: number = Date.now(),
): NoteHistoryRow[] {
  const names = new Map(roster.map((member) => [member.membershipId, member.displayName]));
  return events
    // Sequence 0 is a queued revision the server has not accepted yet.
    .filter((event) => event.serverSequence > 0)
    .sort((a, b) => b.serverSequence - a.serverSequence)
    .map(({ revision }) => {
      const at = revision.acceptedAt === undefined ? Number.NaN : Date.parse(revision.acceptedAt);
      return {
        revisionId: revision.revisionId,
        author: names.get(revision.authorMembershipId ?? '') ?? 'Unknown author',
        when: Number.isFinite(at) ? `${activityDayLabel(at, now)} ${clockLabel(at)}` : 'Time not recorded',
      };
    });
}
