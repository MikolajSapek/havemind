import { describe, expect, it } from 'vitest';

import { createVaultInvitation } from './create-invitation';
import { parseInviteEnvelope } from '../onboarding/invite';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';
const ORIGIN = 'https://host';
const VAULT = '11111111-1111-4111-8111-111111111111';
const INVITATION_TOKEN = `hm_it_${'A'.repeat(43)}`;

function build(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
): { calls: RequestUrlOptions[]; run: () => ReturnType<typeof createVaultInvitation> } {
  const calls: RequestUrlOptions[] = [];
  return {
    calls,
    run: () =>
      createVaultInvitation({
        requestUrl: async (options) => {
          calls.push(options);
          return responder(options);
        },
        apiBaseUrl: API,
        serverOrigin: ORIGIN,
        vaultId: VAULT,
        getAccessToken: async () => 'access-1',
        intendedRole: 'editor',
        intendedMemberDisplayName: 'Friend',
      }),
  };
}

describe('createVaultInvitation', () => {
  it('posts an owner invitation and returns a copyable envelope', async () => {
    const { calls, run } = build(() => ({
      status: 200,
      json: {
        invitationId: '22222222-2222-4222-8222-222222222222',
        invitationToken: INVITATION_TOKEN,
        intendedMemberId: '33333333-3333-4333-8333-333333333333',
        intendedMemberDisplayName: 'Friend',
        expiresAt: '2026-07-16T10:15:00.000Z',
      },
    }));

    const result = await run();

    expect(result.expiresAt).toBe('2026-07-16T10:15:00.000Z');
    expect(result.invitationId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.envelope.startsWith('v1.')).toBe(true);
    const parsed = parseInviteEnvelope(result.envelope);
    expect(parsed.serverOrigin).toBe(ORIGIN);
    expect(parsed.invitationToken).toBe(INVITATION_TOKEN);

    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${API}/vaults/${VAULT}/invitations`);
    expect(call?.headers?.Authorization).toBe('Bearer access-1');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      intendedRole: 'editor',
      intendedMemberDisplayName: 'Friend',
    });
  });

  it('throws on a non-2xx response', async () => {
    const { run } = build(() => ({ status: 403, json: { error: { code: 'FORBIDDEN' } } }));
    await expect(run()).rejects.toThrow();
  });

  it('throws when the response token is malformed', async () => {
    const { run } = build(() => ({
      status: 200,
      json: { invitationToken: 'not-a-token', expiresAt: '2026-07-16T10:15:00.000Z' },
    }));
    await expect(run()).rejects.toThrow();
  });
});
