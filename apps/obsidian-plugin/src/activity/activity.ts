/**
 * Havemind Activity model: history feed, revision diff and append-only restore.
 *
 * This module implements the pure logic behind the Activity surface described in
 * `plan/06-plugin-activity-i-overlay.md` (issue F5-01 / T028). It consumes
 * `@havemind/sync-core` for the revision DAG and the diff/provenance engine, and
 * never talks to Obsidian, the DOM or the network so it can be exercised in
 * isolation.
 *
 * Hard rules enforced here (see `plan/01-zasady-i-slownik.md`):
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

export type DiffRowType = 'context' | 'added' | 'removed';

export interface DiffRow {
  readonly type: DiffRowType;
  readonly text: string;
}

export interface RevisionDiff {
  readonly rows: readonly DiffRow[];
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

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const withoutTrailingNewline = content.endsWith('\n')
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split('\n');
}

/**
 * A line-level diff for the Activity diff modal. A `null` side means the file
 * did not exist (create) or ceases to exist (delete). Uses a classic
 * longest-common-subsequence walk so unchanged lines stay as context.
 */
export function computeRevisionDiff(
  before: string | null,
  after: string | null,
): RevisionDiff {
  const beforeLines = before === null ? [] : splitLines(before);
  const afterLines = after === null ? [] : splitLines(after);

  const lcs: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    new Array<number>(afterLines.length + 1).fill(0),
  );

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      const nextRow = lcs[i + 1];
      const currentRow = lcs[i];
      if (nextRow === undefined || currentRow === undefined) {
        continue;
      }
      if (beforeLines[i] === afterLines[j]) {
        currentRow[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        currentRow[j] = Math.max(nextRow[j] ?? 0, currentRow[j + 1] ?? 0);
      }
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      rows.push({ type: 'context', text: beforeLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      rows.push({ type: 'removed', text: beforeLines[i] ?? '' });
      i += 1;
    } else {
      rows.push({ type: 'added', text: afterLines[j] ?? '' });
      j += 1;
    }
  }
  for (; i < beforeLines.length; i += 1) {
    rows.push({ type: 'removed', text: beforeLines[i] ?? '' });
  }
  for (; j < afterLines.length; j += 1) {
    rows.push({ type: 'added', text: afterLines[j] ?? '' });
  }

  return { rows };
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
