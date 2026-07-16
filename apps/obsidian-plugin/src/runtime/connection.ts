/**
 * Builds the resolvers a connected vault needs to drive the sync runtime:
 * the vault identity, an auth-token provider and a remote-revision resolver.
 *
 * `resolveRevision` reads the opaque payload back from the server's byte-exact
 * blob endpoint (`GET /vaults/:vaultId/blobs/:blobHash`) and decodes it with
 * `@havemind/sync-core` into the operation + canonical path + content the vault
 * adapter materializes. The server stays opaque — it only returns bytes; the
 * client alone decodes them.
 */

import { decodeRevisionPayload, type DecodedRevisionPayload } from '@havemind/sync-core';

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
}

export interface ConnectionResolvers {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
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
    resolveRevision: async (event: RemoteEvent) => {
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
      return decodeRevisionPayload(response.text ?? '');
    },
  };
}
