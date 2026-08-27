/**
 * Havemind author overlay: pure attribution decoration model.
 *
 * This module implements the logic behind the author overlay described in
 * `plan/06-plugin-activity-i-overlay.md` (issue F6-01 / T029). It consumes the
 * provenance runs produced by `@havemind/sync-core` and the Activity surface
 * (F5-01) and turns them into visual decoration descriptors for the two editor
 * surfaces (Live Preview inline segments and Reading-view block markers).
 *
 * It never talks to Obsidian, the DOM or the network, so the accessibility and
 * "never guess" guarantees can be exercised deterministically in isolation.
 *
 * Hard rules enforced here (see `plan/01-zasady-i-slownik.md` and the anti-spec
 * in `plan/06`):
 *  - Colour is NEVER the only signal: every emitted decoration carries an
 *    underline plus a non-empty tooltip and aria-label alongside its colour
 *    token, and the legend maps tokens to author labels (anti-spec S5).
 *  - Never guess attribution. If the local document hash no longer matches the
 *    head revision, if provenance does not cover the document byte-for-byte, or
 *    if a provenance source cannot be resolved to an author, the whole overlay
 *    is hidden rather than showing a partial or false signal (rule 4).
 *  - Reading view stays silent for any block whose section `getSectionInfo()`
 *    did not resolve, no marker at all, never a guessed range (anti-spec S5).
 *  - Reduced motion removes the highlight animation only; the static colour and
 *    underline are shown immediately.
 *  - Colours live purely in the editor layer as CSS custom-property tokens and
 *    are never written back into note content (anti-spec S5).
 */

import { provenanceLength, type ProvenanceRun } from '@havemind/sync-core';

import {
  AUTHOR_COLOR_TOKENS,
  authorColorToken,
  INITIAL_IMPORT_COLOR_TOKEN,
  INITIAL_IMPORT_LABEL,
} from '../runtime/author-colors';

// Re-exported so existing overlay consumers keep importing these from here. The
// palette and the stable memberId→colour assignment live in `author-colors` so
// the roster, the Activity log and this overlay all draw the same person in the
// same colour (colour is always paired with the author's name/label).
export {
  AUTHOR_COLOR_TOKENS,
  INITIAL_IMPORT_COLOR_TOKEN,
  INITIAL_IMPORT_LABEL,
};

export type OverlayActor =
  | {
      readonly kind: 'author';
      readonly actorId: string;
      readonly displayName: string;
    }
  | { readonly kind: 'initial-import' };

/** Attribution facts for one source revision, resolved from Activity history. */
export interface RevisionAuthorInfo {
  readonly actor: OverlayActor;
  readonly timestamp: number;
}

export interface OverlayInput {
  /** Whether the "Show authors" toggle is on for this local vault. */
  readonly enabled: boolean;
  /** The document exactly as the client currently sees it. */
  readonly content: string;
  /** Hash of `content` under the client canonicalisation. */
  readonly contentHash: string;
  /** Expected blob hash of the current head revision for this document. */
  readonly headBlobHash: string;
  /** Provenance runs covering the head revision, newest merge applied. */
  readonly provenance: readonly ProvenanceRun[];
  /** Resolver from a provenance `sourceRevisionId` to its author facts. */
  readonly authors: ReadonlyMap<string, RevisionAuthorInfo>;
  /** When true, highlight animations are suppressed (static colour + underline). */
  readonly reducedMotion: boolean;
  /** Formats a revision timestamp for tooltips; defaults to ISO-8601. */
  readonly formatTimestamp?: (timestamp: number) => string;
}

/** A resolved author reference attached to a decoration. */
export interface AttributionAuthorRef {
  readonly kind: 'author' | 'initial-import';
  readonly actorId: string | null;
  readonly displayName: string;
  readonly timestamp: number;
  readonly colorToken: string;
}

/** One inline decoration for the Live Preview (CodeMirror) surface. */
export interface AttributionSegment {
  readonly from: number;
  readonly to: number;
  readonly colorToken: string;
  /** Always true, colour is never the only signal. */
  readonly underline: true;
  /** Hover tooltip: author name + revision time, or the import label. */
  readonly tooltip: string;
  /** Keyboard-accessible equivalent of the tooltip (Live Preview focus). */
  readonly ariaLabel: string;
  /** False under reduced motion; underline is unconditional either way. */
  readonly animate: boolean;
  readonly author: AttributionAuthorRef;
}

export interface LegendEntry {
  readonly colorToken: string;
  readonly label: string;
}

export type OverlayHiddenReason =
  | 'overlay-disabled'
  | 'hash-mismatch'
  | 'provenance-content-mismatch'
  | 'unresolved-source';

export interface LivePreviewOverlay {
  readonly visible: boolean;
  readonly hiddenReason: OverlayHiddenReason | null;
  readonly segments: readonly AttributionSegment[];
  readonly legend: readonly LegendEntry[];
}

/** Block-level section info as returned by Obsidian's `getSectionInfo()`. */
export interface SectionInfo {
  /** 0-based inclusive first line of the block. */
  readonly lineStart: number;
  /** 0-based inclusive last line of the block. */
  readonly lineEnd: number;
}

/**
 * A rendered Reading-view block. `section` is `null` when `getSectionInfo()`
 * did not resolve a mapping, the overlay stays silent for such blocks.
 */
export interface ReadingBlock {
  readonly blockId: string;
  readonly section: SectionInfo | null;
}

/** One block-level marker for the Reading view (never character-level). */
export interface ReadingMarker {
  readonly blockId: string;
  readonly colorToken: string;
  readonly underline: true;
  readonly tooltip: string;
  readonly ariaLabel: string;
  readonly animate: boolean;
  /** Every author contributing to the block, in document order. */
  readonly authors: readonly AttributionAuthorRef[];
}

export interface ReadingViewOverlay {
  readonly visible: boolean;
  readonly hiddenReason: OverlayHiddenReason | null;
  readonly markers: readonly ReadingMarker[];
  readonly legend: readonly LegendEntry[];
}

/** A provenance run resolved to a concrete author and character range. */
interface ResolvedRun {
  readonly from: number;
  readonly to: number;
  readonly author: AttributionAuthorRef;
}

interface PreparedOverlay {
  readonly runs: readonly ResolvedRun[];
  readonly legend: readonly LegendEntry[];
}

function defaultFormatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Assigns each human author a deterministic, stable colour token via the shared
 * `authorColorToken` (a stable hash of the actorId onto the palette). "Stable"
 * means an author keeps the same colour regardless of which other authors are
 * present, so the overlay, roster and Activity log always agree. The import
 * source always gets its reserved neutral token.
 */
function assignColorTokens(
  authors: ReadonlyMap<string, RevisionAuthorInfo>,
  presentSources: ReadonlySet<string>,
): Map<string, string> {
  const tokenByActorId = new Map<string, string>();
  for (const sourceId of presentSources) {
    const info = authors.get(sourceId);
    if (info?.actor.kind === 'author') {
      tokenByActorId.set(
        info.actor.actorId,
        authorColorToken(info.actor.actorId),
      );
    }
  }
  return tokenByActorId;
}

function tooltipFor(author: AttributionAuthorRef, format: (ts: number) => string): string {
  return author.kind === 'initial-import'
    ? INITIAL_IMPORT_LABEL
    : `${author.displayName} · ${format(author.timestamp)}`;
}

/**
 * Validates the "never guess" preconditions and resolves every provenance run
 * to a concrete author with a character range. Returns a hidden reason instead
 * of runs when the overlay must not render.
 */
function prepareOverlay(input: OverlayInput): PreparedOverlay | OverlayHiddenReason {
  if (!input.enabled) {
    return 'overlay-disabled';
  }
  if (input.contentHash !== input.headBlobHash) {
    return 'hash-mismatch';
  }
  if (provenanceLength(input.provenance) !== input.content.length) {
    return 'provenance-content-mismatch';
  }

  const presentSources = new Set(
    input.provenance.map((run) => run.sourceRevisionId),
  );
  for (const sourceId of presentSources) {
    if (!input.authors.has(sourceId)) {
      return 'unresolved-source';
    }
  }

  const tokenByActorId = assignColorTokens(input.authors, presentSources);

  const runs: ResolvedRun[] = [];
  let offset = 0;
  for (const run of input.provenance) {
    const info = input.authors.get(run.sourceRevisionId);
    // `presentSources` guaranteed resolvability above; keep TS happy.
    if (info === undefined) {
      return 'unresolved-source';
    }
    const author = resolveAuthor(info, tokenByActorId);
    runs.push({ from: offset, to: offset + run.length, author });
    offset += run.length;
  }

  return { runs, legend: buildLegend(runs) };
}

function resolveAuthor(
  info: RevisionAuthorInfo,
  tokenByActorId: ReadonlyMap<string, string>,
): AttributionAuthorRef {
  if (info.actor.kind === 'initial-import') {
    return {
      kind: 'initial-import',
      actorId: null,
      displayName: INITIAL_IMPORT_LABEL,
      timestamp: info.timestamp,
      colorToken: INITIAL_IMPORT_COLOR_TOKEN,
    };
  }
  return {
    kind: 'author',
    actorId: info.actor.actorId,
    displayName: info.actor.displayName,
    timestamp: info.timestamp,
    colorToken:
      tokenByActorId.get(info.actor.actorId) ??
      authorColorToken(info.actor.actorId),
  };
}

/** Legend entries in the order authors first appear in the document. */
function buildLegend(runs: readonly ResolvedRun[]): LegendEntry[] {
  const legend: LegendEntry[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const key = run.author.colorToken + '|' + run.author.displayName;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    legend.push({
      colorToken: run.author.colorToken,
      label: run.author.displayName,
    });
  }
  return legend;
}

export function buildLivePreviewOverlay(input: OverlayInput): LivePreviewOverlay {
  const prepared = prepareOverlay(input);
  if (typeof prepared === 'string') {
    return { visible: false, hiddenReason: prepared, segments: [], legend: [] };
  }

  const format = input.formatTimestamp ?? defaultFormatTimestamp;
  const segments = prepared.runs.map((run): AttributionSegment => {
    const tooltip = tooltipFor(run.author, format);
    return {
      from: run.from,
      to: run.to,
      colorToken: run.author.colorToken,
      underline: true,
      tooltip,
      ariaLabel: tooltip,
      animate: !input.reducedMotion,
      author: run.author,
    };
  });

  return {
    visible: true,
    hiddenReason: null,
    segments,
    legend: prepared.legend,
  };
}

/**
 * Maps each content line to its `[start, end)` character range, where `end`
 * includes the trailing newline when present.
 */
function computeLineRanges(content: string): Array<{ start: number; end: number }> {
  const parts = content.split('\n');
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  parts.forEach((part, index) => {
    const hasNewline = index < parts.length - 1;
    const start = offset;
    const end = start + part.length + (hasNewline ? 1 : 0);
    ranges.push({ start, end });
    offset = end;
  });
  return ranges;
}

function blockCharRange(
  section: SectionInfo,
  lineRanges: ReadonlyArray<{ start: number; end: number }>,
): { start: number; end: number } | null {
  const first = lineRanges[section.lineStart];
  const last = lineRanges[section.lineEnd];
  if (first === undefined || last === undefined || section.lineEnd < section.lineStart) {
    return null;
  }
  return { start: first.start, end: last.end };
}

export function buildReadingViewOverlay(
  input: OverlayInput,
  blocks: readonly ReadingBlock[],
): ReadingViewOverlay {
  const prepared = prepareOverlay(input);
  if (typeof prepared === 'string') {
    return { visible: false, hiddenReason: prepared, markers: [], legend: [] };
  }

  const format = input.formatTimestamp ?? defaultFormatTimestamp;
  const lineRanges = computeLineRanges(input.content);
  const markers: ReadingMarker[] = [];

  for (const block of blocks) {
    // Never guess: no resolved section means no marker at all.
    if (block.section === null) {
      continue;
    }
    const range = blockCharRange(block.section, lineRanges);
    if (range === null) {
      continue;
    }

    const marker = buildBlockMarker(block.blockId, range, prepared.runs, {
      format,
      animate: !input.reducedMotion,
    });
    if (marker !== null) {
      markers.push(marker);
    }
  }

  return {
    visible: true,
    hiddenReason: null,
    markers,
    legend: prepared.legend,
  };
}

function buildBlockMarker(
  blockId: string,
  range: { start: number; end: number },
  runs: readonly ResolvedRun[],
  options: { format: (ts: number) => string; animate: boolean },
): ReadingMarker | null {
  const authors: AttributionAuthorRef[] = [];
  const coveredByToken = new Map<string, number>();

  for (const run of runs) {
    const overlap = Math.min(run.to, range.end) - Math.max(run.from, range.start);
    if (overlap <= 0) {
      continue;
    }
    if (!authors.some((existing) => sameAuthor(existing, run.author))) {
      authors.push(run.author);
    }
    coveredByToken.set(
      run.author.colorToken,
      (coveredByToken.get(run.author.colorToken) ?? 0) + overlap,
    );
  }

  if (authors.length === 0) {
    return null;
  }

  const dominant = pickDominant(authors, coveredByToken);
  const tooltip = authors
    .map((author) => tooltipFor(author, options.format))
    .join('; ');

  return {
    blockId,
    colorToken: dominant.colorToken,
    underline: true,
    tooltip,
    ariaLabel: tooltip,
    animate: options.animate,
    authors,
  };
}

function sameAuthor(left: AttributionAuthorRef, right: AttributionAuthorRef): boolean {
  return left.colorToken === right.colorToken && left.displayName === right.displayName;
}

/** The author covering the most characters; ties broken by colour token order. */
function pickDominant(
  authors: readonly AttributionAuthorRef[],
  coveredByToken: ReadonlyMap<string, number>,
): AttributionAuthorRef {
  return [...authors].sort((left, right) => {
    const leftCovered = coveredByToken.get(left.colorToken) ?? 0;
    const rightCovered = coveredByToken.get(right.colorToken) ?? 0;
    if (leftCovered !== rightCovered) {
      return rightCovered - leftCovered;
    }
    return left.colorToken < right.colorToken ? -1 : 1;
  })[0] as AttributionAuthorRef;
}
