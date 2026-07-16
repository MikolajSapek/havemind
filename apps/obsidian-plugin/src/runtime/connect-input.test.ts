import { describe, expect, it } from 'vitest';

import {
  classifyConnectInput,
  pairOwnerDevice,
} from './connect-input';
import type {
  RequestUrlOptions,
  RequestUrlResponseLike,
} from './sync-transport';

const API = 'https://host';
const VAULT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

describe('classifyConnectInput', () => {
  it('recognises an owner pairing token', () => {
    expect(classifyConnectInput('hm_pt_ABC')).toBe('pairing');
    expect(classifyConnectInput('  hm_pt_ABC  ')).toBe('pairing');
  });

  it('recognises an invitation envelope', () => {
    expect(classifyConnectInput('v1.ABC')).toBe('envelope');
  });

  it('rejects anything else as unknown', () => {
    expect(classifyConnectInput('hello')).toBe('unknown');
    expect(classifyConnectInput('')).toBe('unknown');
    expect(classifyConnectInput('hm_it_ABC')).toBe('unknown');
  });
});

function fake(
  responder: (o: RequestUrlOptions) => RequestUrlResponseLike,
): { calls: RequestUrlOptions[]; run: () => ReturnType<typeof pairOwnerDevice> } {
  const calls: RequestUrlOptions[] = [];
  return {
    calls,
    run: () =>
      pairOwnerDevice({
        requestUrl: async (options) => {
          calls.push(options);
          return responder(options);
        },
        apiBaseUrl: API,
        deviceLabel: 'Owner Mac',
        initialRefreshTokenHash: 'a'.repeat(64),
        pairingToken: 'hm_pt_x',
      }),
  };
}

describe('pairOwnerDevice', () => {
  it('posts the pairing token and returns the vault and device id', async () => {
    const { calls, run } = fake(() => ({
      status: 200,
      json: { vaultId: VAULT, deviceId: DEVICE, accessExpiresAt: 'x' },
    }));
    const result = await run();
    expect(result).toEqual({ vaultId: VAULT, deviceId: DEVICE });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${API}/owner/pair`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      deviceLabel: 'Owner Mac',
      initialRefreshTokenHash: 'a'.repeat(64),
      pairingToken: 'hm_pt_x',
    });
  });

  it('throws on a non-2xx pairing response', async () => {
    const { run } = fake(() => ({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } }));
    await expect(run()).rejects.toThrow();
  });

  it('throws when the response is malformed', async () => {
    const { run } = fake(() => ({ status: 200, json: { vaultId: VAULT } }));
    await expect(run()).rejects.toThrow();
  });
});
