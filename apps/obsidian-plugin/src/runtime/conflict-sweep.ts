/**
 * MRG-05 — auto-repair sweep for existing conflict copies.
 *
 * A conflict copy is a divergent revision the apply path could not converge in
 * place (see vault-apply.ts). Once the merge ancestor for the target note is
 * durably known (MRG-01 `baseContents`), many of those copies CAN be merged
 * automatically after the fact: the ancestor + the live note + the copy is a
 * clean three-way merge input. This sweep re-attempts that merge for every
 * parseable copy and, on success, writes the merged text back into the note and
 * deletes the copy — collapsing conflicts that only ever needed a later apply.
 *
 * Hard laws honoured here:
 *  - NEVER guess an ancestor. A copy whose target has no hash-verified base
 *    content is left untouched for the manual modal.
 *  - NEVER delete a copy unless its content was FULLY merged into the note
 *    (zero content loss). A merge conflict/overlap, binary copy, legacy UUID
 *    name or unpairable target is skipped, never deleted.
 *  - Per-item error isolation: one unreadable/undeletable copy never stops the
 *    sweep from resolving the others.
 *  - Idempotent: a re-run with nothing resolvable does nothing (no writes, no
 *    Notice) — resolved copies are already gone, and skips stay skipped.
 *  - No self-retrigger: the note write lands OUTSIDE the reserved folder and the
 *    copy delete is the only reserved-folder mutation. The runtime trigger keys
 *    off conflict-copy WRITES, so a sweep's own delete can never re-schedule it.
 *
 * Pure DI: the sweep never touches Obsidian directly. `main.ts` binds the port
 * and the base accessors to the live vault + persisted sync state.
 */

import { mergeText } from '@havemind/sync-core';

import {
  listConflictCopies,
  type ConflictVaultPort,
} from './conflict-resolution';

/** A three-way merge over plain text (defaults to sync-core `mergeText`). */
export type ThreeWayMerge = (
  ancestor: string,
  mine: string,
  theirs: string,
) => { readonly status: 'merged'; readonly text: string } | { readonly status: 'conflict' };

export interface ConflictSweepDeps {
  /** Vault surface: enumerate copies + target notes, read/write/delete files. */
  readonly port: ConflictVaultPort;
  /** The fileId owning a target note path, or null when Havemind never synced it. */
  readonly fileIdAtPath: (path: string) => string | null;
  /** The durably persisted merge ancestor (base content) for a fileId, or null. */
  readonly baseContentFor: (fileId: string) => string | null;
  /** The persisted base content HASH for a fileId, used to verify the ancestor. */
  readonly baseHashFor: (fileId: string) => string | null;
  /** Content-addressed hash (same helper the apply path records the base with). */
  readonly hashContent: (content: string) => Promise<string>;
  /** Emit a single summarising message when at least one copy was auto-resolved. */
  readonly notify: (message: string) => void;
  /** Three-way merge; injectable for tests, defaults to sync-core `mergeText`. */
  readonly merge?: ThreeWayMerge;
}

/**
 * Runs one auto-repair pass over the reserved conflict folder. Returns the count
 * of copies fully merged into their target note (and therefore deleted). Only
 * fires `notify` when that count is greater than zero, so a no-op re-run is
 * silent (idempotence). Every per-copy step is isolated in a try/catch: a single
 * unreadable copy or failed write is swallowed for that copy only and the sweep
 * carries on, so one bad item can never wedge the rest.
 */
export async function sweepConflictCopies(
  deps: ConflictSweepDeps,
): Promise<number> {
  const merge = deps.merge ?? mergeText;
  let resolved = 0;

  for (const copy of listConflictCopies(deps.port)) {
    // Only new-format, markdown, uniquely-paired copies are auto-mergeable.
    // Legacy UUID names, binary copies and ambiguous/unknown targets are left
    // for the manual modal — never guessed at, never deleted.
    if (copy.kind === 'legacy' || copy.isBinary || !copy.targetKnown) continue;
    const targetPath = copy.targetPath;
    if (targetPath === null) continue;

    try {
      const fileId = deps.fileIdAtPath(targetPath);
      if (fileId === null) continue;

      // NEVER guess an ancestor: skip unless a base content is recorded AND it
      // still matches the recorded base hash (inconsistent state fails safe).
      const ancestor = deps.baseContentFor(fileId);
      if (ancestor === null) continue;
      const baseHash = deps.baseHashFor(fileId);
      if (baseHash === null || (await deps.hashContent(ancestor)) !== baseHash) {
        continue;
      }

      const [mine, theirs] = await Promise.all([
        deps.port.readText(targetPath),
        deps.port.readText(copy.copyPath),
      ]);
      // MINOR 6: a null read means the note or copy vanished mid-sweep; leave the
      // copy for the manual modal rather than merging against a missing side.
      if (mine === null || theirs === null) continue;

      const result = merge(ancestor, mine, theirs);
      if (result.status !== 'merged') continue;

      // Zero content loss: the copy's content is now fully represented by the
      // merged note, so writing the note THEN deleting the copy is safe. Order
      // matters — the delete only runs after a successful write.
      await deps.port.writeText(targetPath, result.text);
      await deps.port.deleteFile(copy.copyPath);
      resolved += 1;
    } catch {
      // Per-item isolation: this copy stays in place for the manual modal; the
      // sweep continues with the next one.
      continue;
    }
  }

  if (resolved > 0) {
    deps.notify(`Auto-resolved ${resolved} conflict(s)`);
  }
  return resolved;
}
