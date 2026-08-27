/**
 * Feeds the pure author-overlay model (`attribution.ts`) from what this client
 * actually knows about a file.
 *
 * HONEST DEGRADATION, read this before extending. The overlay model is built
 * for PER-CHARACTER provenance: `OverlayInput.provenance` is a run list that
 * must cover the document byte-for-byte, so a segment can legitimately say
 * "Magda wrote these 40 characters". The client cannot produce that today. The
 * Activity feed (`runtime/activity-log.ts`) records one entry per revision with
 * no provenance at all, `activityEntriesToRecords` emits `provenance: []`, and
 * the pull stream carries no per-run source ids either. Synthesising runs would
 * be invented attribution, which `plan/01-zasady-i-slownik.md` rule 3 forbids.
 *
 * So this slice attributes PER FILE: one run spanning the whole document,
 * sourced from the most recent recorded revision for that path. The visible
 * claim is therefore "this note was last changed by X at T", exactly what the
 * feed records, and never "X wrote this line". When real per-run provenance
 * reaches the client, only this module changes: both overlay builders and both
 * renderers already speak runs.
 *
 * Silence is the default. No path, no recorded revision for the path, or an
 * empty document all produce `null`, no overlay rather than a guess.
 *
 * Pure: no Obsidian, DOM or network.
 */

import type { OverlayActor, OverlayInput } from './attribution';
import type { RevisionActor } from '../activity/activity';
import {
  activityEntriesToRecords,
  type ActivityLogEntry,
} from '../runtime/activity-log';
import type { RosterMember } from '../runtime/roster';

/**
 * Stand-in for the pair of hashes the per-character guard compares. Whole-file
 * attribution makes no per-character claim, so there is no byte-for-byte head
 * revision to verify against, both fields carry this same value so the guard
 * passes. The honest guard for this slice is the "is anything recorded for this
 * path" check below, not a hash.
 */
const WHOLE_FILE_ATTRIBUTION = 'havemind:whole-file-attribution';

export interface FileOverlayInputRequest {
  /** Whether the "Show authors" toggle is on for this vault. */
  readonly enabled: boolean;
  /** Vault path of the file on screen, or null when the surface has none. */
  readonly path: string | null;
  /** The document exactly as the surface currently shows it. */
  readonly content: string;
  /** The live Activity feed snapshot (any order, any path). */
  readonly entries: readonly ActivityLogEntry[];
  /** The presence roster, used to resolve a membership id to a name. */
  readonly roster: readonly RosterMember[];
  readonly reducedMotion: boolean;
  readonly formatTimestamp?: (timestamp: number) => string;
}

/** The newest record by timestamp; later entries win a tie (insertion order). */
function newestByTimestamp<T extends { readonly timestamp: number }>(
  records: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const record of records) {
    if (newest === null || record.timestamp >= newest.timestamp) {
      newest = record;
    }
  }
  return newest;
}

/** The Activity actor shape and the overlay actor shape agree field for field. */
function toOverlayActor(actor: RevisionActor): OverlayActor {
  if (actor.kind === 'initial-import') {
    return { kind: 'initial-import' };
  }
  return {
    kind: 'author',
    actorId: actor.actorId,
    displayName: actor.displayName,
  };
}

/**
 * Builds the overlay input for one file, or `null` when nothing can be claimed
 * honestly. See the module docstring for why the run covers the whole document.
 */
export function buildFileOverlayInput(
  request: FileOverlayInputRequest,
): OverlayInput | null {
  const { path } = request;
  if (!request.enabled || path === null) {
    return null;
  }
  // A provenance run must have a positive length, and an empty document has
  // nothing to decorate anyway.
  if (request.content.length === 0) {
    return null;
  }

  const forPath = request.entries.filter((entry) => entry.path === path);
  if (forPath.length === 0) {
    // Nothing recorded for this file, the overlay says nothing rather than
    // attributing the note to whoever happens to be in the roster.
    return null;
  }

  // Reuse the Activity feed's own author resolution so the overlay, the Activity
  // rows and the roster always name (and colour) the same person the same way.
  const newest = newestByTimestamp(
    activityEntriesToRecords(forPath, request.roster),
  );
  if (newest === null) {
    return null;
  }

  return {
    enabled: true,
    content: request.content,
    contentHash: WHOLE_FILE_ATTRIBUTION,
    headBlobHash: WHOLE_FILE_ATTRIBUTION,
    provenance: [
      { length: request.content.length, sourceRevisionId: newest.revisionId },
    ],
    authors: new Map([
      [
        newest.revisionId,
        {
          actor: toOverlayActor(newest.actor),
          timestamp: newest.timestamp,
        },
      ],
    ]),
    reducedMotion: request.reducedMotion,
    ...(request.formatTimestamp === undefined
      ? {}
      : { formatTimestamp: request.formatTimestamp }),
  };
}
