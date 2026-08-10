/**
 * Reading-view surface: mapping block markers onto rendered blocks.
 *
 * The post processor is a thin, honest bridge. What matters here: a block whose
 * `getSectionInfo()` did not resolve gets NO marker at all (never a guessed
 * range), the marker's colour travels as a CSS custom property rather than a
 * hard-coded value, and the author's name is reachable without a mouse.
 */

import { describe, expect, it } from 'vitest';

import type { ReadingMarker, ReadingViewOverlay } from './attribution';
import {
  AUTHOR_BLOCK_ANIMATE_CLASS,
  AUTHOR_BLOCK_CLASS,
  applyReadingMarker,
  createAuthorReadingViewProcessor,
  type ReadingViewSectionInfo,
} from './reading-view';
import { createMockElement, type MockElement } from '../test/obsidian.mock';

function marker(overrides: Partial<ReadingMarker> = {}): ReadingMarker {
  return {
    blockId: 'block',
    colorToken: '--havemind-author-3',
    underline: true,
    tooltip: 'Magda · 12:30',
    ariaLabel: 'Magda · 12:30',
    animate: true,
    authors: [
      {
        kind: 'author',
        actorId: 'm-magda',
        displayName: 'Magda',
        timestamp: 1,
        colorToken: '--havemind-author-3',
      },
    ],
    ...overrides,
  };
}

function visible(markers: readonly ReadingMarker[]): ReadingViewOverlay {
  return { visible: true, hiddenReason: null, markers, legend: [] };
}

/** A stand-in for Obsidian's post-processor context. */
function context(
  section: ReadingViewSectionInfo | null,
  sourcePath = 'Notes/One.md',
): { sourcePath: string; getSectionInfo: () => ReadingViewSectionInfo | null } {
  return { sourcePath, getSectionInfo: () => section };
}

const SECTION: ReadingViewSectionInfo = {
  text: 'first\nsecond\n',
  lineStart: 0,
  lineEnd: 0,
};

describe('applyReadingMarker', () => {
  it('adds the block class, the author name and the tooltip', () => {
    const element = createMockElement();

    applyReadingMarker(element as unknown as HTMLElement, marker());

    expect(element.classes).toContain(AUTHOR_BLOCK_CLASS);
    expect(element.attrs['data-havemind-authors']).toBe('Magda');
    expect(element.attrs['title']).toBe('Magda · 12:30');
    // Reachable without a mouse, so the colour is never the only signal.
    expect(element.attrs['aria-label']).toBe('Magda · 12:30');
  });

  it('carries the colour as a custom property, never a literal value', () => {
    const element = createMockElement();

    applyReadingMarker(element as unknown as HTMLElement, marker());

    expect(element.styleProperties['--havemind-overlay-color']).toBe(
      'var(--havemind-author-3)',
    );
  });

  it('omits the animation class under reduced motion', () => {
    const element = createMockElement();

    applyReadingMarker(
      element as unknown as HTMLElement,
      marker({ animate: false }),
    );

    expect(element.classes).toContain(AUTHOR_BLOCK_CLASS);
    expect(element.classes).not.toContain(AUTHOR_BLOCK_ANIMATE_CLASS);
  });

  it('lists every author contributing to the block', () => {
    const element = createMockElement();

    applyReadingMarker(
      element as unknown as HTMLElement,
      marker({
        authors: [
          {
            kind: 'author',
            actorId: 'm-magda',
            displayName: 'Magda',
            timestamp: 1,
            colorToken: '--havemind-author-3',
          },
          {
            kind: 'initial-import',
            actorId: null,
            displayName: 'Initial import',
            timestamp: 0,
            colorToken: '--havemind-author-initial',
          },
        ],
      }),
    );

    expect(element.attrs['data-havemind-authors']).toBe(
      'Magda, Initial import',
    );
  });
});

describe('createAuthorReadingViewProcessor', () => {
  function run(
    element: MockElement,
    ctx: ReturnType<typeof context>,
    overlay: ReadingViewOverlay | null,
  ): Array<{ path: string; content: string }> {
    const seen: Array<{ path: string; content: string }> = [];
    const processor = createAuthorReadingViewProcessor({
      overlayFor: (path, content) => {
        seen.push({ path, content });
        return overlay;
      },
    });
    processor(
      element as unknown as HTMLElement,
      ctx as unknown as Parameters<typeof processor>[1],
    );
    return seen;
  }

  it('marks a resolved block with the overlay marker', () => {
    const element = createMockElement();

    const seen = run(element, context(SECTION), visible([marker()]));

    expect(seen).toEqual([
      { path: 'Notes/One.md', content: 'first\nsecond\n' },
    ]);
    expect(element.classes).toContain(AUTHOR_BLOCK_CLASS);
  });

  it('stays silent for a block whose section did not resolve', () => {
    const element = createMockElement();

    const seen = run(element, context(null), visible([marker()]));

    // Never guess a range: the overlay is not even consulted.
    expect(seen).toEqual([]);
    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });

  it('stays silent when there is no overlay for the file', () => {
    const element = createMockElement();

    run(element, context(SECTION), null);

    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });

  it('stays silent for a hidden overlay', () => {
    const element = createMockElement();

    run(element, context(SECTION), {
      visible: false,
      hiddenReason: 'overlay-disabled',
      markers: [marker()],
      legend: [],
    });

    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });

  it('stays silent when the overlay produced no marker for the block', () => {
    const element = createMockElement();

    run(element, context(SECTION), visible([]));

    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });
});
