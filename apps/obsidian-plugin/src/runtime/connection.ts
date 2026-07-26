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

import { sha256Hex } from '@havemind/protocol';
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

/**
 * The downloaded blob bytes did not hash to the `blobHash` the receipt/revision
 * promised. The server is opaque and does NOT re-hash on read (a deliberate
 * read-hot-path perf choice — see `apps/server/src/blob-store.ts`), so the
 * CLIENT is the only party that can detect corrupted, tampered, or wrong-blob
 * responses. The bytes are rejected BEFORE decode, so bad content is never
 * materialised into the vault.
 *
 * `permanent` marks this as a per-item failure the same bytes will never
 * satisfy: it must be quarantined/dead-lettered rather than retried forever
 * (mirrors the `permanent` contract on the push path — see `isPermanentError`
 * in `sync/sync-runner.ts`).
 */
export class BlobIntegrityError extends Error {
  override readonly name = 'BlobIntegrityError';
  readonly permanent = true;
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `Blob for ${expectedHash} failed integrity verification: downloaded bytes hash to ${actualHash}.`,
    );
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
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
      const body = response.text ?? '';
      // Integrity gate: the server is opaque and never re-hashes on read, so the
      // client must verify the downloaded bytes hash to the expected blobHash
      // (`revision.contentHash`, the receipt's content-addressed hash) BEFORE
      // decoding or applying them. `sha256Hex` is the exact helper the protocol
      // and server use to derive that hash (UTF-8 bytes → 64-char lowercase hex),
      // so a corrupted, tampered, or wrong-blob response is caught here instead
      // of being silently materialised into the vault.
      const actualHash = await sha256Hex(body);
      if (actualHash !== event.revision.contentHash) {
        throw new BlobIntegrityError(event.revision.contentHash, actualHash);
      }
      return decodeRevisionPayload(body);
    },
  };
}
