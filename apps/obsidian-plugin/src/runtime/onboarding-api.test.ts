import { describe, expect, it } from 'vitest';

import { RequestUrlOnboardingApi } from './onboarding-api';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

function fake(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
): { api: RequestUrlOnboardingApi; calls: RequestUrlOptions[] } {
  const calls: RequestUrlOptions[] = [];
  const api = new RequestUrlOnboardingApi({
    requestUrl: async (options) => {
      calls.push(options);
      return responder(options);
    },
  });
  return { api, calls };
}

const ok = (json: unknown): RequestUrlResponseLike => ({ status: 200, json });

describe('RequestUrlOnboardingApi', () => {
  it('performs discovery as a GET and echoes the requested URL as finalUrl', async () => {
    const { api, calls } = fake(() => ok({ service: 'havemind' }));
    const response = await api.discover({
      redirect: 'error',
      url: 'https://host/.well-known/havemind',
    });
    expect(response).toEqual({
      body: { service: 'havemind' },
      finalUrl: 'https://host/.well-known/havemind',
      status: 200,
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://host/.well-known/havemind');
  });

  it('reviews an invitation with a JSON body', async () => {
    const { api, calls } = fake(() => ok({ vaultName: 'Pilot' }));
    await api.reviewInvitation({
      invitationToken: 'hm_it_x',
      redirect: 'error',
      url: 'https://host/invitations/review',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      invitationToken: 'hm_it_x',
    });
  });

  it('redeems an invitation with the invitee-generated refresh token', async () => {
    const { api, calls } = fake(() => ok({ status: 'pending' }));
    await api.redeemInvitation({
      deviceLabel: 'MacBook',
      initialRefreshToken: 'hm_rt_x',
      invitationToken: 'hm_it_x',
      redemptionId: '11111111-1111-4111-8111-111111111111',
      redirect: 'error',
      url: 'https://host/invitations/redeem',
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      deviceLabel: 'MacBook',
      initialRefreshToken: 'hm_rt_x',
      invitationToken: 'hm_it_x',
      redemptionId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('polls approval with the pending credential in a header, never the URL', async () => {
    const { api, calls } = fake(() => ok({ status: 'pending' }));
    await api.pollApproval({
      pendingCredential: 'hm_pd_x',
      redirect: 'error',
      url: 'https://host/devices/dev/approval',
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers?.['x-havemind-pending-credential']).toBe('hm_pd_x');
    expect(calls[0]?.url).toBe('https://host/devices/dev/approval');
  });

  it('fetches a bootstrap page with a cursor query but a clean finalUrl', async () => {
    const { api, calls } = fake(() => ok({ complete: true, items: [] }));
    const response = await api.fetchBootstrapPage({
      cursor: '42',
      refreshToken: 'hm_rt_x',
      redirect: 'error',
      url: 'https://host/bootstrap',
    });
    expect(calls[0]?.url).toBe('https://host/bootstrap?cursor=42');
    expect(calls[0]?.headers?.['x-havemind-refresh-token']).toBe('hm_rt_x');
    expect(response.finalUrl).toBe('https://host/bootstrap');
  });

  it('omits the cursor query on the first bootstrap page', async () => {
    const { api, calls } = fake(() => ok({ complete: true, items: [] }));
    await api.fetchBootstrapPage({
      cursor: null,
      refreshToken: 'hm_rt_x',
      redirect: 'error',
      url: 'https://host/bootstrap',
    });
    expect(calls[0]?.url).toBe('https://host/bootstrap');
  });
});
