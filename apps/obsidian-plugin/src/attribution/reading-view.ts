/**
 * Reading-view surface for the author overlay: the
 * `registerMarkdownPostProcessor()` half of what `specs/001-mvp.md` promises.
 *
 * Obsidian hands the processor one rendered block at a time plus a context that
 * can resolve the block back to its source lines. That resolution is the whole
 * basis of the marker: when `getSectionInfo()` returns null — which Obsidian
 * documents as common — the block gets NO marker at all rather than a guessed
 * range (`plan/06` anti-spec S5).
 *
 * Markers are block-level only, never character-level: Reading view renders
 * Markdown to HTML, so source offsets do not survive into the DOM. The colour
 * arrives as a CSS custom property (never a literal value, never written into
 * note content) and the author names travel in `title` plus `aria-label`, so the
 * attribution is readable without a mouse and colour is never the only signal.
 */

import type { ReadingMarker, ReadingViewOverlay } from './attribution';

/** Left border + spacing for an attributed block; see `styles.css`. */
export const AUTHOR_BLOCK_CLASS = 'havemind-author-block';
/** Added only when the overlay allows animation (dropped under reduced motion). */
export const AUTHOR_BLOCK_ANIMATE_CLASS = 'havemind-author-block-animate';
/** Comma-separated author names, for inspection and styling hooks. */
export const AUTHOR_BLOCK_ATTRIBUTE = 'data-havemind-authors';

/** The `getSectionInfo()` result shape this module needs. */
export interface ReadingViewSectionInfo {
  /** The FULL source text of the file being rendered. */
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** The post-processor context fields this module reads. */
export interface ReadingViewContext {
  readonly sourcePath: string;
  getSectionInfo(element: HTMLElement): ReadingViewSectionInfo | null;
}

/** Where the overlay for a rendered file comes from. */
export interface ReadingViewOverlaySource {
  /**
   * The block-level overlay for `path` whose full source text is `content`,
   * covering exactly the one block described by `lineStart`/`lineEnd`, or null
   * when nothing can be attributed honestly.
   */
  overlayFor(
    path: string,
    content: string,
    section: ReadingViewSectionInfo,
  ): ReadingViewOverlay | null;
}

/** Applies one marker to one rendered block. */
export function applyReadingMarker(
  element: HTMLElement,
  marker: ReadingMarker,
): void {
  element.addClass(AUTHOR_BLOCK_CLASS);
  if (marker.animate) {
    element.addClass(AUTHOR_BLOCK_ANIMATE_CLASS);
  }
  element.setAttribute(
    AUTHOR_BLOCK_ATTRIBUTE,
    marker.authors.map((author) => author.displayName).join(', '),
  );
  // Hover and non-mouse readings of the same fact. The colour itself sits on a
  // decorative `::before` border drawn from the custom property below, so there
  // is no extra element for assistive technology to announce.
  element.setAttribute('title', marker.tooltip);
  element.setAttribute('aria-label', marker.ariaLabel);
  element.style.setProperty(
    '--havemind-overlay-color',
    `var(${marker.colorToken})`,
  );
}

/**
 * The processor handed to `registerMarkdownPostProcessor()`. One call per
 * rendered block; the overlay is consulted only for blocks that resolved.
 */
export function createAuthorReadingViewProcessor(
  source: ReadingViewOverlaySource,
): (element: HTMLElement, context: ReadingViewContext) => void {
  return (element, context) => {
    const section = context.getSectionInfo(element);
    if (section === null) {
      return;
    }
    const overlay = source.overlayFor(context.sourcePath, section.text, section);
    if (overlay === null || !overlay.visible) {
      return;
    }
    const marker = overlay.markers[0];
    if (marker === undefined) {
      return;
    }
    applyReadingMarker(element, marker);
  };
}
