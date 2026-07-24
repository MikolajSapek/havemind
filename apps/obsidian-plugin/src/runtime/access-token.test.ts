import { describe, expect, it } from 'vitest';

import { RefreshTokenAccessProvider } from './access-token';
import type { PendingRotation } from './access-token';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';

/**
 * The full, restart-surviving state a provider reads and writes: the stored
 * refresh token, the durable in-flight rotation record, and the monotonic
 * generators. A single `World` can be shared across two provider instances to
 * model a crash/restart between rotation attempts.
 */
interface World {
  refresh: string;
  savedRefresh: string[];
  pending: { record: PendingRotation | null };
  rotation: number;
  successor: number;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    refresh: 'hm_rt_current',
    savedRefresh: [],
    pending: { record: null },
    rotation: 0,
    successor: 0,
    ...overrides,
  };
}

function makeProvider(
  world: World,
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
  opts: { durable?: boolean; nowValues?: number[] } = {},
): { provider: RefreshTokenAccessProvider; calls: RequestUrlOptions[] } {
  const calls: RequestUrlOptions[] = [];
  const nowValues = opts.nowValues ?? [0, 0, 0];
  let nowIndex = 0;
  const durable = opts.durable
    ? {
        loadPendingRotation: async () => world.pending.record,
        savePendingRotation: async (record: PendingRotation) => {
          world.pending.record = record;
        },
        clearPendingRotation: async () => {
          world.pending.record = null;
        },
      }
    : {};
  const provider = new RefreshTokenAccessProvider({
    requestUrl: async (options) => {
      calls.push(options);
      return responder(options);
    },
    apiBaseUrl: API,
    getRefreshToken: async () => world.refresh,
    saveRefreshToken: async (value) => {
      world.refresh = value;
      world.savedRefresh.push(value);
    },
    generateRotationId: () => `rot-${(world.rotation += 1)}`,
    generateSuccessorToken: () => `hm_rt_next-${(world.successor += 1)}`,
    now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 0,
    ...durable,
  });
  return { provider, calls };
}

function build(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
  nowValues: number[] = [0, 0, 0],
): {
  provider: RefreshTokenAccessProvider;
  calls: RequestUrlOptions[];
  savedRefresh: string[];
} {
  const world = makeWorld();
  const { provider, calls } = makeProvider(world, responder, { nowValues });
  return { provider, calls, savedRefresh: world.savedRefresh };
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

  it('replays the identical rotation pair after a thrown transport, then commits on success', async () => {
    let attempt = 0;
    const { provider, calls, savedRefresh } = build(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('connection reset');
      }
      return refreshOk('2026-07-16T10:05:00.000Z');
    });
    await expect(provider.getAccessToken()).rejects.toThrow('connection reset');
    const token = await provider.getAccessToken();
    expect(token).toBe('access-1');
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]?.body ?? '{}');
    const second = JSON.parse(calls[1]?.body ?? '{}');
    // The successor family is only safe if the retry presents the SAME pair
    // against the SAME old refresh token — the server's exact-retry path.
    expect(second).toEqual(first);
    expect(first).toEqual({
      refreshToken: 'hm_rt_current',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next-1',
    });
    expect(savedRefresh).toEqual(['hm_rt_next-1']);
  });

  it('replays the identical rotation pair after a transient 5xx, then commits', async () => {
    let attempt = 0;
    const { provider, calls, savedRefresh } = build(() => {
      attempt += 1;
      if (attempt === 1) {
        return { status: 503, json: {} };
      }
      return refreshOk('2026-07-16T10:05:00.000Z');
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: false,
    });
    await provider.getAccessToken();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(
      JSON.parse(calls[0]?.body ?? '{}'),
    );
    expect(savedRefresh).toEqual(['hm_rt_next-1']);
  });

  it('serialises concurrent rotations into a single request', async () => {
    const { provider, calls } = build(() =>
      refreshOk('2026-07-16T10:05:00.000Z'),
    );
    const [a, b] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toBe('access-1');
    expect(b).toBe('access-1');
  });

  it('replays a durably persisted in-flight rotation after a restart', async () => {
    const world = makeWorld();
    const crashed = makeProvider(
      world,
      () => {
        throw new Error('killed mid-rotation');
      },
      { durable: true },
    );
    await expect(crashed.provider.getAccessToken()).rejects.toThrow(
      'killed mid-rotation',
    );
    // The in-flight pair survives the crash so the next process can replay it.
    expect(world.pending.record).toEqual({
      refreshToken: 'hm_rt_current',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next-1',
    });

    // A brand-new provider instance (restart) sharing the same durable store.
    const restarted = makeProvider(
      world,
      () => refreshOk('2026-07-16T10:05:00.000Z'),
      { durable: true },
    );
    const token = await restarted.provider.getAccessToken();
    expect(token).toBe('access-1');
    expect(JSON.parse(restarted.calls[0]?.body ?? '{}')).toEqual({
      refreshToken: 'hm_rt_current',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next-1',
    });
    expect(world.savedRefresh).toEqual(['hm_rt_next-1']);
    // Once committed, the in-flight record is cleared.
    expect(world.pending.record).toBeNull();
  });

  it('surfaces a genuine reuse detection (401) as authDenied and clears the in-flight record', async () => {
    const world = makeWorld();
    const { provider } = makeProvider(
      world,
      () => ({
        status: 401,
        json: { error: { code: 'REFRESH_REUSE_DETECTED' } },
      }),
      { durable: true },
    );
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      authDenied: true,
    });
    expect(world.savedRefresh).toEqual([]);
    expect(world.pending.record).toBeNull();
  });
});
