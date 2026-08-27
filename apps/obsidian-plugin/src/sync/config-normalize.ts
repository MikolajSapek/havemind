/**
 * VOLATILE-FIELD filtering for the `.obsidian/` appearance mirror.
 *
 * `.obsidian/graph.json` is on the appearance allowlist because the graph view's
 * node COLOUR GROUPS are a stated user requirement. The problem is that Obsidian
 * stores machine-local VIEW STATE in the same file: merely OPENING the graph view
 * rewrites `scale` (the current zoom) and the `collapse-*` panel-fold flags. Two
 * devices therefore rewrote the file just by looking at it, each rewrite hashed
 * differently from the mapping, each produced a revision, and the two streams
 * ping-ponged, spawning conflict copies of a settings file and burying the one
 * thing the user actually wanted synced (the colour groups), which never landed
 * on the second device.
 *
 * The fix is to sync only the SEMANTIC part of the file:
 *
 *  - {@link normalizeConfigContent} is the form everything hashes, compares and
 *    pushes. A zoom-only rewrite normalises to the previous bytes, so it produces
 *    NO revision at all.
 *  - {@link mergeConfigContent} is the form written to DISK on a remote apply: the
 *    peer's semantic keys are overlaid onto the local object, so the receiving
 *    machine keeps its own zoom and fold state while adopting the colours.
 *
 * Both are pure string→string functions over the path and the file text, no
 * Obsidian, DOM or Node imports, so the whole contract is unit-testable.
 *
 * KEY ORDER of the output follows the SOURCE object (`JSON.stringify` of the
 * parsed object minus the dropped keys). That is deliberate and sufficient: the
 * two sides never compare two independently-ordered renderings of the same
 * settings, the receiving device re-normalises the file it just wrote, whose
 * semantic keys are in the SENDER's order by construction (see
 * {@link mergeConfigContent}), so the producer's next read hashes equal to the
 * revision it just applied and the write cannot echo back.
 *
 * FORWARD COMPATIBILITY: only the volatile keys named below are dropped. An
 * unknown key is KEPT, so a setting a future Obsidian release adds keeps syncing
 * instead of being silently filtered out.
 */

/** The one allowlisted config file that carries machine-local view state. */
const GRAPH_SETTINGS_PATH = '.obsidian/graph.json';

/**
 * Machine-local graph VIEW STATE, never synced. `scale` is the current zoom and
 * `close`/`collapse-*` are the fold state of the graph view's own side panels;
 * Obsidian rewrites them as a side effect of opening or resizing the view, and
 * every one of them describes this screen rather than the user's settings.
 *
 * Everything else is semantic and IS synced: `colorGroups`, `search`, `showTags`,
 * `showAttachments`, `hideUnresolved`, `showOrphans`, `showArrow`, the
 * `*Multiplier` sizing values, the force sliders (`centerStrength`,
 * `repelStrength`, `linkStrength`, `linkDistance`), and any key not named here.
 */
const GRAPH_VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'scale',
  'close',
  'collapse-filter',
  'collapse-color-groups',
  'collapse-display',
  'collapse-forces',
]);

/** Indentation for a rewritten settings file, Obsidian's own JSON style. */
const JSON_INDENT = 2;

/** Backslash → forward slash, matching the wire-path separator. */
function normalizeSeparators(path: string): string {
  return path.replace(/\\/gu, '/');
}

/**
 * Whether `path` names a config file that carries machine-local view state, i.e.
 * one whose synced form is a strict subset of what is on disk. Today that is
 * `.obsidian/graph.json` alone; every other allowlisted config file syncs whole.
 */
export function hasVolatileConfigFields(path: string): boolean {
  return normalizeSeparators(path) === GRAPH_SETTINGS_PATH;
}

/**
 * Parses `text` as a JSON OBJECT, or returns `null` when it is not one. A leading
 * UTF-8 BOM is tolerated (`JSON.parse` rejects it). An array, a primitive, `null`
 * and unparseable bytes all yield `null`, which every caller treats as "leave the
 * content exactly as it is", never trust external data, never rewrite what we do
 * not understand.
 */
function parseConfigObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** A copy of `source` keeping only the keys `keep` accepts, in source order. */
function pickKeys(
  source: Record<string, unknown>,
  keep: (key: string) => boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (keep(key)) result[key] = value;
  }
  return result;
}

/**
 * The SYNCED form of a config file's content: for `.obsidian/graph.json` the file
 * minus its volatile view-state keys, for every other path the input unchanged.
 * Unparseable or non-object JSON is returned unchanged too.
 *
 * This is the form the producer hashes, compares against its mapping and pushes,
 * so a rewrite that only touched `scale` or a `collapse-*` flag hashes EQUAL to
 * the last known base and never becomes a revision. Deterministic and idempotent:
 * normalising an already-normalised payload returns the same bytes.
 */
export function normalizeConfigContent(path: string, text: string): string {
  if (!hasVolatileConfigFields(path)) return text;
  const parsed = parseConfigObject(text);
  if (parsed === null) return text;
  return JSON.stringify(
    pickKeys(parsed, (key) => !GRAPH_VOLATILE_KEYS.has(key)),
    null,
    JSON_INDENT,
  );
}

/**
 * The bytes to WRITE for a remotely applied config revision: the peer's semantic
 * keys overlaid onto the local file's volatile view state.
 *
 * For `.obsidian/graph.json` that means the local `scale`/`collapse-*` survive
 * while the incoming `colorGroups` (and every other semantic key) replace what
 * was here, including REMOVALS: a key the remote no longer carries is dropped,
 * so a colour group the peer deleted disappears here too instead of living on
 * forever. `localText` is `null` (no file yet) or unparseable → the remote's
 * semantic content is written as-is, with no volatile keys imported from the peer.
 *
 * The remote payload is re-normalised on the way in, so a LEGACY peer that still
 * pushes its raw file (volatile keys included) never plants its zoom level here.
 *
 * Every other path returns `remoteText` untouched: a file with no volatile keys
 * has nothing to preserve, and the incoming content wins whole.
 *
 * The result is built as `{ …local volatile, …remote semantic }`, so dropping the
 * volatile keys again leaves exactly the remote payload's own key order, that
 * identity is what makes the producer's next read of this file hash equal to the
 * revision just applied (no echo, no ping-pong).
 */
export function mergeConfigContent(
  path: string,
  localText: string | null,
  remoteText: string,
): string {
  if (!hasVolatileConfigFields(path)) return remoteText;
  const remote = parseConfigObject(remoteText);
  if (remote === null) return remoteText;

  const local = localText === null ? null : parseConfigObject(localText);
  const localVolatile =
    local === null ? {} : pickKeys(local, (key) => GRAPH_VOLATILE_KEYS.has(key));
  const remoteSemantic = pickKeys(
    remote,
    (key) => !GRAPH_VOLATILE_KEYS.has(key),
  );

  return `${JSON.stringify({ ...localVolatile, ...remoteSemantic }, null, JSON_INDENT)}\n`;
}
