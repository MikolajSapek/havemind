/**
 * Live Preview surface: turning overlay segments into CodeMirror 6 marks.
 *
 * The decoration builder is pure, so it is exercised here without a live
 * `EditorView` (which needs a DOM). What matters: an invisible overlay draws
 * nothing, colour always arrives with an underline class plus a named tooltip,
 * and a degenerate or out-of-range span is dropped rather than handed to
 * CodeMirror, which rejects empty mark ranges outright.
 */

import { describe, expect, it } from 'vitest';

import type { DecorationSet } from '@codemirror/view';

import type { AttributionSegment, LivePreviewOverlay } from './attribution';
import {
  AUTHOR_MARK_ANIMATE_CLASS,
  AUTHOR_MARK_CLASS,
  buildAuthorDecorations,
  createAuthorOverlayExtension,
} from './editor-extension';

interface FlatMark {
  readonly from: number;
  readonly to: number;
  readonly spec: Record<string, unknown>;
}

function flatten(set: DecorationSet): FlatMark[] {
  const marks: FlatMark[] = [];
  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    marks.push({
      from: cursor.from,
      to: cursor.to,
      spec: cursor.value.spec as Record<string, unknown>,
    });
  }
  return marks;
}

function segment(overrides: Partial<AttributionSegment> = {}): AttributionSegment {
  return {
    from: 0,
    to: 5,
    colorToken: '--havemind-author-2',
    underline: true,
    tooltip: 'Magda · 12:30',
    ariaLabel: 'Magda · 12:30',
    animate: true,
    author: {
      kind: 'author',
      actorId: 'm-magda',
      displayName: 'Magda',
      timestamp: 1,
      colorToken: '--havemind-author-2',
    },
    ...overrides,
  };
}

function overlay(segments: readonly AttributionSegment[]): LivePreviewOverlay {
  return { visible: true, hiddenReason: null, segments, legend: [] };
}

describe('buildAuthorDecorations', () => {
  it('draws nothing when there is no overlay to draw', () => {
    expect(buildAuthorDecorations(null, 10).size).toBe(0);
  });

  it('draws nothing for a hidden overlay', () => {
    expect(
      buildAuthorDecorations(
        {
          visible: false,
          hiddenReason: 'overlay-disabled',
          segments: [segment()],
          legend: [],
        },
        10,
      ).size,
    ).toBe(0);
  });

  it('marks a segment with the author name, tooltip and colour custom property', () => {
    const marks = flatten(buildAuthorDecorations(overlay([segment()]), 10));

    expect(marks).toHaveLength(1);
    const mark = marks[0];
    expect(mark?.from).toBe(0);
    expect(mark?.to).toBe(5);
    expect(mark?.spec['class']).toBe(
      `${AUTHOR_MARK_CLASS} ${AUTHOR_MARK_ANIMATE_CLASS}`,
    );
    expect(mark?.spec['attributes']).toEqual({
      title: 'Magda · 12:30',
      'aria-label': 'Magda · 12:30',
      'data-havemind-author': 'Magda',
      style: '--havemind-overlay-color: var(--havemind-author-2);',
    });
  });

  it('drops the animation class under reduced motion but keeps the mark', () => {
    const marks = flatten(
      buildAuthorDecorations(overlay([segment({ animate: false })]), 10),
    );

    expect(marks[0]?.spec['class']).toBe(AUTHOR_MARK_CLASS);
  });

  it('skips an empty span — CodeMirror rejects a zero-length mark', () => {
    expect(
      buildAuthorDecorations(overlay([segment({ from: 3, to: 3 })]), 10).size,
    ).toBe(0);
  });

  it('clamps a span that reaches past the end of the document', () => {
    const marks = flatten(
      buildAuthorDecorations(overlay([segment({ from: 0, to: 99 })]), 4),
    );

    expect(marks[0]?.to).toBe(4);
  });

  it('keeps consecutive segments in document order', () => {
    const marks = flatten(
      buildAuthorDecorations(
        overlay([
          segment({ from: 0, to: 3 }),
          segment({ from: 3, to: 7, colorToken: '--havemind-author-3' }),
        ]),
        7,
      ),
    );

    expect(marks.map(({ from, to }) => [from, to])).toEqual([
      [0, 3],
      [3, 7],
    ]);
  });
});

describe('createAuthorOverlayExtension', () => {
  it('builds a registrable CodeMirror extension without touching the DOM', () => {
    const extension = createAuthorOverlayExtension({
      overlayFor: () => null,
    });

    expect(extension).toBeDefined();
  });
});
