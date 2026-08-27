/**
 * Live Preview surface for the author overlay: a CodeMirror 6 view plugin that
 * turns overlay segments into `Decoration.mark` ranges.
 *
 * This is the `registerEditorExtension()` half of what `specs/001-mvp.md`
 * promises. All of the deciding happens in `attribution.ts` and
 * `overlay-source.ts`; this module only draws, and it draws nothing it was not
 * given.
 *
 * Accessibility (`plan/06` anti-spec S5): a mark never carries colour alone. The
 * class supplies the underline, the colour arrives as a CSS custom property so
 * no literal value is ever written into the document, and the author's name
 * travels in both `title` (hover) and `aria-label` (no mouse needed).
 *
 * `@codemirror/state` and `@codemirror/view` are provided BY Obsidian at
 * runtime and are declared external in `build.mjs`, they must never be bundled,
 * or the plugin would run a second, private copy of CodeMirror.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';

import type { LivePreviewOverlay } from './attribution';

/** Underline + spacing for an attributed span; see `styles.css`. */
export const AUTHOR_MARK_CLASS = 'havemind-author-mark';
/** Added only when the overlay allows animation (dropped under reduced motion). */
export const AUTHOR_MARK_ANIMATE_CLASS = 'havemind-author-mark-animate';

/** Where the overlay for the document in a given editor comes from. */
export interface LivePreviewOverlaySource {
  /**
   * The overlay for `path` with the document text `content`, or null when
   * nothing can be attributed honestly.
   */
  overlayFor(path: string | null, content: string): LivePreviewOverlay | null;
}

/**
 * The vault path of the file the editor is showing, or null when the view is not
 * backed by a file. Read from Obsidian's `editorInfoField` rather than the active
 * file, so a split pane attributes its OWN document instead of the focused one.
 */
export function pathForEditorView(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false);
  return info?.file?.path ?? null;
}

/**
 * Maps overlay segments onto CodeMirror marks. Segments are clamped to the live
 * document and a span that collapses to nothing is dropped, CodeMirror rejects
 * an empty mark range outright, so a stale offset must never reach it.
 */
export function buildAuthorDecorations(
  overlay: LivePreviewOverlay | null,
  docLength: number,
): DecorationSet {
  if (overlay === null || !overlay.visible) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const segment of overlay.segments) {
    const from = Math.min(Math.max(segment.from, 0), docLength);
    const to = Math.min(Math.max(segment.to, 0), docLength);
    if (to <= from) {
      continue;
    }
    builder.add(
      from,
      to,
      Decoration.mark({
        class: segment.animate
          ? `${AUTHOR_MARK_CLASS} ${AUTHOR_MARK_ANIMATE_CLASS}`
          : AUTHOR_MARK_CLASS,
        attributes: {
          title: segment.tooltip,
          'aria-label': segment.ariaLabel,
          'data-havemind-author': segment.author.displayName,
          // The token name only, the concrete light/dark value lives in
          // `styles.css`, never in the note or the decoration.
          style: `--havemind-overlay-color: var(${segment.colorToken});`,
        },
      }),
    );
  }
  return builder.finish();
}

/**
 * The extension handed to `registerEditorExtension()`. Decorations are rebuilt
 * on every view update: the source reads the live toggle and the live Activity
 * feed, both of which can change without the document changing, and the rebuild
 * is a walk over at most a couple of hundred feed entries.
 */
export function createAuthorOverlayExtension(
  source: LivePreviewOverlaySource,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate): void {
        this.decorations = this.build(update.view);
      }

      private build(view: EditorView): DecorationSet {
        return buildAuthorDecorations(
          source.overlayFor(
            pathForEditorView(view),
            view.state.doc.toString(),
          ),
          view.state.doc.length,
        );
      }
    },
    { decorations: (value) => value.decorations },
  );
}
