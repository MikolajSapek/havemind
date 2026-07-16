import { describe, expect, it } from 'vitest';

import { RefreshTokenAccessProvider } from './access-token';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';

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
});
