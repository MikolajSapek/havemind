/**
 * MOB-01: the push channel must re-arm when the app returns to the foreground.
 *
 * The server holds `/wait` for 25s and iOS freezes background work at about 30s,
 * so minimising Obsidian leaves a long-poll frozen mid-flight. Coming back must
 * abandon the pending backoff and re-enter the loop immediately rather than
 * waiting the backoff out; the periodic poll's existing `focus` trigger only
 * drives the poll, it never touches this subscription.
 *
 * Everything here runs on an injected scheduler, so no real timers are involved.
 */

import { describe, expect, it } from 'vitest';

import { WakeSubscription } from './wake-subscription';
import type { RequestUrlFn, RequestUrlResponseLike } from './sync-transport';

function ok(cursor: number): RequestUrlResponseLike {
  return { status: 200, json: { cursor } };
}

function baseOptions() {
  return {
    apiBaseUrl: 'https://host',
    vaultId: 'vault-1',
    getAuthToken: async () => 'tok',
    loadCursor: async () => 5,
  };
}

describe('WakeSubscription.resume', () => {
  it('abandons a pending backoff and re-polls immediately', async () => {
    // Call 0 throws → the loop enters backoff and parks. Nothing will release
    // that delay except resume(), so a second poll proves the resume worked.
    const calls: string[] = [];
    let parked = 0;
    let releaseParked: (() => void) | null = null;

    const fn: RequestUrlFn = async (options) => {
      calls.push(options.url);
      if (calls.length === 1) {
        throw new Error('simulated transport failure');
      }
      sub.stop();
      return ok(5);
    };

    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => undefined,
      scheduler: (callback) => {
        parked += 1;
        releaseParked = () => {
          parked -= 1;
          callback();
        };
        return () => {
          parked -= 1;
        };
      },
      random: () => 0,
    });

    sub.start();
    // Let the failing poll land and the backoff park. The loop awaits several
    // promises before it polls (loadCursor, getAuthToken), so drain the
    // microtask queue until the observable state arrives rather than guessing a
    // tick count.
    for (let i = 0; i < 50 && parked === 0; i += 1) {
      await Promise.resolve();
    }
    expect(calls).toHaveLength(1);
    expect(parked).toBe(1);

    sub.resume();
    await sub.whenStopped();

    // The second poll happened because resume() released the backoff, not
    // because the timer elapsed: nothing ever fired `releaseParked`.
    expect(calls).toHaveLength(2);
    expect(releaseParked).not.toBeNull();
  });

  it('is inert after stop: a resume starts nothing', async () => {
    const calls: string[] = [];
    const fn: RequestUrlFn = async (options) => {
      calls.push(options.url);
      return ok(5);
    };

    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => undefined,
      scheduler: (callback) => callback(),
    });

    sub.stop();
    sub.resume();
    await sub.whenStopped();

    expect(calls).toHaveLength(0);
  });

  it('does not start a loop that was never started', async () => {
    const calls: string[] = [];
    const fn: RequestUrlFn = async (options) => {
      calls.push(options.url);
      return ok(5);
    };

    const sub = new WakeSubscription({
      ...baseOptions(),
      requestUrl: fn,
      onWake: () => undefined,
      scheduler: (callback) => callback(),
    });

    // resume() is a re-arm, not an alternative entry point: without start()
    // there is no loop to wake.
    sub.resume();
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });
});
