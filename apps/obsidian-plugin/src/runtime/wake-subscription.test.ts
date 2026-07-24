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
    // The durable cursor starts at 5. Call 0 resolves advanced (5 → 7): one wake.
    // onWake stands in for syncNow landing — it advances the durable cursor to 7,
    // so call 1 is a heartbeat (7 → 7) that stops the loop. No more polls.
    let cursor = 5;
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(7), ok(7)],
      onCall: (index) => {
        if (index === 1) sub.stop();
      },
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      loadCursor: async () => cursor,
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
        cursor = 7; // syncNow pulled and advanced the durable cursor.
      },
      scheduler: (callback) => callback(),
    });

    sub.start();
    await sub.whenStopped();

    expect(wakes).toBe(1);
    expect(calls[0]).toBe('https://host/vaults/vault-1/wait?cursor=5');
  });

  it('does not re-issue a fast-path /wait for a stale cursor while the wake settles', async () => {
    // Peer advance where the durable cursor lags the wake cursor: the server keeps
    // resolving cursor 7, but loadCursor only catches up to 7 after a few settle
    // delays (syncNow pulling). The loop must NOT hammer /wait with the stale
    // cursor 5 — it gates on the durable cursor and issues exactly one cursor=5
    // poll, then one cursor=7 poll once the durable cursor has caught up.
    let wakes = 0;
    let cursor = 5;
    let settleDelays = 0;
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(7)], // every poll resolves cursor 7
      onCall: (index) => {
        // Stop as soon as we finally poll with the settled (advanced) cursor.
        if (calls[index]?.endsWith('cursor=7')) sub.stop();
        // Safety net: never let a regressed tight loop run away in the test.
        if (index >= 10) sub.stop();
      },
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      loadCursor: async () => cursor,
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
      },
      scheduler: (callback) => {
        settleDelays += 1;
        if (settleDelays >= 3) cursor = 7; // durable cursor catches up after settling
        callback();
      },
    });

    sub.start();
    await sub.whenStopped();

    const staleWaits = calls.filter((url) => url.endsWith('cursor=5'));
    expect(staleWaits).toHaveLength(1); // exactly one poll for the stale cursor, no spin
    expect(wakes).toBe(1); // one wake → one sync, not a storm
    expect(settleDelays).toBeGreaterThanOrEqual(1); // it gated with a delay rather than re-polling
    expect(calls[calls.length - 1]).toBe(
      'https://host/vaults/vault-1/wait?cursor=7',
    );
  });

  it('applies a bounded delay instead of tight-spinning when the sync never advances the cursor', async () => {
    // Worst case: syncNow keeps failing to advance the durable cursor (stuck at 5)
    // while the server keeps resolving cursor 7. The loop must not spin unbounded —
    // after the single wake it pauses on the bounded settle delay rather than
    // re-issuing back-to-back fast-path /wait calls.
    let wakes = 0;
    let settleDelays = 0;
    const { fn, calls } = scriptedRequestUrl({
      script: [ok(7)],
      onCall: (index) => {
        if (index >= 10) sub.stop(); // safety net against a regressed tight loop
      },
    });
    const sub = new WakeSubscription({
      ...baseOptions(),
      loadCursor: async () => 5, // durable cursor never advances
      requestUrl: fn,
      onWake: () => {
        wakes += 1;
      },
      scheduler: (callback) => {
        settleDelays += 1;
        if (settleDelays >= 5) sub.stop(); // bound the otherwise-endless settle
        callback();
      },
    });

    sub.start();
    await sub.whenStopped();

    expect(wakes).toBe(1); // one wake, not dozens
    expect(calls).toHaveLength(1); // exactly one /wait, then gated — no tight spin
    expect(settleDelays).toBe(5); // re-checks were spaced by the bounded delay
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
