/**
 * Havemind Activity model: history feed, revision diff and append-only restore.
 *
 * This module implements the pure logic behind the Activity surface described in
 * `plan/06-plugin-activity-and-overlay.md` (issue F5-01 / T028). It consumes
 * `@havemind/sync-core` for the revision DAG and the diff/provenance engine, and
 * never talks to Obsidian, the DOM or the network so it can be exercised in
 * isolation.
 *
 * Hard rules enforced here (see `plan/01-rules-and-glossary.md`):
 *  - Restore is append-only: it creates a NEW revision on top of the current
 *    head and never rewrites, deletes or mutates any historical revision
 *    (rule 4, zero silent overwrites).
 *  - The restored revision is attributed to the person performing the restore,
 *    while the reused bytes keep their original source attribution via
 *    sync-core provenance (rule 3, honest attribution).
 */

import type { ProvenanceRun } from '@havemind/sync-core';

export type ActivityKind = 'create' | 'edit' | 'rename' | 'delete' | 'conflict';

export type RevisionActor =
  | {
      readonly kind: 'author';
      readonly actorId: string;
      readonly displayName: string;
    }
  | { readonly kind: 'initial-import' };

/**
 * A materialized revision as the client knows it. Content is `null` for a
 * deletion; every content-bearing revision carries provenance that covers its
 * full length (validated by sync-core).
 */
export interface RevisionRecord {
  readonly revisionId: string;
  readonly vaultId: string;
  readonly fileId: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly kind: ActivityKind;
  readonly actor: RevisionActor;
  readonly timestamp: number;
  readonly content: string | null;
  readonly blobHash: string;
  readonly parentRevisionIds: readonly string[];
  readonly provenance: readonly ProvenanceRun[];
  readonly restoredFromRevisionId: string | null;
}

export interface ActivityEntry {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly kind: ActivityKind;
  readonly actorLabel: string;
  /**
   * The author's stable id for colour assignment, or `null` for an
   * `initial-import` fragment (which has no author). Kept alongside the
   * human-readable `actorLabel` so a renderer can pair a deterministic colour
   * with the name without re-deriving the actor.
   */
  readonly actorId: string | null;
  readonly timestamp: number;
  readonly canRestore: boolean;
}

function actorLabel(actor: RevisionActor): string {
  return actor.kind === 'initial-import' ? 'Initial import' : actor.displayName;
}

/** Builds the Activity feed, newest first, with deterministic tie-breaking. */
export function buildActivityFeed(
  records: readonly RevisionRecord[],
): ActivityEntry[] {
  return records
    .map(
      (record): ActivityEntry => ({
        revisionId: record.revisionId,
        fileId: record.fileId,
        path: record.path,
        kind: record.kind,
        actorLabel: actorLabel(record.actor),
        actorId: record.actor.kind === 'author' ? record.actor.actorId : null,
        timestamp: record.timestamp,
        canRestore: record.content !== null,
      }),
    )
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return left.revisionId < right.revisionId ? 1 : -1;
    });
}
