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
 * Placeholder vaultId for records built from the Activity feed. The feed has
 * never tracked a real per-entry vaultId (single-vault MVP), but sync-core's
 * RevisionDag rejects an empty one outright, and it is required for the
 * append-only restore path (`activity-restore.ts`) to build its DAG.
 */
const FEED_VAULT_ID = 'havemind-feed';

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
 *
 * Correct only for the two-person pilot: with exactly one other roster member
 * "the sole other member" and "the true author of this remote revision" are
 * the same person by construction. This stops being sound the moment a third
 * member joins — see the module docstring above for the N-member follow-up.
 */
function soleOtherMember(
  roster: readonly RosterMember[],
): RosterMember | null {
  const others = roster.filter((member) => !member.self);
  return others.length === 1 ? (others[0] as RosterMember) : null;
}

/** The decoded operation kinds a remote revision payload can carry. */
export type RemoteRevisionOperation =
  | 'initial-import'
  | 'create'
  | 'update'
  | 'rename'
  | 'restore'
  | 'reconcile'
  | 'delete';

/** The raw fields the vault-apply adapter reports for a genuinely applied remote revision. */
export interface RemoteAppliedInfo {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly operation: RemoteRevisionOperation;
}

/**
 * Maps a genuinely applied remote revision (never a 'noop' or 'conflict'
 * outcome) to an Activity log entry attributed to `remote`. Kept as a pure
 * function so the mapping is unit-testable without the Obsidian runtime; the
 * runtime glue (`obsidian-adapters.ts`) only wires the call site and supplies
 * the wall-clock timestamp.
 */
export function remoteAppliedToActivityEntry(
  info: RemoteAppliedInfo,
  timestamp: number,
): ActivityLogEntry {
  return {
    revisionId: info.revisionId,
    fileId: info.fileId,
    path: info.path,
    kind: toRemoteActivityKind(info.operation),
    author: { kind: 'remote' },
    timestamp,
    hasContent: info.operation !== 'delete',
  };
}

/** Whether an applied remote revision came from the initial catch-up or a live edit. */
export type RemoteAppliedOrigin = 'bootstrap' | 'live';

/** {@link RemoteAppliedInfo} plus the origin the vault-apply adapter reports. */
export interface RemoteAppliedInfoWithOrigin extends RemoteAppliedInfo {
  readonly origin: RemoteAppliedOrigin;
}

/**
 * Maps an applied remote revision to an Activity entry, or `null` when it is part
 * of the initial BOOTSTRAP catch-up. The one-time materialisation of a
 * pre-existing vault (a joining device, or the owner re-pulling after a data.json
 * wipe) applies one revision per file; recording each would flood the feed with a
 * full replay of the vault. Bootstrap applies are therefore collapsed to silence
 * — the files still land on disk, only the Activity entry is withheld — while every
 * LIVE peer edit afterwards still records a normal entry via
 * {@link remoteAppliedToActivityEntry}.
 */
export function remoteAppliedToActivityEntryOrNull(
  info: RemoteAppliedInfoWithOrigin,
  timestamp: number,
): ActivityLogEntry | null {
  if (info.origin === 'bootstrap') {
    return null;
  }
  return remoteAppliedToActivityEntry(info, timestamp);
}

function toRemoteActivityKind(operation: RemoteRevisionOperation): ActivityKind {
  switch (operation) {
    case 'create':
      return 'create';
    case 'update':
      return 'edit';
    case 'rename':
      return 'rename';
    case 'delete':
      return 'delete';
    default:
      // 'initial-import' / 'restore' / 'reconcile' have no closer ActivityKind
      // match; 'edit' is the safe, non-destructive default label.
      return 'edit';
  }
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
      // A non-empty placeholder: the feed never tracks a real vaultId today,
      // but sync-core's RevisionDag (used by the append-only restore path)
      // rejects an empty vaultId outright.
      vaultId: FEED_VAULT_ID,
      fileId: entry.fileId,
      path: entry.path,
      previousPath: null,
      kind: entry.kind,
      actor: author,
      timestamp: entry.timestamp,
      content: entry.hasContent ? '' : null,
      // Non-empty placeholder for the same reason as vaultId above — the feed
      // never tracks a real content hash, but RevisionDag rejects an empty
      // blobHash. Keyed by revisionId so distinct entries stay distinct.
      blobHash: `feed:${entry.revisionId}`,
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
