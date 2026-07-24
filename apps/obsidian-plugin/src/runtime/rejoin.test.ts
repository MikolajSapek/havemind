import { describe, expect, it, vi } from 'vitest';

import {
  RejoinController,
  RejoinRequestError,
  requestRejoinGrant,
} from './rejoin';
import type { RequestUrlFn, RequestUrlResponseLike } from './sync-transport';

const API = 'https://sync.example.test';
const MEMBERSHIP = 'membership-magda';
const DEVICE = 'device-magda';
const VAULT = 'vault-1';

function fakeRequestUrl(
  responses: readonly RequestUrlResponseLike[],
): { fn: RequestUrlFn; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const fn: RequestUrlFn = async (options) => {
    calls.push({
      url: options.url,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response ?? { status: 500, json: null };
  };
  return { calls, fn };
}

describe('requestRejoinGrant (owner)', () => {
  it('posts to the grant endpoint with a bearer token and reports waiting', async () => {
    const { calls, fn } = fakeRequestUrl([
      { status: 200, json: { status: 'granted', boundDeviceId: DEVICE } },
    ]);
    const result = await requestRejoinGrant({
      apiBaseUrl: API,
      getAccessToken: async () => 'owner-access',
      membershipId: MEMBERSHIP,
      requestUrl: fn,
    });
    expect(result).toEqual({
      status: 'waiting',
      membershipId: MEMBERSHIP,
      boundDeviceId: DEVICE,
    });
    expect(calls[0]?.url).toBe(`${API}/owner/rejoin-grants`);
    expect(calls[0]?.body).toEqual({ membershipId: MEMBERSHIP });
  });

  it('throws with the HTTP status when the owner is not authorised', async () => {
    const { fn } = fakeRequestUrl([{ status: 403, json: { error: { code: 'FORBIDDEN' } } }]);
    await expect(
      requestRejoinGrant({
        apiBaseUrl: API,
        getAccessToken: async () => 'editor-access',
        membershipId: MEMBERSHIP,
        requestUrl: fn,
      }),
    ).rejects.toBeInstanceOf(RejoinRequestError);
  });
});

describe('RejoinController (invitee)', () => {
  function makeController(
    responses: readonly RequestUrlResponseLike[],
    saveRefreshToken = vi.fn(async () => undefined),
  ): {
    controller: RejoinController;
    saveRefreshToken: ReturnType<typeof vi.fn>;
    calls: Array<{ url: string; body: unknown }>;
  } {
    const { calls, fn } = fakeRequestUrl(responses);
    const controller = new RejoinController({
      apiBaseUrl: API,
      deviceId: DEVICE,
      generateRefreshToken: () => 'hm_rt_fresh',
      hashRefreshToken: (token) => `hash(${token})`,
      membershipId: MEMBERSHIP,
      requestUrl: fn,
      saveRefreshToken,
    });
    return { calls, controller, saveRefreshToken };
  }

  it('starts in the terminal-auth state', () => {
    const { controller } = makeController([]);
    expect(controller.getState()).toBe('terminal-auth');
  });

  it('transitions terminal-auth → syncing on a successful redemption and stores the token', async () => {
    const { calls, controller, saveRefreshToken } = makeController([
      {
        status: 200,
        json: { status: 'rejoined', membershipId: MEMBERSHIP, vaultId: VAULT, deviceId: DEVICE },
      },
    ]);
    const result = await controller.attempt();
    expect(result).toEqual({ status: 'syncing', membershipId: MEMBERSHIP, vaultId: VAULT });
    expect(controller.getState()).toBe('syncing');
    expect(saveRefreshToken).toHaveBeenCalledWith('hm_rt_fresh');
    // Presents the persisted binding; only the hash of the refresh token is sent.
    expect(calls[0]?.url).toBe(`${API}/auth/rejoin`);
    expect(calls[0]?.body).toEqual({
      deviceId: DEVICE,
      initialRefreshTokenHash: 'hash(hm_rt_fresh)',
      membershipId: MEMBERSHIP,
    });
  });

  it('stays terminal-auth (for the next poll) when no grant exists yet', async () => {
    const { controller, saveRefreshToken } = makeController([{ status: 401, json: null }]);
    const result = await controller.attempt();
    expect(result).toBe('terminal-auth');
    expect(controller.getState()).toBe('terminal-auth');
    expect(saveRefreshToken).not.toHaveBeenCalled();
  });

  it('can succeed on a later poll after earlier attempts found no grant', async () => {
    const { controller } = makeController([
      { status: 401, json: null },
      {
        status: 200,
        json: { status: 'rejoined', membershipId: MEMBERSHIP, vaultId: VAULT },
      },
    ]);
    expect(await controller.attempt()).toBe('terminal-auth');
    const second = await controller.attempt();
    expect(second).toEqual({ status: 'syncing', membershipId: MEMBERSHIP, vaultId: VAULT });
  });

  it('marks rejoin-failed (surfaced, never a frozen rejoining) when the post-200 token save throws (FIX C1)', async () => {
    // The grant is single-use and burned server-side on the 200. If persisting
    // the fresh refresh token throws (SecretStorage/keychain write can fail) the
    // controller must transition to the SURFACED terminal state, not escape with
    // the state frozen at 'rejoining' (a permanent, invisible wedge).
    const saveRefreshToken = vi.fn(async () => {
      throw new Error('SecretStorage write failed');
    });
    const { controller } = makeController(
      [
        {
          status: 200,
          json: { status: 'rejoined', membershipId: MEMBERSHIP, vaultId: VAULT },
        },
      ],
      saveRefreshToken,
    );
    const result = await controller.attempt();
    expect(result).toBe('rejoin-failed');
    expect(controller.getState()).toBe('rejoin-failed');
    expect(saveRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('marks rejoin-failed on a 200 with an unusable body', async () => {
    const { controller, saveRefreshToken } = makeController([{ status: 200, json: { status: 'rejoined' } }]);
    const result = await controller.attempt();
    expect(result).toBe('rejoin-failed');
    expect(controller.getState()).toBe('rejoin-failed');
    expect(saveRefreshToken).not.toHaveBeenCalled();
  });

  it('is a no-op once already syncing (never fires a second redemption)', async () => {
    const { calls, controller } = makeController([
      { status: 200, json: { membershipId: MEMBERSHIP, vaultId: VAULT } },
    ]);
    await controller.attempt();
    const again = await controller.attempt();
    expect(again).toBe('syncing');
    expect(calls).toHaveLength(1);
  });
});
