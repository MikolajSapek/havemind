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

describe('isConnectedOnboardingState', () => {
  it('is true only for the connected phase', () => {
    expect(isConnectedOnboardingState({ phase: 'connected' })).toBe(true);
    expect(isConnectedOnboardingState({ phase: 'bootstrapping' })).toBe(false);
    expect(isConnectedOnboardingState(null)).toBe(false);
    expect(isConnectedOnboardingState({})).toBe(false);
  });
});

describe('buildConnectionResolvers', () => {
  function build(): { resolvers: ReturnType<typeof buildConnectionResolvers>; calls: RequestUrlOptions[] } {
    const calls: RequestUrlOptions[] = [];
    const resolvers = buildConnectionResolvers({
      apiBaseUrl: API,
      vaultId: VAULT,
      getAccessToken: async () => 'access-1',
      requestUrl: async (options) => {
        calls.push(options);
        return { status: 200, json: null, text: 'remote body' };
      },
      knownPath: (fileId) => (fileId === 'file-1' ? 'Notes/a.md' : null),
    });
    return { resolvers, calls };
  }

  it('exposes the connected vault identity and auth token', async () => {
    const { resolvers } = build();
    expect(resolvers.apiBaseUrl).toBe(API);
    expect(resolvers.vaultId).toBe(VAULT);
    expect(await resolvers.getAuthToken()).toBe('access-1');
  });

  it('maps a known fileId to its path and an unknown one to null', () => {
    const { resolvers } = build();
    expect(resolvers.pathForFileId('file-1')).toBe('Notes/a.md');
    expect(resolvers.pathForFileId('file-x')).toBeNull();
  });

  it('fetches remote content by blob hash with a bearer token', async () => {
    const { resolvers, calls } = build();
    const content = await resolvers.resolveRemoteContent(event);
    expect(content).toBe('remote body');
    expect(calls[0]?.url).toBe(`${API}/vaults/${VAULT}/blobs/blob-abc`);
    expect(calls[0]?.headers?.Authorization).toBe('Bearer access-1');
  });

  it('throws when the blob fetch is not successful', async () => {
    const resolvers = buildConnectionResolvers({
      apiBaseUrl: API,
      vaultId: VAULT,
      getAccessToken: async () => 'access-1',
      requestUrl: async () => ({ status: 404, json: null, text: '' }),
      knownPath: () => null,
    });
    await expect(resolvers.resolveRemoteContent(event)).rejects.toThrow();
  });
});
