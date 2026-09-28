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

import {
  generateEditRecipe,
  reconstructFromRecipe,
  RevisionDag,
  RevisionDagError,
  type ParentSnapshot,
  type ProvenanceRun,
  type ReconstructionRecipe,
  type RevisionNode,
} from '@havemind/sync-core';

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

export interface RestoreRevisionOptions {
  readonly history: readonly RevisionRecord[];
  readonly targetRevisionId: string;
  readonly restorer: { readonly actorId: string; readonly displayName: string };
  readonly now: number;
  readonly newRevisionId: string;
  readonly hashContent: (content: string) => string;
}

export interface RestoreResult {
  readonly revision: RevisionNode;
  readonly record: RevisionRecord;
  readonly recipe: ReconstructionRecipe;
  readonly reconstructedContent: string;
}

export type ActivityErrorCode =
  | 'APPEND_ONLY_VIOLATION'
  | 'DELETED_TARGET'
  | 'UNKNOWN_TARGET'
  | 'UNRECONCILED_HISTORY';

export class ActivityError extends Error {
  override readonly name = 'ActivityError';

  constructor(
    readonly code: ActivityErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
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

function buildHistoryDag(history: readonly RevisionRecord[]): RevisionDag {
  const dag = new RevisionDag();
  for (const record of history) {
    dag.add(toRevisionNode(record));
  }
  return dag;
}

function toRevisionNode(record: RevisionRecord): RevisionNode {
  return {
    revisionId: record.revisionId,
    vaultId: record.vaultId,
    fileId: record.fileId,
    parentRevisionIds: [...record.parentRevisionIds],
    blobHash: record.blobHash,
  };
}

function headSnapshot(head: RevisionRecord): ParentSnapshot {
  if (head.content === null) {
    // The file is currently deleted; restore reintroduces every byte as the
    // restorer's own work rather than inventing a phantom parent snapshot.
    return { revisionId: head.revisionId, content: '', provenance: [] };
  }
  return {
    revisionId: head.revisionId,
    content: head.content,
    provenance: head.provenance,
  };
}

/**
 * Restores the content of a historical revision by appending a NEW revision on
 * top of the current head. History is never rewritten: the append is validated
 * against the sync-core DAG, and any attempt to reuse an existing revision id or
 * to bypass the current head is rejected.
 */
export function restoreRevision(options: RestoreRevisionOptions): RestoreResult {
  const { history, targetRevisionId, restorer, now, newRevisionId, hashContent } =
    options;

  const target = history.find(
    (record) => record.revisionId === targetRevisionId,
  );
  if (target === undefined) {
    throw new ActivityError(
      'UNKNOWN_TARGET',
      `Cannot restore unknown target revision ${targetRevisionId}.`,
    );
  }
  if (target.content === null) {
    throw new ActivityError(
      'DELETED_TARGET',
      `Cannot restore the content of a deleted revision ${targetRevisionId}.`,
    );
  }

  const dag = buildHistoryDag(history);
  const heads = dag.getHeads(target.vaultId, target.fileId);
  if (heads.length !== 1) {
    throw new ActivityError(
      'UNRECONCILED_HISTORY',
      `Restore requires a single reconciled head, found ${heads.length}.`,
    );
  }

  const headId = heads[0] as string;
  const head = history.find((record) => record.revisionId === headId);
  if (head === undefined) {
    throw new ActivityError(
      'UNRECONCILED_HISTORY',
      `The current head ${headId} is missing from history.`,
    );
  }

  const parent = headSnapshot(head);
  const recipe = generateEditRecipe(parent, target.content);
  const reconstructed = reconstructFromRecipe(recipe, [parent], newRevisionId);

  const revision: RevisionNode = {
    revisionId: newRevisionId,
    vaultId: target.vaultId,
    fileId: target.fileId,
    parentRevisionIds: [headId],
    blobHash: hashContent(target.content),
  };

  try {
    dag.add(revision);
  } catch (error) {
    if (error instanceof RevisionDagError) {
      throw new ActivityError(
        'APPEND_ONLY_VIOLATION',
        `Restore would break the append-only history: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const record: RevisionRecord = {
    revisionId: newRevisionId,
    vaultId: target.vaultId,
    fileId: target.fileId,
    path: head.path,
    previousPath: null,
    kind: 'edit',
    actor: {
      kind: 'author',
      actorId: restorer.actorId,
      displayName: restorer.displayName,
    },
    timestamp: now,
    content: reconstructed.content,
    blobHash: revision.blobHash,
    parentRevisionIds: [headId],
    provenance: reconstructed.provenance,
    restoredFromRevisionId: target.revisionId,
  };

  return {
    revision,
    record,
    recipe,
    reconstructedContent: reconstructed.content,
  };
}
