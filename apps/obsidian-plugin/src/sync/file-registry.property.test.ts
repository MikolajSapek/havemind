/**
 * The registry's invariants must survive ANY sequence of events, not just the
 * ones someone thought to write a test for.
 *
 * Every sync failure in this project's history has been a state pair drifting
 * apart under an interleaving nobody enumerated: the merge ancestor against its
 * hash, a path against its owner, a producer mapping against an apply-side base.
 * Example-based tests cover the sequences we imagined; this covers the ones we
 * did not, by generating random event streams and asserting the invariants hold
 * after every single step.
 *
 * If one of these ever fails, the counterexample printed by fast-check is the
 * exact sequence to paste into a regression test.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FileRegistry, type FileEvent } from './file-registry';

/** Hashing is modelled, not real: the invariant is agreement, not SHA-256. */
const hashOf = (content: string | null): string =>
  content === null ? 'null' : `hash:${content}`;

type Step =
  | { readonly kind: 'authored'; readonly event: FileEvent }
  | { readonly kind: 'agreed'; readonly event: FileEvent }
  | { readonly kind: 'removed'; readonly fileId: string };

/** A small, deliberately colliding world: few ids and paths, so the generator
 *  produces renames, hand-overs and resurrections constantly. */
const fileIdArb = fc.constantFrom('f1', 'f2', 'f3');
const pathArb = fc.constantFrom('A.md', 'B.md', 'C.md');
const contentArb = fc.constantFrom('v1', 'v2', 'v3');

const eventArb: fc.Arbitrary<FileEvent> = fc
  .record({
    fileId: fileIdArb,
    path: pathArb,
    content: contentArb,
    headRevisionId: fc.constantFrom('r1', 'r2', 'r3'),
  })
  .map(({ fileId, path, content, headRevisionId }) => ({
    fileId,
    path,
    collisionKey: path.toLowerCase(),
    content,
    contentHash: hashOf(content),
    headRevisionId,
  }));

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  eventArb.map((event) => ({ kind: 'authored' as const, event })),
  eventArb.map((event) => ({ kind: 'agreed' as const, event })),
  fileIdArb.map((fileId) => ({ kind: 'removed' as const, fileId })),
);

/** Every invariant the rest of the sync code relies on, checked at once. */
function assertInvariants(files: FileRegistry): void {
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();

  for (const record of files.all()) {
    // 1. The merge ancestor and its hash are one fact. When these disagreed,
    //    `tryMergeApply` could never satisfy its precondition and every
    //    divergence degraded into a conflict copy.
    if (record.agreedContent !== null || record.agreedHash !== null) {
      expect(record.agreedHash).toBe(hashOf(record.agreedContent));
    }

    // 2. Exactly one record owns a path, and one a collision key. Two owners
    //    meant a phantom file resurfacing after a rename or hand-over.
    expect(seenPaths.has(record.path)).toBe(false);
    expect(seenKeys.has(record.collisionKey)).toBe(false);
    seenPaths.add(record.path);
    seenKeys.add(record.collisionKey);

    // 3. Every index resolves back to the same record. A stale index entry is
    //    how a deleted file kept being found by path.
    expect(files.byPath(record.path)?.fileId).toBe(record.fileId);
    expect(files.byCollisionKey(record.collisionKey)?.fileId).toBe(record.fileId);
    expect(files.byFileId(record.fileId)).toBe(record);

    // 4. The local view is always populated: a record with no content is the
    //    half-written state that used to produce empty phantom pushes.
    expect(record.localHash).toBe(hashOf(record.localContent));
  }
}

function apply(files: FileRegistry, step: Step): void {
  if (step.kind === 'authored') files.authoredLocally(step.event);
  else if (step.kind === 'agreed') files.agreedWithPeer(step.event);
  else files.removed(step.fileId);
}

describe('FileRegistry invariants under arbitrary event sequences', () => {
  it('holds after every step of any sequence', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        const files = new FileRegistry();
        for (const step of steps) {
          apply(files, step);
          assertInvariants(files);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('survives a persistence round-trip at any point', () => {
    // Restart is where half-written state used to surface: the blob is reloaded
    // and whatever disagreed on disk now disagrees in memory.
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const files = new FileRegistry();
        for (const step of steps) apply(files, step);

        const restored = new FileRegistry(files.toJSON());
        assertInvariants(restored);
        expect(restored.toJSON()).toEqual(files.toJSON());
      }),
      { numRuns: 200 },
    );
  });

  it('never advances the agreed state on a purely local edit', () => {
    // The silent-overwrite guard: if a local write moved the agreed state, a
    // concurrent peer revision built on an older head would arrive with
    // on-disk == agreed and be misread as a clean fast-forward.
    fc.assert(
      fc.property(
        eventArb,
        contentArb,
        fc.constantFrom('r9', 'r10'),
        (first, laterContent, laterHead) => {
          const files = new FileRegistry();
          files.agreedWithPeer(first);
          const agreedBefore = files.byFileId(first.fileId)?.agreedContent;

          files.authoredLocally({
            ...first,
            content: laterContent,
            contentHash: hashOf(laterContent),
            headRevisionId: laterHead,
          });

          const after = files.byFileId(first.fileId);
          expect(after?.agreedContent).toBe(agreedBefore);
          // The local view and the head DO move: that is what a local edit is.
          expect(after?.localContent).toBe(laterContent);
          expect(after?.headRevisionId).toBe(laterHead);
        },
      ),
      { numRuns: 200 },
    );
  });
});
