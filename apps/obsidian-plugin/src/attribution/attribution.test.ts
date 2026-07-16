import { describe, expect, it } from 'vitest';

import { createInitialProvenance, type ProvenanceRun } from '@havemind/sync-core';

import {
  AUTHOR_COLOR_TOKENS,
  buildLivePreviewOverlay,
  buildReadingViewOverlay,
  INITIAL_IMPORT_COLOR_TOKEN,
  type OverlayInput,
  type ReadingBlock,
  type RevisionAuthorInfo,
} from './attribution';

const CONTENT = 'Alpha\nBeta\n';
const HASH = 'blob-alpha-beta';

function authors(
  entries: ReadonlyArray<[string, RevisionAuthorInfo]>,
): ReadonlyMap<string, RevisionAuthorInfo> {
  return new Map(entries);
}

function baseInput(overrides: Partial<OverlayInput> = {}): OverlayInput {
  return {
    enabled: true,
    content: CONTENT,
    contentHash: HASH,
    headBlobHash: HASH,
    provenance: [
      { length: 'Alpha\n'.length, sourceRevisionId: 'r1' },
      { length: 'Beta\n'.length, sourceRevisionId: 'r2' },
    ],
    authors: authors([
      [
        'r1',
        {
          actor: { kind: 'author', actorId: 'a-ana', displayName: 'Ana' },
          timestamp: 100,
        },
      ],
      [
        'r2',
        {
          actor: { kind: 'author', actorId: 'a-bob', displayName: 'Bob' },
          timestamp: 200,
        },
      ],
    ]),
    reducedMotion: false,
    formatTimestamp: (ts) => `t${ts}`,
    ...overrides,
  };
}

describe('buildLivePreviewOverlay — hidden states (never guess)', () => {
  it('hides the overlay when the document hash no longer matches the head revision', () => {
    const overlay = buildLivePreviewOverlay(
      baseInput({ contentHash: 'blob-locally-edited' }),
    );
    expect(overlay.visible).toBe(false);
    expect(overlay.hiddenReason).toBe('hash-mismatch');
    expect(overlay.segments).toEqual([]);
    expect(overlay.legend).toEqual([]);
  });

  it('hides the overlay when provenance does not cover the whole document', () => {
    const overlay = buildLivePreviewOverlay(
      baseInput({
        provenance: [{ length: 3, sourceRevisionId: 'r1' }],
      }),
    );
    expect(overlay.visible).toBe(false);
    expect(overlay.hiddenReason).toBe('provenance-content-mismatch');
    expect(overlay.segments).toEqual([]);
  });

  it('hides the overlay when the toggle is off', () => {
    const overlay = buildLivePreviewOverlay(baseInput({ enabled: false }));
    expect(overlay.visible).toBe(false);
    expect(overlay.hiddenReason).toBe('overlay-disabled');
    expect(overlay.segments).toEqual([]);
  });

  it('hides the overlay when a provenance source cannot be resolved (never a false author)', () => {
    const overlay = buildLivePreviewOverlay(
      baseInput({
        authors: authors([
          [
            'r1',
            {
              actor: { kind: 'author', actorId: 'a-ana', displayName: 'Ana' },
              timestamp: 100,
            },
          ],
        ]),
      }),
    );
    expect(overlay.visible).toBe(false);
    expect(overlay.hiddenReason).toBe('unresolved-source');
    expect(overlay.segments).toEqual([]);
  });
});

describe('buildLivePreviewOverlay — decorations', () => {
  it('emits one segment per provenance run with color AND underline AND tooltip together', () => {
    const overlay = buildLivePreviewOverlay(baseInput());
    expect(overlay.visible).toBe(true);
    expect(overlay.hiddenReason).toBeNull();
    expect(overlay.segments).toHaveLength(2);

    const [first, second] = overlay.segments;
    expect(first).toMatchObject({
      from: 0,
      to: 'Alpha\n'.length,
      underline: true,
      tooltip: 'Ana · t100',
      ariaLabel: 'Ana · t100',
    });
    expect(second).toMatchObject({
      from: 'Alpha\n'.length,
      to: CONTENT.length,
      underline: true,
      tooltip: 'Bob · t200',
      ariaLabel: 'Bob · t200',
    });

    // Colour is NEVER the only signal: every segment carries underline + a
    // non-empty tooltip/aria-label alongside its colour token.
    for (const segment of overlay.segments) {
      expect(segment.underline).toBe(true);
      expect(segment.tooltip.length).toBeGreaterThan(0);
      expect(segment.ariaLabel.length).toBeGreaterThan(0);
      expect(segment.colorToken.length).toBeGreaterThan(0);
    }
  });

  it('assigns deterministic colour tokens by author and never reuses a note-content colour', () => {
    const overlay = buildLivePreviewOverlay(baseInput());
    const [first, second] = overlay.segments;
    // Sorted by actorId: a-ana → token[0], a-bob → token[1].
    expect(first?.colorToken).toBe(AUTHOR_COLOR_TOKENS[0]);
    expect(second?.colorToken).toBe(AUTHOR_COLOR_TOKENS[1]);
    // Tokens are CSS custom properties (editor layer), never raw colours.
    for (const segment of overlay.segments) {
      expect(segment.colorToken.startsWith('--havemind-')).toBe(true);
    }
    expect(overlay.legend).toEqual([
      { colorToken: AUTHOR_COLOR_TOKENS[0], label: 'Ana' },
      { colorToken: AUTHOR_COLOR_TOKENS[1], label: 'Bob' },
    ]);
  });

  it('labels initial-import fragments without inventing an author', () => {
    const importProvenance: ProvenanceRun[] = createInitialProvenance(
      CONTENT,
      'import-1',
    );
    const overlay = buildLivePreviewOverlay(
      baseInput({
        provenance: importProvenance,
        authors: authors([
          ['import-1', { actor: { kind: 'initial-import' }, timestamp: 0 }],
        ]),
      }),
    );
    expect(overlay.segments).toHaveLength(1);
    const [segment] = overlay.segments;
    expect(segment?.tooltip).toBe('Initial import');
    expect(segment?.ariaLabel).toBe('Initial import');
    expect(segment?.colorToken).toBe(INITIAL_IMPORT_COLOR_TOKEN);
    expect(segment?.underline).toBe(true);
    expect(overlay.legend).toEqual([
      { colorToken: INITIAL_IMPORT_COLOR_TOKEN, label: 'Initial import' },
    ]);
  });

  it('animates highlights by default but stays static under reduced motion (underline still shown)', () => {
    const animated = buildLivePreviewOverlay(baseInput());
    expect(animated.segments.every((segment) => segment.animate)).toBe(true);

    const reduced = buildLivePreviewOverlay(baseInput({ reducedMotion: true }));
    expect(reduced.segments.every((segment) => segment.animate)).toBe(false);
    // Underline is unconditional — reduced motion removes animation, not the
    // non-colour signal.
    expect(reduced.segments.every((segment) => segment.underline)).toBe(true);
    expect(reduced.visible).toBe(true);
  });
});

describe('buildReadingViewOverlay — block-level markers, silence without getSectionInfo', () => {
  const blocks: ReadingBlock[] = [
    { blockId: 'b-alpha', section: { lineStart: 0, lineEnd: 0 } },
    { blockId: 'b-beta', section: { lineStart: 1, lineEnd: 1 } },
    // getSectionInfo() returned nothing for this block → must stay silent.
    { blockId: 'b-unmapped', section: null },
  ];

  it('emits a block marker only for sections that getSectionInfo() resolved', () => {
    const overlay = buildReadingViewOverlay(baseInput(), blocks);
    expect(overlay.visible).toBe(true);
    expect(overlay.markers.map((marker) => marker.blockId)).toEqual([
      'b-alpha',
      'b-beta',
    ]);
    // The unmapped block never receives a marker — silence beats a false guess.
    expect(
      overlay.markers.some((marker) => marker.blockId === 'b-unmapped'),
    ).toBe(false);

    const alpha = overlay.markers.find((m) => m.blockId === 'b-alpha');
    expect(alpha).toMatchObject({
      colorToken: AUTHOR_COLOR_TOKENS[0],
      underline: true,
      tooltip: 'Ana · t100',
    });
    for (const marker of overlay.markers) {
      expect(marker.underline).toBe(true);
      expect(marker.tooltip.length).toBeGreaterThan(0);
      expect(marker.ariaLabel.length).toBeGreaterThan(0);
    }
  });

  it('never guesses: a hash mismatch hides all reading-view markers too', () => {
    const overlay = buildReadingViewOverlay(
      baseInput({ contentHash: 'blob-locally-edited' }),
      blocks,
    );
    expect(overlay.visible).toBe(false);
    expect(overlay.hiddenReason).toBe('hash-mismatch');
    expect(overlay.markers).toEqual([]);
  });

  it('shows the dominant author colour but enumerates every author in a mixed block', () => {
    const mixed: ReadingBlock[] = [
      { blockId: 'b-mixed', section: { lineStart: 0, lineEnd: 1 } },
    ];
    const overlay = buildReadingViewOverlay(baseInput(), mixed);
    expect(overlay.markers).toHaveLength(1);
    const [marker] = overlay.markers;
    // Ana covers 6 chars, Bob covers 5 → Ana is dominant for the colour.
    expect(marker?.colorToken).toBe(AUTHOR_COLOR_TOKENS[0]);
    expect(marker?.authors.map((a) => a.displayName)).toEqual(['Ana', 'Bob']);
    // Colour is not the only signal: the tooltip enumerates both authors.
    expect(marker?.tooltip).toBe('Ana · t100; Bob · t200');
    expect(marker?.underline).toBe(true);
  });

  it('respects reduced motion for reading-view markers as well', () => {
    const overlay = buildReadingViewOverlay(
      baseInput({ reducedMotion: true }),
      blocks,
    );
    expect(overlay.markers.every((marker) => !marker.animate)).toBe(true);
    expect(overlay.markers.every((marker) => marker.underline)).toBe(true);
  });
});
