/**
 * The `.obsidian/` config-poll tick and its failure policy. Obsidian emits no
 * vault events for hidden files, so config changes are found by re-walking the
 * tree on an interval; this module owns that cadence plus the contract that one
 * bad tick can never wedge sync and can never fail silently either — every
 * failure warns with a leak-free reason and a throttled Notice. The tick itself
 * is built from injected seams so the whole failure/recovery behaviour is
 * testable headlessly.
 */

import type { LocalChangeOperation } from '../../obsidian/vault-adapter';

/**
 * How often the `.obsidian/` config mirror is re-walked (ms). Config is a
 * handful of tiny JSON/CSS files, and Obsidian emits no events for them, so a
 * modest poll is both cheap and responsive enough for a theme/hotkey change.
 */
export const CONFIG_POLL_INTERVAL_MS = 5_000;

/**
 * How many CONSECUTIVE failed config-poll ticks pass between user-facing
 * notices. The first failure of a streak always notifies; after that only every
 * Nth does. A persistently broken config mirror therefore stays visible without
 * a Notice every {@link CONFIG_POLL_INTERVAL_MS} (which at a 5 s interval would
 * be twelve toasts a minute for as long as the fault lasts).
 */
export const CONFIG_POLL_FAILURE_NOTICE_EVERY = 10;

/**
 * The throttled config-poll failure Notice. Deliberately generic: the detail
 * lives in the console (and is itself reason-only), so nothing about the failing
 * config file ever reaches the UI.
 */
export const CONFIG_POLL_FAILURE_NOTICE =
  'Havemind: config sync ran into repeated errors — see console.';

/**
 * A leak-free description of a config-poll failure: the error's CLASS only. An
 * error message raised while reading `.obsidian/` can quote the file's contents
 * (a foreign plugin's `data.json` holding an API key) or an absolute vault path,
 * none of which may reach the console or the UI (rule 4).
 */
function describeConfigPollFailure(error: unknown): string {
  return error instanceof Error ? `reason=${error.name}` : `reason=${typeof error}`;
}

/** Seams for one config-poll tick, so failure handling is testable headlessly. */
export interface ConfigPollTickDeps {
  /** One poll attempt — the runtime injects `pollConfigOnce`. */
  readonly poll: () => Promise<readonly LocalChangeOperation[]>;
  /** Records a genuine change in the Activity feed. */
  readonly recordActivity: (op: LocalChangeOperation) => void;
  /** Requests a sync after a tick that enqueued something. */
  readonly triggerSync: () => void;
  /** User-facing sink — `new Notice` in the runtime. */
  readonly notify: (message: string) => void;
  /** Console sink; defaults to `console.warn`. */
  readonly warn?: (message: string, reason: string) => void;
}

/**
 * Builds the `.obsidian/` config-poll tick.
 *
 * The returned function NEVER rejects: one bad tick must never stop the interval
 * or wedge sync. But a failure is never SILENT either (audit #3 finding 5) —
 * every failure warns to the console with a reason-only detail, and the user sees
 * a throttled {@link CONFIG_POLL_FAILURE_NOTICE} on the first failure of a streak
 * and every {@link CONFIG_POLL_FAILURE_NOTICE_EVERY}-th after it. Recovery resets
 * the streak SILENTLY, so a transient blip never earns a "back to normal" toast
 * and the next genuine outage notifies immediately instead of waiting out the old
 * streak's counter.
 */
export function createConfigPollTick(
  deps: ConfigPollTickDeps,
): () => Promise<void> {
  const warn: (message: string, reason: string) => void =
    deps.warn ?? ((message, reason) => console.warn(message, reason));
  let consecutiveFailures = 0;

  return async () => {
    try {
      const ops = await deps.poll();
      // Silent recovery: reset the throttle so the next outage is reported from
      // its own first failure.
      consecutiveFailures = 0;
      if (ops.length === 0) return;
      for (const op of ops) deps.recordActivity(op);
      deps.triggerSync();
    } catch (error: unknown) {
      consecutiveFailures += 1;
      warn(
        `Havemind: config sync tick failed (${consecutiveFailures} consecutive).`,
        describeConfigPollFailure(error),
      );
      const shouldNotify =
        consecutiveFailures === 1 ||
        consecutiveFailures % CONFIG_POLL_FAILURE_NOTICE_EVERY === 0;
      if (shouldNotify) deps.notify(CONFIG_POLL_FAILURE_NOTICE);
    }
  };
}
