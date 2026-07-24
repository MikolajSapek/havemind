import { describe, expect, it } from 'vitest';

import { WakeSubscription } from './wake-subscription';
import type { RequestUrlFn, RequestUrlResponseLike } from './sync-transport';

/**
 * Builds a `RequestUrlFn` double that records every call, yields scripted
 * responses (or a thrown transport error for a `null` script entry), and can
 * invoke a side effect (e.g. `sub.stop()`) after a given number of calls so an
 * otherwise-infinite long-poll loop terminates deterministically.
 */
function scriptedRequestUrl(config: {
  readonly script: ReadonlyArray<RequestUrlResponseLike | null>;
  readonly stopAfter?: number;
  readonly onCall?: (callIndex: number) => void;
}): { fn: RequestUrlFn; calls: string[] } {
  const calls: string[] = [];
  const fn: RequestUrlFn = async (options) => {
    const index = calls.length;
    calls.push(options.url);
    config.onCall?.(index);
    const entry =
      config.script[Math.min(index, config.script.length - 1)] ?? null;
    if (entry === null) {
      throw new Error('simulated transport failure');
    }
    return entry;
  };
  return { fn, calls };
}

function ok(cursor: number): RequestUrlResponseLike {
  return { status: 200, json: { cursor } };
}

const UNAUTHORIZED: RequestUrlResponseLike = { status: 401, json: undefined };

function baseOptions() {
  return {
    apiBaseUrl: 'https://host',
    vaultId: 'vault-1',
    getAuthToken: async () => 'tok',
    loadCursor: async () => 5,
  };
}

describe('WakeSubscription', () => {
  it('triggers exactly one sync when the long-poll resolves with an advanced cursor', async () => {
    let wakes = 0;
    // Call 0 → advanced (5 → 7): one wake. Call 1 stops the loop, so no more polls.
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(7), ok(7)],
      onCall: (index) => {
        if (index === 1) sub.stop();
      },
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
      },
    });

    sub.start();
    await sub.whenStopped();

    expect(wakes).toBe(1);
    expect(calls[0]).toBe('https://host/vaults/vault-1/wait?cursor=5');
  });

  it('re-issues the long-poll on a heartbeat without forcing a sync', async () => {
    let wakes = 0;
    // Both calls are heartbeats (unchanged cursor 5 → 5): re-issue, never wake.
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(5), ok(5)],
      onCall: (index) => {
        if (index === 1) sub.stop();
      },
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
      },
    });

    sub.start();
    await sub.whenStopped();

    expect(wakes).toBe(0);
    expect(calls.length).toBeGreaterThanOrEqual(2); // re-issued after the heartbeat
  });

  it('reconnects with increasing backoff on transport errors and never throws', async () => {
    const delays: number[] = [];
    let calls = 0;
    const requestUrl: RequestUrlFn = async () => {
      calls += 1;
      if (calls >= 3) sub.stop();
      throw new Error('offline');
    };
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl,
      onWake: () => undefined,
      baseBackoffMs: 1000,
      random: () => 0, // deterministic: delay === ceiling/2
      scheduler: (callback, delayMs) => {
        delays.push(delayMs);
        callback();
      },
    });

    sub.start();
    await expect(sub.whenStopped()).resolves.toBeUndefined();

    // ceiling doubles each failure (1000, 2000, ...), half-jitter floor = ceiling/2.
    expect(delays).toEqual([500, 1000]);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
  });

  it('stops terminally on a 401 without a retry storm', async () => {
    let wakes = 0;
    const { fn, calls } = scriptedRequestUrl({ script: [UNAUTHORIZED] });
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
      },
      scheduler: (callback) => callback(), // would loop instantly if it retried
    });

    sub.start();
    await sub.whenStopped();

    expect(calls.length).toBe(1); // exactly one attempt, then terminal
    expect(wakes).toBe(0);
  });

  it('issues no further long-poll after stop()', async () => {
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(5)],
      onCall: () => sub.stop(), // stop during the very first poll
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => undefined,
    });

    sub.start();
    await sub.whenStopped();

    expect(calls.length).toBe(1);
  });

  it('reports connected on a resolved poll and disconnected on a transport error', async () => {
    const transitions: boolean[] = [];
    let calls = 0;
    const requestUrl: RequestUrlFn = async () => {
      calls += 1;
      if (calls === 1) return ok(5); // heartbeat → connected
      throw new Error('offline'); // → disconnected, then backoff
    };
    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl,
      onWake: () => undefined,
      onConnectedChange: (connected) => transitions.push(connected),
      // Stop from inside the backoff so the disconnected edge is emitted first.
      scheduler: (callback) => {
        sub.stop();
        callback();
      },
    });

    sub.start();
    await sub.whenStopped();

    expect(transitions).toEqual([true, false]);
  });
});
