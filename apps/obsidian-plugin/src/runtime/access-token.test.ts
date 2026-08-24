import { describe, expect, it, vi } from 'vitest';

import { RefreshTokenAccessProvider } from './access-token';
import type { PendingRotation } from './access-token';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';

/**
 * A backing store shared across provider instances so a "process restart"
 * mid-rotation can be simulated: create a fresh provider over the same backing
 * and it sees the persisted refresh token and in-flight rotation record.
 */
interface Backing {
  refresh: string;
  pending: PendingRotation | null;
}

function makeBacking(refresh = 'hm_rt_current'): Backing {
  return { refresh, pending: null };
}

function makeProvider(options: {
  backing: Backing;
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike;
  calls?: RequestUrlOptions[];
  savedRefresh?: string[];
  // When true, saveRefreshToken throws — models a crash after the server's 200
  // but before the successor is committed locally.
  crashOnSave?: boolean;
  // When true, the durable pending-rotation store throws on every op — models a
  // SecretStorage outage. Production must fail before it sends a rotation that
  // could not survive a crash/restart.
  storeUnavailable?: 'load' | 'save' | 'clear';
  now?: () => number;
}): RefreshTokenAccessProvider {
  const {
    backing,
    responder,
    calls,
    savedRefresh,
    crashOnSave,
    storeUnavailable,
    now,
  } = options;
  let rotation = 0;
  let successor = 0;
  return new RefreshTokenAccessProvider({
    requestUrl: async (o) => {
      calls?.push(o);
      return responder(o);
    },
    apiBaseUrl: API,
    getRefreshToken: async () => backing.refresh,
    saveRefreshToken: async (value) => {
      if (crashOnSave === true) {
        throw new Error('simulated crash before commit');
      }
      backing.refresh = value;
      savedRefresh?.push(value);
    },
    generateRotationId: () => `rot-${(rotation += 1)}`,
    generateSuccessorToken: () => `hm_rt_next-${(successor += 1)}`,
    loadPendingRotation: async () => {
      if (storeUnavailable === 'load') {
        throw new Error('SecretStorage unavailable');
      }
      return backing.pending;
    },
    savePendingRotation: async (record) => {
      if (storeUnavailable === 'save') {
        throw new Error('SecretStorage unavailable');
      }
      backing.pending = record;
    },
    clearPendingRotation: async () => {
      if (storeUnavailable === 'clear') {
        throw new Error('SecretStorage unavailable');
      }
      backing.pending = null;
    },
    now: now ?? (() => 0),
  });
}

function build(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
  nowValues: number[] = [0, 0, 0],
): {
  provider: RefreshTokenAccessProvider;
  calls: RequestUrlOptions[];
  savedRefresh: string[];
} {
  const calls: RequestUrlOptions[] = [];
  const savedRefresh: string[] = [];
  let refresh = 'hm_rt_current';
  let rotation = 0;
  let successor = 0;
  let nowIndex = 0;
  const provider = new RefreshTokenAccessProvider({
    requestUrl: async (options) => {
      calls.push(options);
      return responder(options);
    },
    apiBaseUrl: API,
    getRefreshToken: async () => refresh,
    saveRefreshToken: async (value) => {
      refresh = value;
      savedRefresh.push(value);
    },
    generateRotationId: () => `rot-${(rotation += 1)}`,
    generateSuccessorToken: () => `hm_rt_next-${(successor += 1)}`,
    now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 0,
  });
  return { provider, calls, savedRefresh };
}

const refreshOk = (expiresAt: string): RequestUrlResponseLike => ({
  status: 200,
  json: { accessToken: 'access-1', accessExpiresAt: expiresAt },
});

describe('RefreshTokenAccessProvider', () => {
  it('rotates the refresh token and returns the fresh access token', async () => {
    const { provider, calls, savedRefresh } = build(() =>
      refreshOk('2026-07-16T10:05:00.000Z'),
    );
    const token = await provider.getAccessToken();
    expect(token).toBe('access-1');
    expect(calls[0]?.url).toBe(`${API}/auth/refresh`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      refreshToken: 'hm_rt_current',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next-1',
    });
    expect(savedRefresh).toEqual(['hm_rt_next-1']);
  });

  it('caches the access token until it nears expiry', async () => {
    const expiry = Date.parse('2026-07-16T10:05:00.000Z');
    const { provider, calls } = build(
      () => refreshOk('2026-07-16T10:05:00.000Z'),
      [0, 0, expiry - 1000, expiry],
    );
    await provider.getAccessToken();
    await provider.getAccessToken(); // still fresh → cached, no new call
    expect(calls).toHaveLength(1);
  });

  it('marks a 401 as auth-denied (terminal) and keeps the refresh token', async () => {
    const { provider, savedRefresh } = build(() => ({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED' } },
    }));
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: true,
    });
    expect(savedRefresh).toEqual([]);
  });

  it('treats a 5xx as transient (not auth-denied) so the loop keeps retrying', async () => {
    const { provider } = build(() => ({ status: 503, json: {} }));
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: false,
    });
  });

  it('shares one in-flight rotation across concurrent callers (single-flight)', async () => {
    const { provider, calls } = build(() =>
      refreshOk('2026-07-16T10:05:00.000Z'),
    );
    const [a, b] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    // Both callers saw the token expired but only ONE /auth/refresh fires, so
    // the same refresh token is never rotated twice in parallel.
    expect(calls).toHaveLength(1);
    expect(a).toBe('access-1');
    expect(b).toBe('access-1');
  });

  it('allows a fresh rotation after the in-flight one settles', async () => {
    const expiry = Date.parse('2026-07-16T10:05:00.000Z');
    const { provider, calls } = build(
      () => refreshOk('2026-07-16T10:05:00.000Z'),
      // now() is only read on a cache hit; the first call skips it (empty cache),
      // the second reads expiry → past skew → rotates again.
      [expiry, expiry],
    );
    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it('replays the identical {rotationId, successor} after an interrupted rotation and commits on retry (GAP-5)', async () => {
    // Attempt 1: the server commits (200) but the client crashes before it can
    // persist the successor locally — modelled by saveRefreshToken throwing.
    const backing = makeBacking('hm_rt_current');
    const calls1: RequestUrlOptions[] = [];
    const crashed = makeProvider({
      backing,
      responder: () => refreshOk('2026-07-24T10:05:00.000Z'),
      calls: calls1,
      crashOnSave: true,
    });
    await expect(crashed.getAccessToken()).rejects.toThrow();

    // The old refresh token is untouched and the in-flight record persisted.
    expect(backing.refresh).toBe('hm_rt_current');
    expect(backing.pending).not.toBeNull();
    const firstBody = JSON.parse(calls1[0]?.body ?? '{}');

    // Attempt 2: a fresh provider (simulated restart) over the same backing must
    // REPLAY the identical rotationId + successor — not mint a new pair — so the
    // server's exact-retry guard forgives it instead of burning the family.
    const calls2: RequestUrlOptions[] = [];
    const savedRefresh: string[] = [];
    const restarted = makeProvider({
      backing,
      responder: () => refreshOk('2026-07-24T10:05:00.000Z'),
      calls: calls2,
      savedRefresh,
    });
    const token = await restarted.getAccessToken();
    const secondBody = JSON.parse(calls2[0]?.body ?? '{}');

    expect(secondBody.rotationId).toBe(firstBody.rotationId);
    expect(secondBody.successorRefreshToken).toBe(
      firstBody.successorRefreshToken,
    );
    expect(secondBody.refreshToken).toBe('hm_rt_current');
    expect(token).toBe('access-1');
    // A confirmed 200 commits the successor and clears the in-flight record.
    expect(savedRefresh).toEqual([firstBody.successorRefreshToken]);
    expect(backing.refresh).toBe(firstBody.successorRefreshToken);
    expect(backing.pending).toBeNull();
  });

  it('never replays a stale pending record whose refreshToken does not match the current token', async () => {
    // A leftover record bound to an OLD token (e.g. after the user reconnected
    // with a fresh credential) must be ignored, not replayed against the new one.
    const backing = makeBacking('hm_rt_new');
    backing.pending = {
      refreshToken: 'hm_rt_OLD_stale',
      rotationId: 'rot-STALE',
      successorRefreshToken: 'hm_rt_STALE_successor',
    };
    const calls: RequestUrlOptions[] = [];
    const provider = makeProvider({
      backing,
      responder: () => refreshOk('2026-07-24T10:05:00.000Z'),
      calls,
    });
    await provider.getAccessToken();
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.refreshToken).toBe('hm_rt_new');
    expect(body.rotationId).not.toBe('rot-STALE');
    expect(body.successorRefreshToken).not.toBe('hm_rt_STALE_successor');
  });

  it('surfaces a terminal 401 as authDenied, clears the in-flight record, and keeps the refresh token', async () => {
    const backing = makeBacking('hm_rt_current');
    const savedRefresh: string[] = [];
    const provider = makeProvider({
      backing,
      responder: () => ({ status: 401, json: { error: { code: 'REUSE' } } }),
      savedRefresh,
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: true,
    });
    // Not masked, refresh token untouched, and the dead in-flight record dropped.
    expect(savedRefresh).toEqual([]);
    expect(backing.refresh).toBe('hm_rt_current');
    expect(backing.pending).toBeNull();
  });

  it('keeps the in-flight record on a transient 5xx so the next attempt replays it', async () => {
    const backing = makeBacking('hm_rt_current');
    let status = 503;
    const calls: RequestUrlOptions[] = [];
    const provider = makeProvider({
      backing,
      responder: () =>
        status >= 500
          ? { status, json: {} }
          : refreshOk('2026-07-24T10:05:00.000Z'),
      calls,
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: false,
    });
    expect(backing.pending).not.toBeNull();
    const firstBody = JSON.parse(calls[0]?.body ?? '{}');

    // Recover: same in-process provider retries and replays the identical pair.
    status = 200;
    await provider.getAccessToken();
    const secondBody = JSON.parse(calls[1]?.body ?? '{}');
    expect(secondBody.rotationId).toBe(firstBody.rotationId);
    expect(secondBody.successorRefreshToken).toBe(
      firstBody.successorRefreshToken,
    );
  });

  it('fails closed before sending a refresh when pending rotation cannot be persisted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const backing = makeBacking('hm_rt_current');
      const calls: RequestUrlOptions[] = [];
      const savedRefresh: string[] = [];
      const provider = makeProvider({
        backing,
        responder: () => refreshOk('2026-07-24T10:05:00.000Z'),
        calls,
        savedRefresh,
        storeUnavailable: 'save',
      });
      await expect(provider.getAccessToken()).rejects.toThrow(
        'Could not persist refresh rotation safely.',
      );
      // Sending after a failed durable write burns the old token on success and
      // makes a restart unrecoverable. The request must therefore not happen.
      expect(calls).toHaveLength(0);
      expect(savedRefresh).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        'Havemind: pending-rotation save failed.',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
