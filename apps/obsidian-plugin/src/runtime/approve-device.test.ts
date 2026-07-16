import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { approveRedeemedDevice, ApproveDeviceError } from './approve-device';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';
const VAULT = '11111111-1111-4111-8111-111111111111';
const INVITATION = '22222222-2222-4222-8222-222222222222';
const PHRASE = 'brave amber otter';

function build(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
  overrides?: { verificationPhrase?: string; invitationId?: string },
): {
  calls: RequestUrlOptions[];
  run: () => ReturnType<typeof approveRedeemedDevice>;
} {
  const calls: RequestUrlOptions[] = [];
  return {
    calls,
    run: () =>
      approveRedeemedDevice({
        requestUrl: async (options) => {
          calls.push(options);
          return responder(options);
        },
        apiBaseUrl: API,
        vaultId: VAULT,
        invitationId: overrides?.invitationId ?? INVITATION,
        verificationPhrase: overrides?.verificationPhrase ?? PHRASE,
        getAccessToken: async () => 'access-1',
      }),
  };
}

const OK_BODY = {
  deviceId: '33333333-3333-4333-8333-333333333333',
  membershipId: '44444444-4444-4444-8444-444444444444',
  status: 'approved',
  userId: '55555555-5555-4555-8555-555555555555',
};

describe('approveRedeemedDevice', () => {
  it('posts the phrase to the approve route with a bearer token and returns the device', async () => {
    const { calls, run } = build(() => ({ status: 200, json: OK_BODY }));

    const result = await run();

    expect(result).toEqual({
      deviceId: OK_BODY.deviceId,
      membershipId: OK_BODY.membershipId,
      userId: OK_BODY.userId,
      status: 'approved',
    });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(
      `${API}/vaults/${VAULT}/invitations/${INVITATION}/approve`,
    );
    expect(call?.headers?.Authorization).toBe('Bearer access-1');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      verificationPhrase: PHRASE,
    });
  });

  it('rejects a mismatched phrase with a helpful, secret-free message', async () => {
    const { run } = build(() => ({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    }));

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApproveDeviceError);
    expect((error as ApproveDeviceError).message).not.toContain(PHRASE);
  });

  it('throws when the approve response is malformed', async () => {
    const { run } = build(() => ({ status: 200, json: { status: 'approved' } }));
    await expect(run()).rejects.toBeInstanceOf(ApproveDeviceError);
  });

  it('never leaks the verification phrase into the request URL or thrown errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (phrase) => {
          const { calls, run } = build(
            () => ({ status: 410, json: { error: { code: 'GONE' } } }),
            { verificationPhrase: phrase },
          );
          const error = await run().catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(ApproveDeviceError);
          // A fixed template, never the phrase interpolated in — so the secret
          // cannot leak regardless of what the joining device chose.
          expect((error as Error).message).toBe(
            'This invitation has expired. Create a new one.',
          );
          // The URL is a fixed template that never interpolates the phrase, so
          // it cannot leak the secret regardless of what the joining device
          // chose. (A `.not.toContain(phrase)` assertion here is unsound: for
          // short/common phrases like "n" it can coincidentally match a
          // substring of the fixed path, e.g. "invitations".)
          expect(calls[0]?.url).toBe(
            `${API}/vaults/${VAULT}/invitations/${INVITATION}/approve`,
          );
          expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
            verificationPhrase: phrase,
          });
        },
      ),
    );
  });
});
