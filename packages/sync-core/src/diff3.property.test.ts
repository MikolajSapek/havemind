/**
 * Property-based battery for the three-way merge engine (MRG-01, `mergeText`).
 *
 * `mergeText` is the single most safety-critical piece of the client: on a
 * genuine on-disk divergence it decides whether two edits COMBINE or fall back
 * to a conflict copy. A silent mistake here means silent data loss (rule 3:
 * zero silent overwrites). These properties fuzz it with fast-check to assert
 * the guarantees the hand-written examples in `diff3.test.ts` can only spot
 * check:
 *
 *   (a) NO LINE LOSS, a one-sided edit round-trips verbatim.
 *   (b) COMBINE-ONLY, a successful merge only ever combines existing
 *                           lines; it never invents a line and never drops a
 *                           line either side added.
 *   (c) CONFLICT SOUNDNESS, two different edits to the SAME ancestor line can
 *                           never silently pick a winner; they must conflict.
 *   (d) DETERMINISM / IDENTITIES, same inputs → same output, plus the three
 *                           algebraic identities merge(A,X,X)=X, merge(A,A,R)=R,
 *                           merge(A,L,A)=L.
 *   (e) CANONICAL SAFETY, arbitrary trailing-newline / empty inputs never
 *                           throw, output stays LF-only and is a merge fixpoint.
 *
 * Generators are bounded (<= 40 lines; lines drawn from a small alphabet of
 * blanks, spaces, '#', '-' and a few short tokens) so line matches and hunk
 * overlaps happen densely, which is where the engine's edge cases live.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeText } from './diff3.js';

const RUNS = 500;

/**
 * A small alphabet of whole lines. Keeping the pool small (and including the
 * blank line, indented lines, heading and list markers required by the brief)
 * makes exact line matches, and therefore interesting LCS alignments and hunk
 * collisions, common rather than astronomically rare.
 */
const LINE_POOL = [
  '',
  ' ',
  '  ',
  '#',
  '# h',
  '## h',
  '- a',
  '- b',
  '-',
  'a',
  'b',
  'c',
  'foo',
  'bar',
] as const;

/** Two tokens guaranteed NOT to appear in any generated ancestor. */
const FRESH_LOCAL = 'FRESH_LOCAL_ONLY';
const FRESH_REMOTE = 'FRESH_REMOTE_ONLY';

const lineArb = fc.constantFrom(...LINE_POOL);

/**
 * A canonical document: an array of lines joined with '\n'. The empty array and
 * a `['']` both render to '' (a single empty line under `split('\n')`); a
 * trailing `''` element renders the canonical trailing newline. This is exactly
 * the shape `mergeText` round-trips, so a generated `text` is already canonical.
 */
const linesArb = fc.array(lineArb, { maxLength: 40 });
const textArb = linesArb.map((lines) => lines.join('\n'));

/** Distinct-line ancestor (>= 1 line) so an LCS alignment is unambiguous. */
const distinctLinesArb = fc.uniqueArray(lineArb, {
  minLength: 1,
  maxLength: LINE_POOL.length,
});

function toSet(text: string): Set<string> {
  return new Set(text.split('\n'));
}

describe('mergeText property battery (fast-check)', () => {
  it('(a) NO LINE LOSS: a one-sided edit round-trips verbatim', () => {
    // remote == ancestor ⇒ only local changed ⇒ the merge must reconstruct
    // LOCAL exactly (and symmetrically for a remote-only edit). This holds for
    // ANY local/remote text, not just edits derived from the ancestor, which is
    // the strongest possible statement of "one side's change is never lost".
    fc.assert(
      fc.property(textArb, textArb, (ancestor, side) => {
        const localOnly = mergeText(ancestor, side, ancestor);
        expect(localOnly.status).toBe('merged');
        if (localOnly.status === 'merged') expect(localOnly.text).toBe(side);

        const remoteOnly = mergeText(ancestor, ancestor, side);
        expect(remoteOnly.status).toBe('merged');
        if (remoteOnly.status === 'merged') expect(remoteOnly.text).toBe(side);
      }),
      { numRuns: RUNS },
    );
  });

  it('(b) COMBINE-ONLY: a merge invents no line and drops neither side’s additions', () => {
    fc.assert(
      fc.property(textArb, textArb, textArb, (ancestor, local, remote) => {
        const result = mergeText(ancestor, local, remote);
        if (result.status !== 'merged') return; // only constrains successes

        const mergedSet = toSet(result.text);
        const ancestorSet = toSet(ancestor);
        const localSet = toSet(local);
        const remoteSet = toSet(remote);
        const union = new Set([...localSet, ...remoteSet]);

        // No invented lines: every merged line came from one side.
        for (const line of mergedSet) {
          expect(union.has(line)).toBe(true);
        }
        // Every line ADDED by local (present in local, absent from ancestor)
        // survives the merge, likewise for remote.
        for (const line of localSet) {
          if (!ancestorSet.has(line)) expect(mergedSet.has(line)).toBe(true);
        }
        for (const line of remoteSet) {
          if (!ancestorSet.has(line)) expect(mergedSet.has(line)).toBe(true);
        }
        // Every line both sides KEPT (present in ancestor, local and remote)
        // survives: a shared line is never collateral damage of a merge.
        for (const line of ancestorSet) {
          if (localSet.has(line) && remoteSet.has(line)) {
            expect(mergedSet.has(line)).toBe(true);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('(c) CONFLICT SOUNDNESS: two different edits to the same ancestor line conflict', () => {
    fc.assert(
      fc.property(
        distinctLinesArb.chain((lines) =>
          fc.record({
            lines: fc.constant(lines),
            index: fc.nat({ max: lines.length - 1 }),
          }),
        ),
        ({ lines, index }) => {
          const ancestor = lines.join('\n');
          const local = lines.map((l, i) => (i === index ? FRESH_LOCAL : l));
          const remote = lines.map((l, i) => (i === index ? FRESH_REMOTE : l));
          // Both sides replace the SAME line with a NOVEL, distinct value. A
          // silent pick would be data loss; the engine must fail to a conflict.
          const result = mergeText(
            ancestor,
            local.join('\n'),
            remote.join('\n'),
          );
          expect(result.status).toBe('conflict');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('(d) DETERMINISM: identical inputs yield an identical result', () => {
    fc.assert(
      fc.property(textArb, textArb, textArb, (ancestor, local, remote) => {
        const first = mergeText(ancestor, local, remote);
        const second = mergeText(ancestor, local, remote);
        expect(second).toEqual(first);
      }),
      { numRuns: RUNS },
    );
  });

  it('(d) IDENTITIES: merge(A,X,X)=X, merge(A,A,R)=R, merge(A,L,A)=L', () => {
    fc.assert(
      fc.property(textArb, textArb, (ancestor, x) => {
        // Both sides made the identical change ⇒ collapses to that one change.
        const both = mergeText(ancestor, x, x);
        expect(both.status).toBe('merged');
        if (both.status === 'merged') expect(both.text).toBe(x);

        // Local untouched ⇒ take remote verbatim; remote untouched ⇒ take local.
        const remote = mergeText(ancestor, ancestor, x);
        expect(remote.status).toBe('merged');
        if (remote.status === 'merged') expect(remote.text).toBe(x);

        const local = mergeText(ancestor, x, ancestor);
        expect(local.status).toBe('merged');
        if (local.status === 'merged') expect(local.text).toBe(x);
      }),
      { numRuns: RUNS },
    );
  });

  it('(e) CANONICAL SAFETY: arbitrary trailing-newline/empty inputs never throw and stay LF-only', () => {
    // Raw strings, including empty, only-newlines and mixed trailing newlines,
    // exercising the "callers pass canonicalised LF" contract at its edges.
    const rawTextArb = fc.oneof(
      textArb,
      fc.constantFrom('', '\n', '\n\n', 'a', 'a\n', 'a\n\n', '\na', '  \n  '),
      fc.string({ unit: fc.constantFrom('a', 'b', '\n', ' ', '#'), maxLength: 20 }),
    );
    fc.assert(
      fc.property(rawTextArb, rawTextArb, rawTextArb, (ancestor, local, remote) => {
        const result = mergeText(ancestor, local, remote);
        if (result.status !== 'merged') return;
        // Output is LF-only (never introduces a CR) ...
        expect(result.text.includes('\r')).toBe(false);
        // ... and is a merge fixpoint: re-merging a settled text is a no-op,
        // which is the canonical-form guarantee the apply path relies on to
        // avoid re-pushing its own merge result.
        const again = mergeText(result.text, result.text, result.text);
        expect(again.status).toBe('merged');
        if (again.status === 'merged') expect(again.text).toBe(result.text);
      }),
      { numRuns: RUNS },
    );
  });
});
