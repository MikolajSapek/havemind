/**
 * Scope decision for the `.obsidian/` config MIRROR: everything under
 * `.obsidian/` syncs across devices EXCEPT a hard denylist. This is the inverse
 * of a narrow allowlist — the default is "mirror it" and the denylist carves
 * out the few paths that must never leave a machine.
 *
 * It lives in the protocol package because it is a SECURITY boundary consumed by
 * every layer: the plugin's producer guard (`vault-adapter.ts`), and — through
 * `canonicalizeVaultPath` — the envelope build, the wire-schema refinement and
 * the consumer payload decode. One list is the single source of truth that
 * cannot drift between producer and consumer.
 *
 * The DENYLIST is evaluated FIRST and always wins over the mirror default:
 *  1. `data.json` (SUBSTRING match) — every plugin's secret/settings store AND
 *     the Havemind pairing/session state. This one rule omits all of them.
 *  2. `.obsidian/workspace.json` / `workspace-mobile.json` — per-machine window
 *     layout (syncing it corrupted the second device).
 *  3. `.obsidian/community-plugins.json` — the enabled-plugins list. Omitting it
 *     means synced plugins arrive DISABLED: the user installs/enables them by
 *     hand rather than a peer auto-enabling foreign code.
 *  4. `.obsidian/plugins/havemind-sync/` (whole prefix) — our own plugin's
 *     folder, belt-and-suspenders on top of the `data.json` rule so no Havemind
 *     state ever circulates.
 *
 * This function decides PATH SCOPE only. It says nothing about how a file's
 * bytes are carried — a syncable config path still has its content kind chosen
 * by extension downstream (text vs binary vs excluded-with-notice).
 *
 * No DOM/Obsidian/Node imports — string logic only, so it is trivially unit- and
 * property-testable. The one normalisation performed here is Windows backslash
 * separators → forward slashes (the wire-path separator); it deliberately does
 * NOT touch Unicode form, since that is the caller's concern.
 */

/** Everything the mirror considers in scope lives under this prefix. */
const OBSIDIAN_PREFIX = '.obsidian/';

/**
 * The plugin secret/settings store. Matched as a SUBSTRING (not just a path
 * segment) so no variant — nested, plugin-owned, or a lookalike path — can ever
 * slip a secret file through the mirror.
 */
const SECRET_STORE_MARKER = 'data.json';

/** Exact single-file denials: per-machine layout and the enabled-plugins list. */
const DENY_EXACT: ReadonlySet<string> = new Set([
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/community-plugins.json',
]);

/** Our own plugin's folder — its entire subtree never leaves the machine. */
const HAVEMIND_PLUGIN_PREFIX = '.obsidian/plugins/havemind-sync/';

/** Backslash → forward slash. The ONLY normalisation this pure module performs. */
function normalizeSeparators(path: string): string {
  return path.replace(/\\/gu, '/');
}

function isDenied(path: string): boolean {
  if (path.includes(SECRET_STORE_MARKER)) return true;
  if (DENY_EXACT.has(path)) return true;
  if (path.startsWith(HAVEMIND_PLUGIN_PREFIX)) return true;
  return false;
}

/**
 * Whether a path is inside the `.obsidian/` config mirror: under `.obsidian/`
 * and outside the hard denylist. Returns `false` for everything else — ordinary
 * markdown notes and vault attachments (governed by the separate markdown/binary
 * scope), and the `.trash` / `Havemind Conflicts/` roots (kept reserved by
 * RESERVED_ROOTS, never by this function).
 */
export function isSyncableConfigPath(path: string): boolean {
  const normalized = normalizeSeparators(path);
  if (!normalized.startsWith(OBSIDIAN_PREFIX)) return false;
  // DENYLIST FIRST — it always wins over the mirror-everything default.
  if (isDenied(normalized)) return false;
  return true;
}
