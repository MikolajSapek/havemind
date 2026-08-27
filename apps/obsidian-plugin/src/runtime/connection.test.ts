import { describe, expect, it } from 'vitest';

import {
  BlobIntegrityError,
  buildConnectionResolvers,
  isConnectedOnboardingState,
} from './connection';
import type { RequestUrlOptions } from './sync-transport';
import type { RemoteEvent } from '../sync/sync-runner';

const API = 'https://host';
const VAULT = '11111111-1111-4111-8111-111111111111';

const payloadJson = JSON.stringify({
  schemaVersion: 1,
  operation: 'create',
  path: 'Notes/a.md',
  content: 'Remote body\n',
});

// The blob the client fetches is the exact envelope-bytes text the server
// stores; its content-addressed hash (the receipt `blobHash`, surfaced on the
// pull side as `revision.contentHash`) is `sha256Hex(payloadJson)`. Precomputed
// so a test locks the exact on-wire hash FORMAT (64-char lowercase hex, no
// prefix) the server and protocol use, see `hashBlob`/`sha256Hex`.
const PAYLOAD_JSON_SHA256 =
  'fd4f96b102b6b1c8b42dd7e187f9fababe548ae69b19a54e318781681dcb427b';

const event: RemoteEvent = {
  serverSequence: 4,
  revision: {
    revisionId: 'rev-1',
    fileId: 'file-1',
    contentHash: PAYLOAD_JSON_SHA256,
  },
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
    expect(calls[0]?.url).toBe(
      `${API}/vaults/${VAULT}/blobs/${PAYLOAD_JSON_SHA256}`,
    );
    expect(calls[0]?.headers?.Authorization).toBe('Bearer access-1');
  });

  it('rejects a blob whose bytes do not hash to the receipt blobHash, before decoding', async () => {
    // Server returns bytes that decode fine on their own but do NOT hash to the
    // expected blobHash, a corrupted / tampered / wrong-blob response.
    const tampered = payloadJson.replace('Remote body', 'Tampered body');
    let decodeReached = false;
    const { resolvers } = build((options) => {
      // The mismatch must be caught from the bytes alone; nothing downstream of
      // the hash check runs. A body that is itself valid JSON proves the guard
      // fires on the HASH, not on a decode failure.
      if (options.url.includes('/blobs/')) {
        return { status: 200, text: tampered };
      }
      decodeReached = true;
      return { status: 200, text: tampered };
    });

    const error = await resolvers
      .resolveRevision(event)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlobIntegrityError);
    // Marked permanent so the revision is quarantined/failed, never retried
    // forever, and never applied.
    expect((error as BlobIntegrityError).permanent).toBe(true);
    expect(decodeReached).toBe(false);
  });

  it('accepts a blob whose bytes hash to the receipt blobHash (happy path unchanged)', async () => {
    const { resolvers } = build(() => ({ status: 200, text: payloadJson }));
    await expect(resolvers.resolveRevision(event)).resolves.toMatchObject({
      operation: 'create',
      path: 'Notes/a.md',
    });
  });

  it('verifies against the exact on-wire hash format used by the protocol', async () => {
    // Locks the hash encoding: the receipt blobHash for these exact envelope
    // bytes is sha256Hex(bytes), 64-char lowercase hex, no prefix.
    const { resolvers } = build(() => ({ status: 200, text: payloadJson }));
    // Correct hash accepts.
    await expect(resolvers.resolveRevision(event)).resolves.toBeDefined();
    // Any other hex string of the right shape is rejected as a mismatch.
    const wrongHashEvent: RemoteEvent = {
      serverSequence: 5,
      revision: {
        revisionId: 'rev-2',
        fileId: 'file-1',
        contentHash: '0'.repeat(64),
      },
    };
    await expect(resolvers.resolveRevision(wrongHashEvent)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );
  });

  it('throws when the blob fetch is not successful', async () => {
    const { resolvers } = build(() => ({ status: 404, text: '' }));
    await expect(resolvers.resolveRevision(event)).rejects.toThrow();
  });
});
