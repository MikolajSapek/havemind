/**
 * Bridges the Activity feed's "Restore" action to the append-only
 * `restoreRevision` in `activity/activity.ts`. Kept separate from `main.ts` so
 * the restore-wiring logic is unit-testable without the Obsidian runtime — the
 * plugin's lifecycle tests assert exact DOM content and must not entangle
 * with this (mirrors the existing `activity-render.ts` seam).
 *
 * Known MVP limitation: the Activity feed never carries real note content
 * (only a `hasContent` marker — rule: never log note contents), so a restore
 * driven purely from the feed reconstructs from that marker content, not the
 * historical bytes. Full-fidelity restore needs the client to keep the actual
 * revision content available locally, which is a larger follow-up.
 */

import {
  ActivityError,
  restoreRevision,
  type RevisionRecord,
} from '../activity/activity';
import type { ActivityLogEntry } from './activity-log';

export interface RestoreActivityEntryOptions {
  readonly history: readonly RevisionRecord[];
  readonly targetRevisionId: string;
  readonly restorer: { readonly actorId: string; readonly displayName: string };
  readonly now: number;
  readonly newRevisionId: string;
}

/**
 * Runs the append-only restore and maps the result to an Activity log entry
 * attributed to the restorer, or returns `null` when the restore could not be
 * performed (unknown/deleted target, unreconciled history) — the caller
 * decides how to surface that (e.g. a `Notice`).
 */
export function restoreActivityEntry(
  options: RestoreActivityEntryOptions,
): ActivityLogEntry | null {
  try {
    const result = restoreRevision({
      history: options.history,
      targetRevisionId: options.targetRevisionId,
      restorer: options.restorer,
      now: options.now,
      newRevisionId: options.newRevisionId,
      // Non-cryptographic: this hash only feeds the in-memory Activity DAG's
      // append validation for this restore call — never the server, never
      // durable sync state, never a security boundary.
      hashContent: nonCryptoHash,
    });
    return {
      revisionId: result.record.revisionId,
      fileId: result.record.fileId,
      path: result.record.path,
      kind: result.record.kind,
      author: { kind: 'member', membershipId: options.restorer.actorId },
      timestamp: result.record.timestamp,
      hasContent: result.record.content !== null,
    };
  } catch (error) {
    if (error instanceof ActivityError) return null;
    throw error;
  }
}

function nonCryptoHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }
  return hash.toString(16);
}
