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
  /** False while the overlay is off: nothing is read or drawn then (P14). */
  enabled?(): boolean;
  /**
   * Everything besides the text that the overlay depends on (the toggle, the
   * Activity feed, the roster). Decorations are rebuilt only when one of these
   * values changes (compared with Object.is), the text changes, or the file
   * does; without it they are rebuilt on every update.
   */
  revision?(): readonly unknown[];
}

/**
 * The vault path of the file the editor is showing, or null when the view is not
 * backed by a file. Read from Obsidian's `editorInfoField` rather than the active
 * file, so a split pane attributes its OWN document instead of the focused one.
 */
function pathForEditorView(view: EditorView): string | null {
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

/** What one editor update tells the overlay. */
export interface OverlayUpdate {
  readonly docChanged: boolean;
  readonly path: string | null;
  readonly doc: { toString(): string; readonly length: number };
}

/**
 * Decides when an editor's author marks must be rebuilt. Building copies the
 * whole document into a string, and CodeMirror updates on every keystroke,
 * cursor move and scroll: with the overlay off that cost bought nothing, and
 * with it on most updates change nothing the overlay reads (P14).
 */
export class OverlayDecorationState {
  decorations: DecorationSet = Decoration.none;
  private built = false;
  private path: string | null = null;
  private inputs: readonly unknown[] = [];

  constructor(private readonly source: LivePreviewOverlaySource) {}

  next(update: OverlayUpdate): DecorationSet {
    if (this.source.enabled?.() === false) {
      this.built = false;
      this.decorations = Decoration.none;
      return this.decorations;
    }
    const inputs = this.source.revision?.();
    const unchanged =
      inputs !== undefined &&
      this.built &&
      !update.docChanged &&
      update.path === this.path &&
      inputs.length === this.inputs.length &&
      inputs.every((value, index) => Object.is(value, this.inputs[index]));
    if (unchanged) return this.decorations;
    this.built = true;
    this.path = update.path;
    this.inputs = inputs ?? [];
    this.decorations = buildAuthorDecorations(
      this.source.overlayFor(update.path, update.doc.toString()),
      update.doc.length,
    );
    return this.decorations;
  }
}

/**
 * The extension handed to `registerEditorExtension()`. The source reads the
 * live toggle and the live Activity feed, both of which can change without the
 * document changing, so its `revision()` tells the state when to rebuild.
 */
export function createAuthorOverlayExtension(
  source: LivePreviewOverlaySource,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly state = new OverlayDecorationState(source);

      constructor(view: EditorView) {
        this.decorations = this.state.next({
          docChanged: true,
          path: pathForEditorView(view),
          doc: view.state.doc,
        });
      }

      update(update: ViewUpdate): void {
        this.decorations = this.state.next({
          docChanged: update.docChanged,
          path: pathForEditorView(update.view),
          doc: update.view.state.doc,
        });
      }
    },
    { decorations: (value) => value.decorations },
  );
}
