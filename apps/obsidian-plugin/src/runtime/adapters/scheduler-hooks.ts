/**
 * The timer and window-event seams the sync loop is driven by: the controller's
 * startup/focus/online/interval hooks and the runner's backoff scheduler. Both
 * are here because they are the same concern, turning ambient browser timers and
 * events into disposable handles, and because the focus/online registration is
 * deliberately NOT `plugin.registerDomEvent`: that only tears down on plugin
 * unload, so every reconnect leaked another listener pair for the session. The
 * visibility hook follows the same rule for the same reason.
 */

import type { Plugin } from 'obsidian';

import type { SchedulerFn } from '../../sync/sync-runner';
import type { SchedulerHooks } from '../scheduler';

/** Reads the current visibility so the hidden edge can be ignored (injectable). */
export interface VisibilityStateSource {
  readonly visibilityState: string;
}

/** The window-event surface the scheduler hooks need (injectable for tests). */
export interface SchedulerEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Startup/focus/online/interval scheduler hooks over the Obsidian runtime.
 *
 * MINOR (listener leak): `plugin.registerDomEvent` only tears its listeners
 * down on plugin UNLOAD, so `SyncScheduler.stop()` could never remove them,
 * every reconnect leaked another focus+online listener pair for the session.
 * The focus/online hooks now register directly via add/removeEventListener and
 * return REAL disposers, so `stop()` removes exactly the listeners it added.
 */
export function createSchedulerHooks(
  plugin: Plugin,
  target: SchedulerEventTarget = window,
  visibility?: SchedulerEventTarget & VisibilityStateSource,
): SchedulerHooks {
  return {
    onFocus(run) {
      target.addEventListener('focus', run);
      return () => target.removeEventListener('focus', run);
    },
    onOnline(run) {
      target.addEventListener('online', run);
      return () => target.removeEventListener('online', run);
    },
    onVisible(run) {
      // Resolved lazily, not as a default argument: `document` is absent in
      // node-environment tests, and evaluating it eagerly would throw before any
      // caller could inject a substitute.
      const source =
        visibility ??
        (typeof document === 'undefined' ? undefined : document);
      if (source === undefined) {
        return () => undefined;
      }
      // `visibilitychange` fires on the document, not the window, and only the
      // visible edge matters: going hidden must not disturb anything in flight.
      const listener = (): void => {
        if (source.visibilityState !== 'hidden') run();
      };
      source.addEventListener('visibilitychange', listener);
      return () => source.removeEventListener('visibilitychange', listener);
    },
    setInterval(run, ms) {
      const id = window.setInterval(run, ms);
      plugin.registerInterval(id);
      return () => window.clearInterval(id);
    },
  };
}

/** Backoff scheduler for the runner, wrapping `setTimeout`. */
export function createBackoffScheduler(): SchedulerFn {
  return (callback, delayMs) => {
    const timer = window.setTimeout(callback, delayMs);
    return () => window.clearTimeout(timer);
  };
}
