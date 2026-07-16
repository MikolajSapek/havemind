/**
 * Builds the `SyncConnection` resolvers a connected vault needs to drive the
 * sync runtime (`buildSyncController`): the vault identity, an auth-token
 * provider, a fileId→path resolver and a remote-content fetcher.
 *
 * `resolveRemoteContent` reads the opaque payload back from the server's
 * byte-exact blob endpoint (`GET /vaults/:vaultId/blobs/:blobHash`). In the
 * pilot the payload is plaintext, so the raw response text is the file content.
 * A fileId with no known local path resolves to `null`; `VaultApplyAdapter`
 * then skips the write rather than guessing a path (rule 4).
 */

import type { RemoteEvent } from '../sync/sync-runner';
import type { RequestUrlFn } from './sync-transport';

export function isConnectedOnboardingState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { phase?: unknown }).phase === 'connected'
  );
}

export interface ConnectionResolverOptions {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAccessToken: () => Promise<string>;
  readonly requestUrl: RequestUrlFn;
  readonly knownPath: (fileId: string) => string | null;
}

export interface ConnectionResolvers {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly pathForFileId: (fileId: string) => string | null;
  readonly resolveRemoteContent: (event: RemoteEvent) => Promise<string>;
}

export class BlobFetchError extends Error {
  override readonly name = 'BlobFetchError';
}

export function buildConnectionResolvers(
  options: ConnectionResolverOptions,
): ConnectionResolvers {
  return {
    apiBaseUrl: options.apiBaseUrl,
    vaultId: options.vaultId,
    getAuthToken: options.getAccessToken,
    pathForFileId: options.knownPath,
    resolveRemoteContent: async (event: RemoteEvent) => {
      const token = await options.getAccessToken();
      const response = await options.requestUrl({
        url: `${options.apiBaseUrl}/vaults/${options.vaultId}/blobs/${event.revision.contentHash}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new BlobFetchError(
          `Blob fetch for ${event.revision.contentHash} returned HTTP ${response.status}.`,
        );
      }
      return response.text ?? '';
    },
  };
}
