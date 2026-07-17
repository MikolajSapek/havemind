/**
 * Live client activity log — the fed data source behind the Activity view.
 *
 * The Activity view was previously orphaned: its `feedProvider` was never set,
 * so it always rendered the empty placeholder. This module is the missing feed.
 * The runtime records an entry at the two points where the client actually
 * learns about a revision — a local change detected by the push producer, and a
 * remote revision applied by the sync runner — and the view reads a snapshot
 * (newest first) that live-updates via `subscribe`.
 *
 * Author attribution is honest (`plan/01` rule 3 — never guess):
 *  - a locally authored change carries the local member's id, resolved to a name
 *    and colour via the roster;
 *  - a remote applied revision does NOT carry an author id in the pull stream
 *    (the decoded payload has no author field), so it is recorded as `remote`.
 *    When the roster has exactly one other member (the two-person pilot) it is
 *    attributed to them; otherwise it stays a neutral "Remote" label. Precise
 *    N-member remote attribution needs the author id surfaced in the pull
 *    payload — a FUTURE server change, deliberately out of scope here.
 *
 * Pure except for the in-memory buffer + listeners; no Obsidian/DOM/network.
 */

import type { ActivityKind, RevisionRecord } from '../activity/activity';
import type { RosterMember } from './roster';

/** The origin of an activity entry (honest author attribution). */
export type ActivityAuthor =
  | { readonly kind: 'member'; readonly membershipId: string }
  | { readonly kind: 'remote' }
  | { readonly kind: 'initial-import' };

/** A single recorded activity: what happened, to which file, by whom, when. */
export interface ActivityLogEntry {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly kind: ActivityKind;
  readonly author: ActivityAuthor;
  readonly timestamp: number;
  /** False for a deletion (a delete row is not restorable). */
  readonly hasContent: boolean;
}

const DEFAULT_MAX_ENTRIES = 200;

/** A neutral, stable id used only to colour unattributable remote entries. */
const REMOTE_COLOR_ID = 'havemind-remote';

/**
 * An append-only, bounded activity log with change notification. Entries are
 * de-duplicated by `revisionId` (a local push and its later remote echo are the
 * same revision), keeping the most recent record.
 */
export class ActivityLog {
  private entries: ActivityLogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxEntries: number;

  constructor(options: { readonly maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Records (or replaces by revisionId) an entry and notifies subscribers. */
  record(entry: ActivityLogEntry): void {
    const next = this.entries.filter(
      (existing) => existing.revisionId !== entry.revisionId,
    );
    next.push(entry);
    // Keep only the most recent `maxEntries` so the log can never grow unbounded.
    this.entries =
      next.length > this.maxEntries
        ? next.slice(next.length - this.maxEntries)
        : next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** All recorded entries in insertion order (oldest first). */
  snapshot(): readonly ActivityLogEntry[] {
    return [...this.entries];
  }

  /** Subscribe to changes; returns an unsubscribe disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Resolves the sole non-self roster member, or null when that is ambiguous
 * (nobody else, or more than one other member — the N-member case).
 */
function soleOtherMember(
  roster: readonly RosterMember[],
): RosterMember | null {
  const others = roster.filter((member) => !member.self);
  return others.length === 1 ? (others[0] as RosterMember) : null;
}

/**
 * Maps recorded entries to the `RevisionRecord[]` the Activity view consumes,
 * resolving each author's display name from the roster. Only the fields the
 * Activity feed needs are populated; content is a marker (`''` vs `null`) so a
 * deletion renders as non-restorable.
 */
export function activityEntriesToRecords(
  entries: readonly ActivityLogEntry[],
  roster: readonly RosterMember[],
): RevisionRecord[] {
  const byMembership = new Map(
    roster.map((member) => [member.membershipId, member]),
  );

  return entries.map((entry): RevisionRecord => {
    const author = resolveAuthor(entry.author, byMembership, roster);
    return {
      revisionId: entry.revisionId,
      vaultId: '',
      fileId: entry.fileId,
      path: entry.path,
      previousPath: null,
      kind: entry.kind,
      actor: author,
      timestamp: entry.timestamp,
      content: entry.hasContent ? '' : null,
      blobHash: '',
      parentRevisionIds: [],
      provenance: [],
      restoredFromRevisionId: null,
    };
  });
}

function resolveAuthor(
  author: ActivityAuthor,
  byMembership: ReadonlyMap<string, RosterMember>,
  roster: readonly RosterMember[],
): RevisionRecord['actor'] {
  if (author.kind === 'initial-import') {
    return { kind: 'initial-import' };
  }
  if (author.kind === 'member') {
    const member = byMembership.get(author.membershipId);
    return {
      kind: 'author',
      actorId: author.membershipId,
      displayName: member?.displayName ?? 'Unknown member',
    };
  }
  // Remote revision with no author id in the pull stream. Attribute it to the
  // sole other member when unambiguous (two-person pilot); otherwise stay
  // neutral. Colour keyed by a resolved membershipId or a stable remote id.
  const other = soleOtherMember(roster);
  if (other !== null) {
    return {
      kind: 'author',
      actorId: other.membershipId,
      displayName: other.displayName,
    };
  }
  return { kind: 'author', actorId: REMOTE_COLOR_ID, displayName: 'Remote' };
}
