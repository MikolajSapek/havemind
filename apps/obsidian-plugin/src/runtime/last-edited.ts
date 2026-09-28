/**
 * "Last edited by X" for the open note, shown in the status bar. The author is
 * the membership the server stamped on the file's newest revision, so it
 * survives a restart, unlike the in-memory Activity feed.
 */

import type { RemoteEvent } from '../sync/sync-runner';
import type { RosterMember } from './roster';

/** The author of the newest of a file's head revisions, or null. */
export function newestAuthor(heads: readonly RemoteEvent[]): string | null {
  let newest: RemoteEvent | null = null;
  for (const head of heads) {
    if (newest === null || head.serverSequence > newest.serverSequence) newest = head;
  }
  return newest?.revision.authorMembershipId ?? null;
}

export function lastEditedLabel(
  membershipId: string | null,
  roster: readonly RosterMember[],
): string {
  if (membershipId === null) return '';
  const member = roster.find((entry) => entry.membershipId === membershipId);
  if (member === undefined) return 'Last edited by another member';
  return `Last edited by ${member.self ? 'you' : member.displayName}`;
}
