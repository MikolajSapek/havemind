/**
 * Line-level three-way merge (diff3) for markdown notes (MRG-01).
 *
 * Havemind's apply side, on a genuine on-disk divergence, FIRST attempts to
 * combine both sides with this merge before falling back to a conflict copy.
 * The engine is intentionally small, dependency-free and conservative:
 *
 *  - it diffs ANCESTOR→LOCAL and ANCESTOR→REMOTE at the line level using a plain
 *    LCS, producing per-side change hunks over the ancestor's line indices;
 *  - it walks the union of both sides' hunks and groups any that overlap or are
 *    adjacent within `adjacencyLines` (default 1 = touching or overlapping) into
 *    a single region;
 *  - a region touched by only one side is applied; a region where both sides
 *    made the IDENTICAL change collapses to that single change; ANY region where
 *    both sides changed the same span differently (or two changes touch/overlap)
 *    fails the WHOLE merge.
 *
 * On any failure the caller writes a conflict copy, this engine never
 * auto-resolves an overlapping hunk (the prose-degradation caveat from
 * `docs/research-conflicts.md`). It only ever COMBINES text; it can never drop
 * either side's change (zero-silent-overwrite, rule 3): a span only one side
 * touched is taken verbatim, and any contested span fails to a conflict copy.
 *
 * Lines are split on `\n` and re-joined on `\n`, which round-trips canonical
 * (LF, no CRLF) content exactly, including a trailing newline, which appears as
 * a trailing empty line element. Callers pass already-canonicalised text.
 */

/** The outcome of a three-way merge attempt. */
export type Diff3MergeResult =
  | { readonly status: 'merged'; readonly text: string }
  | { readonly status: 'conflict' };

export interface Diff3Options {
  /**
   * Minimum number of unchanged ancestor lines that must separate two
   * opposite-side changes for them to merge independently. `1` (the default,
   * conservative choice) means changes that touch or overlap (zero unchanged
   * lines between them) fail to a conflict; at least one untouched line is
   * required between independent edits.
   */
  readonly adjacencyLines?: number;
  /**
   * Safety ceiling on the product of the line counts the O(n·m) LCS visits.
   * Beyond it the merge fails SAFE (conflict copy) rather than allocating an
   * enormous DP table. Notes never approach this; a pathological input does.
   */
  readonly maxLcsCells?: number;
}

const DEFAULT_ADJACENCY_LINES = 1;
const DEFAULT_MAX_LCS_CELLS = 4_000_000;

/** A per-side change region over the ancestor's line indices. */
interface Hunk {
  /** First ancestor line index the change covers. */
  readonly oStart: number;
  /** Number of ancestor lines the change replaces (0 for a pure insertion). */
  readonly oLength: number;
  /** First index of the replacement lines in the variant (local/remote). */
  readonly abStart: number;
  /** Number of replacement lines in the variant (0 for a pure deletion). */
  readonly abLength: number;
}

type Side = 'local' | 'remote';

interface SidedHunk extends Hunk {
  readonly side: Side;
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * Longest common subsequence of two line arrays, returned as the matched index
 * pairs in increasing order. Standard O(n·m) DP; sufficient for note-sized
 * inputs and guarded by `maxLcsCells` for anything pathological.
 */
function lcsMatches(
  x: readonly string[],
  y: readonly string[],
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const n = x.length;
  const m = y.length;
  const width = m + 1;
  // Flat Int32 table indexed [i * width + j]; length (n+1)*(m+1).
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        x[i] === y[j]
          ? (table[(i + 1) * width + (j + 1)] as number) + 1
          : Math.max(
              table[(i + 1) * width + j] as number,
              table[i * width + (j + 1)] as number,
            );
    }
  }

  const matches: Array<{ x: number; y: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      matches.push({ x: i, y: j });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] as number) >=
      (table[i * width + (j + 1)] as number)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

/** Change hunks aligning `variant` to `ancestor`, derived from their LCS. */
function diffHunks(
  ancestor: readonly string[],
  variant: readonly string[],
): Hunk[] {
  const matches = lcsMatches(ancestor, variant);
  const hunks: Hunk[] = [];
  let oCursor = 0;
  let vCursor = 0;
  const boundaries = [...matches, { x: ancestor.length, y: variant.length }];
  for (const match of boundaries) {
    const oLength = match.x - oCursor;
    const abLength = match.y - vCursor;
    if (oLength > 0 || abLength > 0) {
      hunks.push({ oStart: oCursor, oLength, abStart: vCursor, abLength });
    }
    oCursor = match.x + 1;
    vCursor = match.y + 1;
  }
  return hunks;
}

/**
 * Variant line index at the START boundary of an ancestor cut `p`: it counts
 * every hunk that ends at or before `p` EXCEPT a pure insertion sitting exactly
 * at `p` (that insertion belongs to the region starting here, so its lines fall
 * inside the extracted segment).
 */
function variantStart(hunks: readonly Hunk[], p: number): number {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oStart + hunk.oLength <= p && hunk.oStart < p) {
      delta += hunk.abLength - hunk.oLength;
    }
  }
  return p + delta;
}

/**
 * Variant line index at the END boundary of an ancestor cut `p`: it counts every
 * hunk that ends at or before `p`, INCLUDING a pure insertion at exactly `p`, so
 * that insertion's lines are captured by the segment ending here.
 */
function variantEnd(hunks: readonly Hunk[], p: number): number {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oStart + hunk.oLength <= p) {
      delta += hunk.abLength - hunk.oLength;
    }
  }
  return p + delta;
}

/** The variant's lines for the ancestor range `[oStart, oEnd)`. */
function segmentFor(
  hunks: readonly Hunk[],
  variant: readonly string[],
  oStart: number,
  oEnd: number,
): string[] {
  return variant.slice(variantStart(hunks, oStart), variantEnd(hunks, oEnd));
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Three-way line merge. Returns the combined text on success, or a conflict
 * signal the caller turns into a conflict copy.
 */
export function mergeText(
  ancestor: string,
  local: string,
  remote: string,
  options: Diff3Options = {},
): Diff3MergeResult {
  const adjacency = options.adjacencyLines ?? DEFAULT_ADJACENCY_LINES;
  const maxCells = options.maxLcsCells ?? DEFAULT_MAX_LCS_CELLS;

  const o = splitLines(ancestor);
  const a = splitLines(local);
  const b = splitLines(remote);

  // Fail SAFE on pathologically large inputs rather than allocating a huge table.
  if (
    (o.length + 1) * (a.length + 1) > maxCells ||
    (o.length + 1) * (b.length + 1) > maxCells
  ) {
    return { status: 'conflict' };
  }

  const localHunks = diffHunks(o, a);
  const remoteHunks = diffHunks(o, b);

  const events: SidedHunk[] = [
    ...localHunks.map((hunk) => ({ ...hunk, side: 'local' as const })),
    ...remoteHunks.map((hunk) => ({ ...hunk, side: 'remote' as const })),
  ].sort(
    (left, right) =>
      left.oStart - right.oStart ||
      (left.side === right.side ? 0 : left.side === 'local' ? -1 : 1),
  );

  const merged: string[] = [];
  let oCursor = 0;
  let index = 0;

  while (index < events.length) {
    const first = events[index];
    if (first === undefined) break;

    // Copy the untouched ancestor lines leading up to this region.
    for (let line = oCursor; line < first.oStart; line += 1) {
      merged.push(o[line] as string);
    }

    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLength;
    const sides = new Set<Side>([first.side]);
    index += 1;

    // Group any following change that overlaps or sits within `adjacency`
    // unchanged lines of the region so far.
    while (index < events.length) {
      const next = events[index];
      if (next === undefined) break;
      if (next.oStart - regionEnd >= adjacency) break;
      regionEnd = Math.max(regionEnd, next.oStart + next.oLength);
      sides.add(next.side);
      index += 1;
    }

    const localSegment = segmentFor(localHunks, a, regionStart, regionEnd);
    const remoteSegment = segmentFor(remoteHunks, b, regionStart, regionEnd);
    const ancestorSegment = o.slice(regionStart, regionEnd);

    if (!sides.has('remote') || linesEqual(remoteSegment, ancestorSegment)) {
      // Only local changed this span (or remote left it at the ancestor).
      merged.push(...localSegment);
    } else if (!sides.has('local') || linesEqual(localSegment, ancestorSegment)) {
      // Only remote changed this span.
      merged.push(...remoteSegment);
    } else if (linesEqual(localSegment, remoteSegment)) {
      // Both sides made the identical change: collapse to one copy.
      merged.push(...localSegment);
    } else {
      // Both sides changed the same span differently, or two changes touch:
      // never auto-resolve, fail the whole merge to a conflict copy.
      return { status: 'conflict' };
    }

    oCursor = regionEnd;
  }

  for (let line = oCursor; line < o.length; line += 1) {
    merged.push(o[line] as string);
  }

  return { status: 'merged', text: merged.join('\n') };
}
