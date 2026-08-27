/**
 * Real-time push client: an HTTP long-poll "wake" subscription.
 *
 * Instead of waiting for the periodic poll (`DEFAULT_INTERVAL_MS`), the client
 * holds a `GET /vaults/:vaultId/wait?cursor=<n>` request open on the server. The
 * server resolves it either with an ADVANCED cursor (a peer pushed something new
 * → trigger an immediate sync) or, after its hold window, with the SAME cursor as
 * a heartbeat (nothing new → just re-issue). Either way the loop re-issues the
 * long-poll, so the client stays woken within the round-trip latency rather than
 * up to a whole poll interval.
 *
 * The subscription speaks only to injected ports (`RequestUrlFn`, `getAuthToken`,
 * `loadCursor`), so it is exercised without Obsidian, HTTP or a real clock. It
 * mirrors the runner's failure discipline:
 *  - a transport error reconnects with exponential backoff + jitter, never throws;
 *  - an HTTP 401 is terminal (the session was refused), it stops rather than
 *    hammering the server in a retry storm;
 *  - `stop()` makes it fully inert: no further long-poll is issued.
 *
 * It reports connection transitions through `onConnectedChange` so the controller
 * can degrade the periodic poll to a slow heartbeat while push is live and revert
 * to the normal cadence when push is down.
 */

import type { SchedulerFn } from '../sync/sync-runner';
import type { RequestUrlFn } from './sync-transport';

/** First-failure backoff ceiling; mirrors the runner's five-second loop cadence. */
const DEFAULT_BASE_BACKOFF_MS = 5000;
/** Upper bound on the backoff ceiling; mirrors the runner. */
const DEFAULT_MAX_BACKOFF_MS = 60_000;
/**
 * Short pause applied between re-checks while a fired wake is still settling, the
 * durable cursor has not yet advanced past the cursor whose /wait triggered the
 * sync. Bounds the loop so it can never re-issue back-to-back fast-path /wait
 * responses for the same still-behind cursor.
 */
const DEFAULT_SETTLE_DELAY_MS = 250;

export interface WakeSubscriptionOptions {
  readonly requestUrl: RequestUrlFn;
  /** Canonical HTTPS API base, no trailing slash (e.g. `https://host`). */
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  /** The durable cursor to hand the server so it can decide advanced vs heartbeat. */
  readonly loadCursor: () => Promise<number>;
  /**
   * Fired once each time the held request resolves with a cursor STRICTLY greater
   * than the one we sent (a peer advanced the log). Wired to an immediate
   * `controller.syncNow()` in production. Never fired on a heartbeat (unchanged
   * cursor), so a quiet server never forces redundant sync cycles.
   */
  readonly onWake: () => void;
  /**
   * Fired when the push channel transitions between connected (a long-poll just
   * resolved) and disconnected (a transport error, or a terminal 401). Lets the
   * controller flip the periodic poll cadence. Only edges are reported, never
   * repeats of the same state.
   */
  readonly onConnectedChange?: (connected: boolean) => void;
  /** Schedules a backoff delay; wraps `setTimeout` in production. Injectable for tests. */
  readonly scheduler?: SchedulerFn;
  /** Injectable jitter source in the half-open range [0, 1). */
  readonly random?: () => number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * Delay applied between re-checks while a fired wake is still settling (the
   * durable cursor has not yet advanced past the cursor whose /wait woke us).
   * Keeps the loop from re-issuing back-to-back fast-path /wait for the same
   * cursor. Injectable for tests; defaults to {@link DEFAULT_SETTLE_DELAY_MS}.
   */
  readonly settleDelayMs?: number;
}

/** Marks the terminal 401 so the loop can stop instead of backing off. */
class WakeAuthDeniedError extends Error {
  override readonly name = 'WakeAuthDeniedError';
  readonly authDenied = true;
}

export class WakeSubscription {
  private readonly options: Required<
    Pick<
      WakeSubscriptionOptions,
      | 'scheduler'
      | 'random'
      | 'baseBackoffMs'
      | 'maxBackoffMs'
      | 'settleDelayMs'
    >
  > &
    WakeSubscriptionOptions;

  private stopped = false;
  private started = false;
  private failureCount = 0;
  /**
   * The cursor sent on the /wait that last resolved as an advance and fired a
   * wake, or `null` when no wake is awaiting settlement. While set, the loop
   * waits for the durable cursor to advance past it (syncNow landing) before
   * re-arming the long-poll, so it never re-issues a fast-path /wait for the
   * same still-behind cursor.
   */
  private pendingSyncFromCursor: number | null = null;
  /** null until the first edge is emitted, so the very first state is reported. */
  private connected: boolean | null = null;
  private runPromise: Promise<void> = Promise.resolve();

  constructor(options: WakeSubscriptionOptions) {
    this.options = {
      scheduler:
        options.scheduler ??
        ((callback, delayMs) => {
          setTimeout(callback, delayMs);
        }),
      random: options.random ?? Math.random,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      settleDelayMs: options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS,
      ...options,
    };
  }

  /** Arms the long-poll loop. Idempotent; a no-op once stopped. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.runPromise = this.runLoop();
  }

  /**
   * Quiesces the subscription permanently: no further long-poll is issued (a poll
   * already in flight resolves and the loop then exits before re-issuing).
   * Idempotent.
   */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves once the loop has fully stopped, a teardown/test synchronisation aid. */
  async whenStopped(): Promise<void> {
    await this.runPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let sentCursor: number;
      let resolvedCursor: number;
      try {
        sentCursor = await this.options.loadCursor();
        // Anti-spin gate. `onWake` fires syncNow fire-and-forget; the durable
        // cursor only advances once that pull completes. Until it does,
        // re-issuing /wait with the same still-behind cursor just triggers the
        // server fast-path again, a tight back-to-back loop. So while a wake is
        // pending and the durable cursor has not advanced past the cursor we
        // sent, pause a short bounded delay and re-check instead of re-polling.
        if (
          this.pendingSyncFromCursor !== null &&
          sentCursor <= this.pendingSyncFromCursor
        ) {
          await this.settleDelay();
          continue;
        }
        // Durable cursor caught up (sync landed) or no wake pending: re-arm.
        this.pendingSyncFromCursor = null;
        resolvedCursor = await this.pollOnce(sentCursor);
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.setConnected(false);
        if (isAuthDenied(error)) {
          // Terminal: the session was refused. Never retry (no 401 storm).
          this.stopped = true;
          return;
        }
        await this.backoff();
        continue;
      }
      if (this.stopped) {
        return;
      }
      this.failureCount = 0;
      this.setConnected(true);
      if (resolvedCursor > sentCursor) {
        // A peer advanced the log. Fire one sync and remember the cursor we
        // sent; the next iteration waits for the durable cursor to advance past
        // it before re-arming, the "one wake → one sync, then wait" contract.
        this.pendingSyncFromCursor = sentCursor;
        this.options.onWake();
      } else {
        // Heartbeat (unchanged cursor): nothing pending, re-issue normally.
        this.pendingSyncFromCursor = null;
      }
    }
  }

  /** Bounded pause between re-checks while a fired wake settles. */
  private settleDelay(): Promise<void> {
    return new Promise((resolve) => {
      this.options.scheduler(() => resolve(), this.options.settleDelayMs);
    });
  }

  private async pollOnce(cursor: number): Promise<number> {
    const token = await this.options.getAuthToken();
    const response = await this.options.requestUrl({
      method: 'GET',
      url: `${this.options.apiBaseUrl}/vaults/${this.options.vaultId}/wait?cursor=${cursor}`,
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (response.status === 401) {
      throw new WakeAuthDeniedError('wake long-poll refused (HTTP 401)');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`wake long-poll returned HTTP ${response.status}`);
    }
    const body = response.json;
    if (!isRecord(body) || !Number.isSafeInteger(body.cursor)) {
      throw new Error('wake long-poll response missing numeric cursor');
    }
    return body.cursor as number;
  }

  private backoff(): Promise<void> {
    this.failureCount += 1;
    const ceiling = Math.min(
      this.options.maxBackoffMs,
      this.options.baseBackoffMs * 2 ** (this.failureCount - 1),
    );
    // Half jitter: a guaranteed floor of ceiling/2 plus up to another half.
    const half = ceiling / 2;
    const delayMs = half + this.options.random() * half;
    return new Promise((resolve) => {
      this.options.scheduler(() => resolve(), delayMs);
    });
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) {
      return;
    }
    this.connected = next;
    this.options.onConnectedChange?.(next);
  }
}

function isAuthDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { authDenied?: unknown }).authDenied === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
