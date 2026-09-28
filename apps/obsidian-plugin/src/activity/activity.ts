/**
 * Havemind Activity model: turns the in-memory feed into rows, newest first.
 * Pure logic, no Obsidian, DOM or network.
 */

export type ActivityKind = 'create' | 'edit' | 'rename' | 'delete' | 'conflict';

export type RevisionActor =
  | {
      readonly kind: 'author';
      readonly actorId: string;
      readonly displayName: string;
    }
  | { readonly kind: 'initial-import' };

/** One feed entry. `content` is null for a deletion, which cannot be restored. */
export interface RevisionRecord {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly kind: ActivityKind;
  readonly actor: RevisionActor;
  readonly timestamp: number;
  readonly content: string | null;
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
