/**
 * Making a remotely-applied `.obsidian/` config file VISIBLE. Writing the bytes
 * is only half the job — Obsidian caches its config in memory — so this module
 * owns the classification of which applied paths can be refreshed in place
 * (`css-change`) versus which honestly need a reload, and the batching reloader
 * that fires each distinct effect at most once per apply batch. Pure string logic
 * plus one timer seam, so the whole visibility contract is unit-testable without
 * a live workspace.
 */

/**
 * What a synced `.obsidian/` file needs before the user can actually SEE it.
 *
 * Writing the bytes is not enough: Obsidian caches its own config in memory and
 * only re-reads it on specific signals, so a remotely-applied theme, snippet or
 * appearance change landed on disk and then stayed invisible until the next
 * restart. That is the whole of the "graph colours did not change on the other
 * device" report — the file WAS synced, it just never took effect.
 *
 *  - `css-reload` — custom CSS. Obsidian re-reads snippets and the active theme
 *    when the workspace fires `css-change`, so these apply immediately with no
 *    restart and no user action.
 *  - `reload-notice` — settings Obsidian has no live re-read signal for
 *    (`app.json`, `graph.json`, `hotkeys.json`, `core-plugins.json`). Nothing can
 *    honestly be applied in place, so the user is told once per batch that a
 *    reload is needed. `graph.json` sits here on purpose: some graph colours do
 *    re-render when the view is reopened, but nothing guarantees it, and
 *    promising more than Obsidian delivers is worse than one accurate notice.
 */
export type ConfigApplyEffect = 'css-reload' | 'reload-notice';

/** Config paths whose bytes feed Obsidian's custom-CSS pipeline. */
const CSS_CONFIG_PREFIXES: readonly string[] = [
  '.obsidian/snippets/',
  '.obsidian/themes/',
];

/** Appearance settings (theme selection, accent colour) ride the CSS pipeline too. */
const CSS_CONFIG_EXACT: readonly string[] = ['.obsidian/appearance.json'];

/**
 * Classifies how a remotely-applied config path becomes visible. Pure string
 * logic over an already-in-scope `.obsidian/` path (see `isSyncableConfigPath`);
 * Windows backslash separators are normalised first so a peer that delivered a
 * backslash path is classified identically rather than silently downgraded to a
 * reload notice.
 */
export function classifyConfigApplyEffect(path: string): ConfigApplyEffect {
  const normalized = path.replace(/\\/gu, '/');
  if (CSS_CONFIG_EXACT.includes(normalized)) return 'css-reload';
  if (CSS_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'css-reload';
  }
  return 'reload-notice';
}

/**
 * The single message shown when synced settings cannot be applied in place. One
 * per apply batch — never one per file, or a peer's first sync of a full config
 * mirror would bury the user under a dozen identical toasts.
 */
export const CONFIG_RELOAD_NOTICE =
  'Havemind: settings synced — reload Obsidian to apply them.';

/**
 * How long a config-apply batch is collected before its effects fire. A remote
 * apply writes files one at a time, so a window is what turns "one theme folder"
 * into ONE css-change and ONE notice. Short enough to feel immediate.
 */
const CONFIG_APPLY_BATCH_MS = 250;

export interface ConfigApplyReloaderOptions {
  /** Fires Obsidian's `css-change` workspace event, re-reading all custom CSS. */
  readonly triggerCssChange: () => void;
  /** Shows a user-facing message (`new Notice` in the runtime). */
  readonly notify: (message: string) => void;
  /** Timer seam; defaults to `window.setTimeout`. */
  readonly schedule?: (run: () => void, delayMs: number) => void;
  /** Diagnostic sink for a failing side effect; defaults to `console.warn`. */
  readonly warn?: (message: string, error: unknown) => void;
  readonly batchMs?: number;
}

export interface ConfigApplyReloader {
  /** Records one successfully applied `.obsidian/` path (write or delete). */
  applied(path: string): void;
}

/**
 * Collects applied config paths into a batch and fires each distinct effect at
 * most once per batch: `css-change` for the CSS-backed paths, a single Notice for
 * the rest.
 *
 * The window is armed by the FIRST path and not extended by later ones, so a long
 * trickle of applies cannot postpone the CSS reload indefinitely. Both effects are
 * best-effort and individually guarded: a workspace that has gone away must never
 * turn a cosmetic refresh into an unhandled error on the apply path.
 */
export function createConfigApplyReloader(
  options: ConfigApplyReloaderOptions,
): ConfigApplyReloader {
  const schedule =
    options.schedule ?? ((run, delayMs) => void window.setTimeout(run, delayMs));
  const warn =
    options.warn ??
    ((message, error) => {
      console.warn(message, error);
    });
  const batchMs = options.batchMs ?? CONFIG_APPLY_BATCH_MS;

  let cssPending = false;
  let noticePending = false;
  let armed = false;

  const runGuarded = (label: string, effect: () => void): void => {
    try {
      effect();
    } catch (error) {
      warn(`Havemind: could not ${label} after a synced settings change.`, error);
    }
  };

  const flush = (): void => {
    armed = false;
    const css = cssPending;
    const notice = noticePending;
    cssPending = false;
    noticePending = false;
    if (css) runGuarded('refresh the custom CSS', options.triggerCssChange);
    if (notice) {
      runGuarded('show the reload notice', () =>
        options.notify(CONFIG_RELOAD_NOTICE),
      );
    }
  };

  return {
    applied(path) {
      if (classifyConfigApplyEffect(path) === 'css-reload') {
        cssPending = true;
      } else {
        noticePending = true;
      }
      if (armed) return;
      armed = true;
      schedule(flush, batchMs);
    },
  };
}
