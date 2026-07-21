import { describe, expect, it } from 'vitest';

import {
  buildConnectionResolvers,
  isConnectedOnboardingState,
} from './connection';
import type { RequestUrlOptions } from './sync-transport';
import type { RemoteEvent } from '../sync/sync-runner';

const API = 'https://host';
const VAULT = '11111111-1111-4111-8111-111111111111';

const event: RemoteEvent = {
  serverSequence: 4,
  revision: { revisionId: 'rev-1', fileId: 'file-1', contentHash: 'blob-abc' },
};

const payloadJson = JSON.stringify({
  schemaVersion: 1,
  operation: 'create',
  path: 'Notes/a.md',
  content: 'Remote body\n',
});

describe('isConnectedOnboardingState', () => {
  it('is true only for the connected phase', () => {
    expect(isConnectedOnboardingState({ phase: 'connected' })).toBe(true);
    expect(isConnectedOnboardingState({ phase: 'bootstrapping' })).toBe(false);
    expect(isConnectedOnboardingState(null)).toBe(false);
    expect(isConnectedOnboardingState({})).toBe(false);
  });
});

describe('buildConnectionResolvers', () => {
  function build(
    responder: (o: RequestUrlOptions) => { status: number; text: string },
  ): { resolvers: ReturnType<typeof buildConnectionResolvers>; calls: RequestUrlOptions[] } {
    const calls: RequestUrlOptions[] = [];
    const resolvers = buildConnectionResolvers({
      apiBaseUrl: API,
      vaultId: VAULT,
      getAccessToken: async () => 'access-1',
      requestUrl: async (options) => {
        calls.push(options);
        const { status, text } = responder(options);
        return { status, json: null, text };
      },
    });
    return { resolvers, calls };
  }

  it('exposes the connected vault identity and auth token', async () => {
    const { resolvers } = build(() => ({ status: 200, text: payloadJson }));
    expect(resolvers.apiBaseUrl).toBe(API);
    expect(resolvers.vaultId).toBe(VAULT);
    expect(await resolvers.getAuthToken()).toBe('access-1');
  });

  it('fetches the blob by hash and decodes it to a revision payload', async () => {
    const { resolvers, calls } = build(() => ({ status: 200, text: payloadJson }));
    const decoded = await resolvers.resolveRevision(event);
    expect(decoded).toEqual({
      operation: 'create',
      path: 'Notes/a.md',
      previousPath: null,
      kind: 'markdown',
      content: 'Remote body\n',
      binaryContent: null,
    });
    expect(calls[0]?.url).toBe(`${API}/vaults/${VAULT}/blobs/blob-abc`);
    expect(calls[0]?.headers?.Authorization).toBe('Bearer access-1');
  });

  it('throws when the blob fetch is not successful', async () => {
    const { resolvers } = build(() => ({ status: 404, text: '' }));
    await expect(resolvers.resolveRevision(event)).rejects.toThrow();
  });
});
