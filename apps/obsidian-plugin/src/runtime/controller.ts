/**
 * Composes the sync runtime for a connected vault: it drives the injected sync
 * runner through the scheduler and publishes a status-bar view after every
 * cycle. The controller is the single place that turns a raw cycle result into
 * a `Synced`/`Offline`/`Conflict` status (`plan/05-plugin-polaczenie-i-sync.md`).
 *
 * The runner, scheduler hooks and status sink are all injected, so the whole
 * composition is exercised without Obsidian, HTTP or a real clock.
 */

import { SyncScheduler, type SchedulerHooks } from './scheduler';
import {
  connectionStatusFromCycle,
  formatStatusBar,
  type ConnectionStatus,
  type StatusBarView,
} from './status';
import type { SyncCycleResult } from '../sync/sync-runner';

/** Minimal runner surface the controller needs (satisfied by `SyncRunner`). */
export interface SyncRunnerLike {
  trigger(): Promise<SyncCycleResult>;
}

export type StatusListener = (
  status: ConnectionStatus,
  view: StatusBarView,
) => void;

export interface HavemindSyncControllerOptions {
  readonly runner: SyncRunnerLike;
  readonly hooks: SchedulerHooks;
  readonly intervalMs: number;
  readonly onStatus: StatusListener;
  readonly now?: () => number;
}

/**
 * Consecutive failed cycles before the indicator declares Offline. A single
 * poll/refresh blip is a transient retry, not a connection loss, so it must not
 * latch Offline while later cycles succeed. Only sustained failure surfaces the
 * warning.
 */
const OFFLINE_FAILURE_THRESHOLD = 3;

export class HavemindSyncController {
  private readonly options: HavemindSyncControllerOptions;
  private readonly now: () => number;
  private readonly scheduler: SyncScheduler;
  private lastSyncedAt: number | undefined;
  private consecutiveFailures = 0;
  private lastObservedCycleId = 0;

  constructor(options: HavemindSyncControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.scheduler = new SyncScheduler({
      trigger: () => {
        void this.syncNow();
      },
      hooks: options.hooks,
      intervalMs: options.intervalMs,
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  async syncNow(): Promise<void> {
    this.report('syncing');
    const result = await this.options.runner.trigger();
    this.observeCycle(result);
  }

  /**
   * Derives the indicator from the LATEST cycle outcome — never a sticky flag.
   * Called for every completed cycle: both the ones this controller triggers and
   * the ones the runner drives itself through backoff (wired via the runner's
   * `onCycleComplete`). A single transient failure shows a brief retrying state
   * and recovers to Synced on the next successful cycle; only several
   * consecutive failures declare Offline.
   */
  observeCycle(result: SyncCycleResult): void {
    // Ignore a stale or duplicate cycle: a coalesced trigger and a backoff retry
    // can both deliver the same result, and an out-of-order late arrival must
    // never override a newer outcome.
    if (result.cycleId !== undefined) {
      if (result.cycleId <= this.lastObservedCycleId) {
        return;
      }
      this.lastObservedCycleId = result.cycleId;
    }

    if (result.status === 'offline') {
      this.consecutiveFailures += 1;
      const status: ConnectionStatus =
        this.consecutiveFailures >= OFFLINE_FAILURE_THRESHOLD
          ? 'offline'
          : 'syncing';
      this.report(status);
      return;
    }

    // Any completed push/pull round-trip proves the connection is live, so a
    // prior transient failure never sticks.
    this.consecutiveFailures = 0;
    const status = connectionStatusFromCycle(result.status);
    if (status === 'synced') {
      this.lastSyncedAt = this.now();
    }
    this.report(status);
    // A refused session is terminal: stop the schedule so the plugin issues no
    // further requests until the user reconnects (no 401 retry storm).
    if (result.status === 'unauthenticated') {
      this.stop();
    }
  }

  private report(status: ConnectionStatus): void {
    this.options.onStatus(
      status,
      formatStatusBar(
        this.lastSyncedAt === undefined
          ? { status }
          : { status, lastSyncedAt: this.lastSyncedAt },
      ),
    );
  }
}
