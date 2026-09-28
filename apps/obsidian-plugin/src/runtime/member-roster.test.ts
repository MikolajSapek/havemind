import { describe, expect, it } from 'vitest';

import {
  LegacyRosterServerError,
  fetchMemberRoster,
  fetchVaultMembers,
} from './member-roster';
import type { RequestUrlFn, RequestUrlResponseLike } from './sync-transport';

const API = 'https://sync.example.test';
const VAULT = '11111111-2222-3333-4444-555555555555';

function fakeRequestUrl(response: RequestUrlResponseLike): {
  fn: RequestUrlFn;
  calls: Array<{ url: string; method: string; headers: unknown }>;
} {
  const calls: Array<{ url: string; method: string; headers: unknown }> = [];
  const fn: RequestUrlFn = async (options) => {
    calls.push({
      headers: options.headers,
      method: options.method,
      url: options.url,
    });
    return response;
  };
  return { calls, fn };
}

describe('fetchMemberRoster', () => {
  it('reads GET /members with the refresh-token header and marks the local member as self', async () => {
    const { calls, fn } = fakeRequestUrl({
      status: 200,
      json: {
        members: [
          { membershipId: 'm-owner', displayName: 'Mikolaj', role: 'owner' },
          { membershipId: 'm-magda', displayName: 'Magda', role: 'editor' },
        ],
        version: 1,
      },
    });

    const members = await fetchMemberRoster({
      apiBaseUrl: API,
      getRefreshToken: async () => 'hm_rt_secret',
      requestUrl: fn,
      selfMembershipId: 'm-magda',
      vaultId: VAULT,
    });

    expect(members).toEqual([
      {
        membershipId: 'm-owner',
        displayName: 'Mikolaj',
        role: 'owner',
        self: false,
      },
      {
        membershipId: 'm-magda',
        displayName: 'You',
        role: 'editor',
        self: true,
      },
    ]);
    expect(calls[0]?.url).toBe(`${API}/members?vault=${VAULT}`);
    expect(calls[0]?.method).toBe('GET');
    expect(
      (calls[0]?.headers as Record<string, string>)['x-havemind-refresh-token'],
    ).toBe('hm_rt_secret');
    // The secret never leaks into the URL.
    expect(calls[0]?.url).not.toContain('hm_rt_');
  });

  it('omits the vault query when the caller has no vault id', async () => {
    const { calls, fn } = fakeRequestUrl({
      status: 200,
      json: { members: [], version: 1 },
    });
    await fetchMemberRoster({
      apiBaseUrl: API,
      getRefreshToken: async () => 'hm_rt_secret',
      requestUrl: fn,
      selfMembershipId: null,
      vaultId: null,
    });
    expect(calls[0]?.url).toBe(`${API}/members`);
  });

  it('throws on a non-2xx response so the caller keeps its previous roster', async () => {
    const { fn } = fakeRequestUrl({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    });
    await expect(
      fetchMemberRoster({
        apiBaseUrl: API,
        getRefreshToken: async () => 'hm_rt_secret',
        requestUrl: fn,
        selfMembershipId: null,
        vaultId: VAULT,
      }),
    ).rejects.toThrow(/403/);
  });

  it('throws when the payload is malformed rather than rendering a blank roster', async () => {
    const { fn } = fakeRequestUrl({ status: 200, json: { version: 1 } });
    await expect(
      fetchMemberRoster({
        apiBaseUrl: API,
        getRefreshToken: async () => 'hm_rt_secret',
        requestUrl: fn,
        selfMembershipId: null,
        vaultId: VAULT,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it('rejects a member row with an unknown role', async () => {
    const { fn } = fakeRequestUrl({
      status: 200,
      json: {
        members: [{ membershipId: 'm-1', displayName: 'X', role: 'admin' }],
        version: 1,
      },
    });
    await expect(
      fetchMemberRoster({
        apiBaseUrl: API,
        getRefreshToken: async () => 'hm_rt_secret',
        requestUrl: fn,
        selfMembershipId: null,
        vaultId: VAULT,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it('throws when no refresh token is stored', async () => {
    const { calls, fn } = fakeRequestUrl({
      status: 200,
      json: { members: [], version: 1 },
    });
    await expect(
      fetchMemberRoster({
        apiBaseUrl: API,
        getRefreshToken: async () => null,
        requestUrl: fn,
        selfMembershipId: null,
        vaultId: VAULT,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// B4: the refresh-token read raced the sync loop's own rotation and got 401
// at every start. The access-token route of the live connection avoids it.
describe('fetchVaultMembers', () => {
  it('reads the vault roster with the access token, owner first', async () => {
    const { calls, fn } = fakeRequestUrl({
      status: 200,
      json: {
        members: [
          { membershipId: 'm-magda', displayName: 'Magda', role: 'editor' },
          { membershipId: 'm-owner', displayName: 'Mikolaj', role: 'owner' },
        ],
        quotaBytes: 1,
        role: 'editor',
        storageBytes: 0,
        vaultId: VAULT,
      },
    });

    const members = await fetchVaultMembers({
      apiBaseUrl: API,
      getAccessToken: async () => 'hm_at_secret',
      requestUrl: fn,
      selfMembershipId: 'm-magda',
      vaultId: VAULT,
    });

    expect(members.map((member) => member.displayName)).toEqual(['Mikolaj', 'You']);
    expect(calls[0]?.url).toBe(`${API}/vaults/${VAULT}/members`);
    expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer hm_at_secret' });
  });

  it('reports a server that predates membership ids as legacy', async () => {
    const { fn } = fakeRequestUrl({
      status: 200,
      json: { members: [{ displayName: 'Magda', role: 'editor' }] },
    });

    await expect(
      fetchVaultMembers({
        apiBaseUrl: API,
        getAccessToken: async () => 'hm_at_secret',
        requestUrl: fn,
        selfMembershipId: null,
        vaultId: VAULT,
      }),
    ).rejects.toBeInstanceOf(LegacyRosterServerError);
  });
});
