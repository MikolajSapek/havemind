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

export class HavemindSyncController {
  private readonly options: HavemindSyncControllerOptions;
  private readonly now: () => number;
  private readonly scheduler: SyncScheduler;
  private lastSyncedAt: number | undefined;

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
