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
 * a 2026-07 survey of how other sync apps handle conflicts). It only ever COMBINES text; it can never drop
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
      // Both sides touched this span. Before failing, check whether they
      // touched DIFFERENT ancestor lines within it: two people editing
      // neighbouring rows of a table, or a heading and the paragraph under it,
      // is the commonest shape of a shared vault, and the outcome is not
      // ambiguous when no single line was changed twice. Only a line claimed by
      // both sides is a genuine conflict.
      const disjoint = mergeDisjointRegion(
        o,
        localHunks,
        remoteHunks,
        a,
        b,
        regionStart,
        regionEnd,
      );
      if (disjoint === null) {
        return { status: 'conflict' };
      }
      merged.push(...disjoint);
    }

    oCursor = regionEnd;
  }

  for (let line = oCursor; line < o.length; line += 1) {
    merged.push(o[line] as string);
  }

  return { status: 'merged', text: merged.join('\n') };
}

/**
 * Rebuilds a region that BOTH sides touched, but on disjoint ancestor lines.
 *
 * The grouping loop folds changes that sit within `adjacency` unchanged lines
 * into one region, so two people editing neighbouring lines land in the same
 * span even though neither overwrote the other. Walking the span line by line
 * and asking which side owns each one recovers the unambiguous result; a line
 * claimed by both sides returns null, and the caller falls back to a conflict
 * copy exactly as before.
 *
 * Returns the merged lines, or null when the region is a genuine conflict.
 */
function mergeDisjointRegion(
  o: readonly string[],
  localHunks: readonly Hunk[],
  remoteHunks: readonly Hunk[],
  a: readonly string[],
  b: readonly string[],
  regionStart: number,
  regionEnd: number,
): string[] | null {
  // This path recovers only the unambiguous shape: every hunk in the region
  // REPLACES ancestor lines one for one, and no ancestor line is claimed by
  // both sides. Anything else (an insertion, a deletion, a hunk that changes
  // the line count) cannot be reassembled from line ownership alone, and a
  // property test proved the attempt silently dropped lines: ancestor "\n",
  // local "\na", remote "#" lost "a". Those regions go back to the caller as
  // conflicts, where both versions survive.
  const inRegion = (hunk: Hunk): boolean =>
    hunk.oStart < regionEnd && hunk.oStart + hunk.oLength > regionStart;
  const balanced = (hunks: readonly Hunk[]): boolean =>
    hunks.filter(inRegion).every(
      (hunk) =>
        // One ancestor line in, one replacement line out, so the walk below can
        // attribute each line to exactly one side.
        hunk.oLength > 0 &&
        hunk.oLength === hunk.abLength &&
        // Wholly inside the region. A hunk that straddles the boundary has part
        // of its replacement outside the span this function rebuilds, and that
        // part would simply vanish (CI counterexample: ancestor "b\n", local
        // "# h\n- a", remote "b\nfoo" lost "foo").
        hunk.oStart >= regionStart &&
        hunk.oStart + hunk.oLength <= regionEnd,
    );
  if (!balanced(localHunks) || !balanced(remoteHunks)) {
    return null;
  }
  // A pure insertion is anchored between lines, so it never satisfies the
  // check above; guard it explicitly too, since `inRegion` skips zero-width
  // hunks entirely.
  if (
    insertionsIn(localHunks, regionStart, regionEnd).length > 0 ||
    insertionsIn(remoteHunks, regionStart, regionEnd).length > 0
  ) {
    return null;
  }

  const out: string[] = [];
  let line = regionStart;
  while (line < regionEnd) {
    const local = hunkCovering(localHunks, line);
    const remote = hunkCovering(remoteHunks, line);
    if (local !== undefined && remote !== undefined) {
      // One ancestor line rewritten by both sides: the case a human must settle.
      return null;
    }
    // A DELETION next to an opposite-side edit is not safe to auto-resolve.
    // Combining them silently drops a line the other person was still working
    // around, and no rule can tell whether they meant to keep it. Deleting is
    // the one edit whose intent cannot be recovered from the text, so it falls
    // back to a conflict copy where both versions survive.
    const own = (local ?? remote) as Hunk;
    // The opposite side must not touch ANY line this hunk spans, not just the
    // line the walk is standing on. A multi-line hunk that overlaps a
    // single-line change on its second line used to pass this check and then
    // skip past it, dropping the other side's text (CI counterexample:
    // ancestor "b\n", local "# h\n- a", remote "b\nfoo" lost "foo").
    if (
      regionHasOppositeChange(
        local !== undefined ? remoteHunks : localHunks,
        own.oStart,
        own.oStart + own.oLength,
      )
    ) {
      return null;
    }
    if (own.abLength === 0) {
      return null;
    }
    if (local === undefined && remote === undefined) {
      out.push(o[line] as string);
      line += 1;
      continue;
    }
    const hunk = (local ?? remote) as Hunk;
    const source = local !== undefined ? a : b;
    // Emit the hunk's replacement once, when the walk reaches its first line
    // inside the region. A hunk grouped in from the left starts earlier, and its
    // replacement was already emitted, so skip it and just advance past it.
    if (hunk.oStart >= line) {
      for (let k = 0; k < hunk.abLength; k += 1) {
        out.push(source[hunk.abStart + k] as string);
      }
    }
    line = hunk.oStart + hunk.oLength;
  }
  return out;
}

/** Zero-width hunks (pure insertions) anchored inside the region. */
function insertionsIn(
  hunks: readonly Hunk[],
  regionStart: number,
  regionEnd: number,
): readonly Hunk[] {
  return hunks.filter(
    (hunk) =>
      hunk.oLength === 0 &&
      hunk.oStart >= regionStart &&
      hunk.oStart <= regionEnd,
  );
}

/** The hunk whose ancestor span covers `line`, if any. */
function hunkCovering(
  hunks: readonly Hunk[],
  line: number,
): Hunk | undefined {
  return hunks.find(
    (hunk) => line >= hunk.oStart && line < hunk.oStart + hunk.oLength,
  );
}

/** Whether the other side changed anything inside the region at all. */
function regionHasOppositeChange(
  hunks: readonly Hunk[],
  regionStart: number,
  regionEnd: number,
): boolean {
  return hunks.some(
    (hunk) =>
      hunk.oStart < regionEnd && hunk.oStart + hunk.oLength > regionStart,
  );
}
