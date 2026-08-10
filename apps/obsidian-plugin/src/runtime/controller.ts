/**
 * Composes the sync runtime for a connected vault: it drives the injected sync
 * runner through the scheduler and publishes a status-bar view after every
 * cycle. The controller is the single place that turns a raw cycle result into a
 * connection status (`plan/05-plugin-polaczenie-i-sync.md`).
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
  /**
   * Quiesces the runner on teardown so it issues no further push/pull — including
   * from its own pending backoff timer. Optional so lightweight fakes need not
   * implement it, but the real `SyncRunner` always does; without it a stopped
   * connection's runner could still fire a stale-identity cycle after reconnect.
   */
  stop?(): void;
}

export type StatusListener = (
  status: ConnectionStatus,
  view: StatusBarView,
) => void;

/**
 * Minimal real-time push surface the controller owns. Satisfied by
 * `WakeSubscription`; kept as a narrow interface so the controller is unit-tested
 * without HTTP. The controller starts/stops it in lockstep with the schedule and
 * flips the poll cadence when the subscription reports connectivity through the
 * callback wired at construction (see `buildSyncController`).
 */
export interface WakeSubscriptionLike {
  start(): void;
  stop(): void;
}

export interface HavemindSyncControllerOptions {
  readonly runner: SyncRunnerLike;
  readonly hooks: SchedulerHooks;
  readonly intervalMs: number;
  readonly onStatus: StatusListener;
  readonly now?: () => number;
  /**
   * Optional real-time push subscription. When present the controller owns its
   * lifecycle (start on `start()`, stop on `stop()`).
   */
  readonly wake?: WakeSubscriptionLike;
  /**
   * Poll cadence to use while the push channel is connected. The periodic poll
   * degrades to this slow heartbeat (push delivers the real-time wakes) and
   * reverts to `intervalMs` when push is down. Defaults to `intervalMs` (no
   * degradation) when omitted.
   */
  readonly pushConnectedIntervalMs?: number;
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
    // The real-time push subscription runs alongside the periodic poll: it wakes
    // the loop immediately on a peer change while the poll stays as a fallback.
    this.options.wake?.start();
  }

  stop(): void {
    this.scheduler.stop();
    // Stop the push subscription in lockstep so no long-poll survives teardown.
    this.options.wake?.stop();
    // Quiesce the runner too, not only the schedule: `scheduler.stop()` disarms
    // the focus/online/interval triggers, but the runner owns a separate backoff
    // timer that would otherwise fire a cycle after teardown. On reconnect that
    // late cycle would push through the now-stale transport (prior identity) and
    // 403 the server — so a stopped connection's runner must be fully inert.
    this.options.runner.stop?.();
  }

  /**
   * Reacts to a push-connectivity transition by flipping the periodic poll
   * cadence: while push is connected the poll degrades to the slow heartbeat
   * (`pushConnectedIntervalMs`) because the subscription delivers real-time
   * wakes; when push is down it reverts to the normal `intervalMs` so the poll
   * alone keeps the vault fresh. Wired to the subscription's connectivity
   * callback in `buildSyncController`.
   */
  setPushConnected(connected: boolean): void {
    const connectedMs =
      this.options.pushConnectedIntervalMs ?? this.options.intervalMs;
    this.scheduler.setIntervalMs(
      connected ? connectedMs : this.options.intervalMs,
    );
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
      // Below the threshold the connection is not declared lost, but nothing is
      // progressing either — so this reports `retrying`, never `syncing`. A
      // spinner labelled "Syncing" during an outage claims work that is not
      // happening (honesty as a feature, `plan/01-zasady-i-slownik.md`).
      const status: ConnectionStatus =
        this.consecutiveFailures >= OFFLINE_FAILURE_THRESHOLD
          ? 'offline'
          : 'retrying';
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
