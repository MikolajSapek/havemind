/**
 * A network request has to give up on its own.
 *
 * Obsidian's `requestUrl` takes no timeout (its `RequestUrlParam` has url,
 * method, contentType, body, headers and throw, and nothing else), so a request
 * whose connection dies without closing hangs forever. On a phone that is the
 * normal case, not an edge one: walking out of Wi-Fi range drops the network
 * without an FIN, and the sync loop then waits on a promise that never settles.
 * Every retry, backoff and reconnect sits behind that promise.
 *
 * The wrapper rejects after a bound, so the loop's existing failure handling
 * (backoff, then reconnect) gets a chance to run.
 */

import { describe, expect, it, vi } from 'vitest';

import { withRequestTimeout, REQUEST_TIMEOUT_MS } from './request-timeout';

describe('withRequestTimeout', () => {
  it('passes a prompt response straight through', async () => {
    const result = await withRequestTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects a request that never settles', async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<string>(() => undefined);
      const guarded = withRequestTimeout(hung, 5_000);
      const assertion = expect(guarded).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the original failure rather than masking it as a timeout', async () => {
    const failed = Promise.reject(new Error('connection refused'));
    await expect(withRequestTimeout(failed, 1000)).rejects.toThrow(
      /connection refused/,
    );
  });

  it('clears its timer once the request settles', async () => {
    // A pending timer per request would keep the event loop busy and, on
    // mobile, hold a wake-lock-shaped cost for nothing.
    vi.useFakeTimers();
    try {
      await withRequestTimeout(Promise.resolve('ok'), 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the default well under the server long-poll window', () => {
    // The server holds /wait for 25s, so the default must exceed that or every
    // long poll would be killed as a timeout. It must also stay finite.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(25_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
