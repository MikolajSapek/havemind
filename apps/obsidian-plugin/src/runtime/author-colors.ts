/**
 * Deterministic, stable author colours keyed by member id.
 *
 * A single source of truth so the same person is drawn in the same colour
 * everywhere the client shows attribution: the presence roster, the Activity
 * log rows and the F6 author overlay. Colour is NEVER the only signal, every
 * caller pairs the token with the author's name/label (see the roster, activity
 * and overlay renderers) per the project accessibility rule.
 *
 * "Stable" means a member's colour depends only on their id, never on how many
 * other members exist or the order they appear in, so Magda keeps her colour
 * when a third member joins. Assignment is a stable hash of the member id onto a
 * fixed palette; the concrete light/dark CSS values live in `styles.css` under
 * the tokens listed here.
 */

/** One palette slot: an editor-layer CSS token plus the light/dark hex it maps to. */
export interface AuthorColor {
  /** CSS custom property used in the DOM (never a raw colour in note content). */
  readonly token: string;
  /** Hex used in the light theme (defined in `styles.css`). */
  readonly light: string;
  /** Hex used in the dark theme (defined in `styles.css`). */
  readonly dark: string;
}

/**
 * Six author colours chosen to stay legible against both the light and dark
 * Obsidian backgrounds (WCAG-AA text contrast, distinct hues). The dark-theme
 * value is a lighter tint of the same hue so a member reads as "the same
 * colour" across themes. Kept in sync with the `--havemind-author-*` rules in
 * `styles.css`.
 */
export const AUTHOR_COLORS: readonly AuthorColor[] = [
  { token: '--havemind-author-1', light: '#1a73c2', dark: '#7cb6f0' },
  { token: '--havemind-author-2', light: '#8a3fc0', dark: '#c99bf0' },
  { token: '--havemind-author-3', light: '#0f8a6a', dark: '#5fd3ac' },
  { token: '--havemind-author-4', light: '#c25a00', dark: '#f0a35f' },
  { token: '--havemind-author-5', light: '#b03060', dark: '#ef92b6' },
  { token: '--havemind-author-6', light: '#5a6ac0', dark: '#a3aef0' },
] as const;

/** Palette of editor-layer colour tokens assigned to human authors. */
export const AUTHOR_COLOR_TOKENS = AUTHOR_COLORS.map(
  (color) => color.token,
) as readonly string[];

/** Distinct, neutral token reserved for the `Initial import` provenance. */
export const INITIAL_IMPORT_COLOR_TOKEN = '--havemind-author-initial';

/** Human-readable label shown for imported (non-authored) fragments. */
export const INITIAL_IMPORT_LABEL = 'Initial import';

/**
 * 32-bit FNV-1a hash of a string. Deterministic and dependency-free (no crypto),
 * used only to spread member ids across the palette, never for anything
 * security-sensitive.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in the unsigned range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Definite fallback (index 0) so palette lookups are never `undefined`. */
const FALLBACK_COLOR: AuthorColor = {
  token: '--havemind-author-1',
  light: '#1a73c2',
  dark: '#7cb6f0',
};

/** The full light/dark colour for a member (for reporting/legends). */
export function authorColor(memberId: string): AuthorColor {
  const index = fnv1a(memberId) % AUTHOR_COLORS.length;
  return AUTHOR_COLORS[index] ?? FALLBACK_COLOR;
}

/**
 * The colour token for a member. Stable per `memberId` and independent of any
 * other members, so a person's colour never shifts when the roster grows.
 */
export function authorColorToken(memberId: string): string {
  return authorColor(memberId).token;
}
