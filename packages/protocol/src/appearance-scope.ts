/**
 * Scope decision for the `.obsidian/` APPEARANCE mirror: an EXPLICIT ALLOWLIST
 * of safe appearance settings. Everything else under `.obsidian/` stays on the
 * machine — default-deny, so a config file nobody vetted can never start syncing
 * just because it appeared.
 *
 * WHY AN ALLOWLIST (audit #3, finding 2). The previous rule was the inverse — it
 * mirrored everything under `.obsidian/` minus a denylist — which meant a peer's
 * `.obsidian/plugins/<id>/main.js` synced. In a multi-member vault any member
 * could then replace another member's installed plugin code, and Obsidian would
 * execute it on the next reload: remote code execution between members of the
 * same vault. No denylist can make "mirror all plugin code" safe, so the default
 * is now "do not mirror" and only vetted appearance files are named.
 *
 * ALLOWED — nothing here is executable code:
 *  1. `.obsidian/appearance.json`, `app.json`, `hotkeys.json`, `graph.json`,
 *     `core-plugins.json` (exact paths). All five are settings-only JSON with no
 *     code path: `graph.json` carries the graph view's settings including node
 *     colour groups, and `core-plugins.json` toggles Obsidian's OWN built-in
 *     modules — it carries no third-party code and installs nothing, unlike
 *     `community-plugins.json`.
 *  2. `.obsidian/snippets/<name>.css` — CSS snippets, flat, stylesheets only.
 *  3. `.obsidian/themes/<name>/…` — theme stylesheets, manifests and preview
 *     images. Obsidian themes are CSS-only: it never executes JS from a theme
 *     folder, and this allowlist admits no `.js` there either.
 *
 * DENIED — everything else, notably:
 *  1. `.obsidian/plugins/**` — ALL third-party plugin code AND plugin state, no
 *     exceptions. This subtree is what finding 2 was about; it is also where
 *     every plugin's `data.json` secret store and Havemind's own pairing/session
 *     state live, so one rule covers both.
 *  2. `.obsidian/community-plugins.json` — the enabled-plugins registry.
 *  3. `.obsidian/workspace.json` / `workspace-mobile.json` — per-machine window
 *     layout (syncing it corrupted the second device).
 *  4. Any path with a `data.json` SEGMENT, even inside an allowed subtree —
 *     belt-and-braces for a paid theme's licence store. This is an EXACT segment
 *     match, not the old substring test (finding 9): `metadata.json` and
 *     `mydata.json` under `themes/`/`snippets/` are ordinary theme data and are
 *     no longer blocked by accident. Nothing is weakened by the narrowing —
 *     every plugin secret store is denied by rule 1 regardless of its name.
 *  5. Any path with an empty, `.` or `..` segment, so a traversal such as
 *     `.obsidian/themes/../plugins/x/styles.css` cannot re-enter through an
 *     allowed prefix.
 *
 * It lives in the protocol package because it is a SECURITY boundary consumed by
 * every layer: the plugin's producer guard (`vault-adapter.ts`), the config walk
 * (`config-adapter.ts`), and — through `canonicalizeVaultPath` — the envelope
 * build, the wire-schema refinement and the consumer payload decode. One list is
 * the single source of truth that cannot drift between producer and consumer,
 * and it is what makes a legacy plugin-code revision from an older peer fail
 * validation on arrival instead of being written to disk.
 *
 * This function decides PATH SCOPE only. It says nothing about how a file's
 * bytes are carried — an in-scope config path still has its content kind chosen
 * by extension downstream (text vs binary vs excluded-with-notice).
 *
 * No DOM/Obsidian/Node imports — string logic only, so it is trivially unit- and
 * property-testable. The one normalisation performed here is Windows backslash
 * separators → forward slashes (the wire-path separator); it deliberately does
 * NOT touch Unicode form, since that is the caller's concern. Matching is
 * case-SENSITIVE by design: under default-deny, a case variant can only fall out
 * of the allowlist, never sneak into it.
 */

/** Everything the allowlist can admit lives under this prefix. */
const OBSIDIAN_PREFIX = '.obsidian/';

/**
 * Exact appearance/behaviour settings files. `core-plugins.json` toggles
 * Obsidian's built-in modules only; the third-party registry
 * (`community-plugins.json`) is deliberately absent.
 */
const ALLOW_EXACT: ReadonlySet<string> = new Set([
  '.obsidian/appearance.json',
  '.obsidian/app.json',
  '.obsidian/core-plugins.json',
  // Graph view settings, node colour groups included — a stated user requirement.
  '.obsidian/graph.json',
  '.obsidian/hotkeys.json',
]);

/** CSS snippets: `.obsidian/snippets/<name>.css`, flat (Obsidian loads no deeper). */
const SNIPPETS_PREFIX = '.obsidian/snippets/';
const SNIPPETS_SEGMENT_COUNT = 3;
const SNIPPET_EXTENSIONS: ReadonlySet<string> = new Set(['css']);

/**
 * Themes: `.obsidian/themes/<name>/…`. Stylesheets, JSON metadata and preview
 * images only — never `.js`, because a theme folder is not a code drop site.
 */
const THEMES_PREFIX = '.obsidian/themes/';
const THEMES_MIN_SEGMENT_COUNT = 4;
const THEME_EXTENSIONS: ReadonlySet<string> = new Set([
  'css',
  'gif',
  'jpeg',
  'jpg',
  'json',
  'png',
  'svg',
  'webp',
]);

/**
 * The plugin/theme secret store. Matched as an EXACT path SEGMENT (finding 9),
 * so a lookalike basename such as `metadata.json` is not blocked while a genuine
 * `data.json` anywhere in the path still is.
 */
const SECRET_STORE_SEGMENT = 'data.json';

/** Backslash → forward slash. The ONLY normalisation this pure module performs. */
function normalizeSeparators(path: string): string {
  return path.replace(/\\/gu, '/');
}

/** Lowercased extension without the dot; `''` when the last segment has none. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash + 1) return '';
  return path.slice(dot + 1).toLowerCase();
}

/**
 * A segment that must stop the path outright, whichever allowlist branch it
 * would otherwise match: the secret store, and the empty/traversal segments that
 * could re-enter a denied subtree through an allowed prefix.
 */
function hasBlockedSegment(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment === SECRET_STORE_SEGMENT,
  );
}

/**
 * Whether a path is inside the `.obsidian/` appearance mirror: on the explicit
 * allowlist above and free of a blocked segment. Returns `false` for everything
 * else — all plugin code and state, the enabled-plugins registry, per-machine
 * layout, any config file nobody vetted, ordinary markdown notes and vault
 * attachments (governed by the separate markdown/binary scope), and the
 * `.trash` / `Havemind Conflicts/` roots (kept reserved by RESERVED_ROOTS, never
 * by this function).
 */
export function isSyncableConfigPath(path: string): boolean {
  const normalized = normalizeSeparators(path);
  if (!normalized.startsWith(OBSIDIAN_PREFIX)) return false;

  const segments = normalized.split('/');
  // BLOCKED SEGMENTS FIRST — they win over every allowlist branch below.
  if (hasBlockedSegment(segments)) return false;

  if (ALLOW_EXACT.has(normalized)) return true;

  if (normalized.startsWith(SNIPPETS_PREFIX)) {
    return (
      segments.length === SNIPPETS_SEGMENT_COUNT &&
      SNIPPET_EXTENSIONS.has(extensionOf(normalized))
    );
  }

  if (normalized.startsWith(THEMES_PREFIX)) {
    return (
      segments.length >= THEMES_MIN_SEGMENT_COUNT &&
      THEME_EXTENSIONS.has(extensionOf(normalized))
    );
  }

  return false;
}
