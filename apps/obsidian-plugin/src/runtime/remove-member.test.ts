import { describe, expect, it } from 'vitest';

import { RevokeMembershipError, revokeMembership } from './remove-member';
import type { RequestUrlFn, RequestUrlResponseLike } from './sync-transport';

const API = 'https://sync.example.test';
const MEMBERSHIP = 'membership-magda';

function fakeRequestUrl(response: RequestUrlResponseLike): {
  fn: RequestUrlFn;
  calls: Array<{ url: string; method: string | undefined; headers: unknown }>;
} {
  const calls: Array<{
    url: string;
    method: string | undefined;
    headers: unknown;
  }> = [];
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

describe('revokeMembership (owner)', () => {
  it('posts to the member revoke endpoint with a bearer token and reports removed', async () => {
    const { calls, fn } = fakeRequestUrl({
      status: 200,
      json: { status: 'revoked', membershipId: MEMBERSHIP },
    });
    const result = await revokeMembership({
      apiBaseUrl: API,
      getAccessToken: async () => 'owner-access',
      membershipId: MEMBERSHIP,
      requestUrl: fn,
    });
    expect(result).toEqual({ status: 'removed', membershipId: MEMBERSHIP });
    expect(calls[0]?.url).toBe(
      `${API}/owner/memberships/${MEMBERSHIP}/revoke`,
    );
    expect(calls[0]?.method).toBe('POST');
    expect(
      (calls[0]?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer owner-access');
  });

  it('throws with the HTTP status when the caller is not the owner', async () => {
    const { fn } = fakeRequestUrl({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    });
    await expect(
      revokeMembership({
        apiBaseUrl: API,
        getAccessToken: async () => 'editor-access',
        membershipId: MEMBERSHIP,
        requestUrl: fn,
      }),
    ).rejects.toBeInstanceOf(RevokeMembershipError);
  });
});
