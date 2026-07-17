import { describe, expect, it } from 'vitest';

import {
  RequestUrlTransport,
  RequestUrlTransportError,
  type RequestUrlOptions,
  type RequestUrlResponseLike,
  type TransportEnvelope,
} from './sync-transport';
import type { PushRevision } from '../sync/sync-runner';

const API = 'https://vault.example.ts.net';
const VAULT = '11111111-1111-4111-8111-111111111111';

function fakeRequestUrl(
  responder: (options: RequestUrlOptions) => RequestUrlResponseLike,
): { fn: (o: RequestUrlOptions) => Promise<RequestUrlResponseLike>; calls: RequestUrlOptions[] } {
  const calls: RequestUrlOptions[] = [];
  return {
    calls,
    fn: async (options) => {
      calls.push(options);
      return responder(options);
    },
  };
}

const envelope: TransportEnvelope = {
  header: { revisionId: 'rev-1' },
  idempotencyKey: 'idem-1',
  payloadBase64: 'AAAA',
};

const pushRevision: PushRevision = {
  revisionId: 'rev-1',
  fileId: 'file-1',
  contentHash: 'hash-1',
};

function build(
  responder: (options: RequestUrlOptions) => RequestUrlResponseLike,
  resolve: (id: string) => TransportEnvelope | undefined = () => envelope,
  identity?: { vaultId: string; memberId: string; deviceId: string },
): { transport: RequestUrlTransport; calls: RequestUrlOptions[] } {
  const { fn, calls } = fakeRequestUrl(responder);
  const transport = new RequestUrlTransport({
    requestUrl: fn,
    apiBaseUrl: API,
    vaultId: VAULT,
    getAuthToken: async () => 'tok-abc',
    resolveEnvelope: resolve,
    ...(identity === undefined ? {} : { identity }),
  });
  return { transport, calls };
}

describe('RequestUrlTransport', () => {
  it('pushes the resolved envelope with a bearer token and no redirects', async () => {
    const { transport, calls } = build(() => ({
      status: 200,
      json: {
        results: [
          {
            revisionId: 'rev-1',
            status: 'accepted',
            receipt: { revisionId: 'rev-1', serverSequence: 9 },
          },
        ],
      },
    }));

    const results = await transport.push([pushRevision]);

    expect(results).toEqual([
      {
        revisionId: 'rev-1',
        outcome: 'accepted',
        receipt: { revisionId: 'rev-1', serverSequence: 9 },
      },
    ]);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${API}/vaults/${VAULT}/revisions`);
    expect(call?.headers?.Authorization).toBe('Bearer tok-abc');
    expect(call?.throw).toBe(false);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      revisions: [
        { header: { revisionId: 'rev-1' }, idempotencyKey: 'idem-1', payload: 'AAAA' },
      ],
    });
  });

  it('restamps every outbound header with the current connection identity, overriding a stale enqueue-time identity', async () => {
    // Regression: a revision enqueued by a prior-session observer (or replayed
    // from a frozen outbox header) carries the OLD memberId/deviceId. The server
    // 403s the whole request on an identity mismatch, so the transport must
    // re-stamp the current connection identity onto every outbound header (rule
    // 3: every outbound revision carries the current actor identity).
    const staleEnvelope: TransportEnvelope = {
      header: {
        revisionId: 'rev-1',
        vaultId: 'stale-vault',
        expectedMemberId: 'stale-member',
        expectedDeviceId: 'stale-device',
        fileId: 'file-1',
      },
      idempotencyKey: 'idem-1',
      payloadBase64: 'AAAA',
    };
    const identity = {
      vaultId: VAULT,
      memberId: 'current-member',
      deviceId: 'current-device',
    };
    const { transport, calls } = build(
      () => ({
        status: 200,
        json: {
          results: [
            {
              revisionId: 'rev-1',
              status: 'accepted',
              receipt: { revisionId: 'rev-1', serverSequence: 1 },
            },
          ],
        },
      }),
      () => staleEnvelope,
      identity,
    );

    await transport.push([pushRevision]);

    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      revisions: Array<{ header: Record<string, unknown> }>;
    };
    const header = body.revisions[0]?.header;
    expect(header?.vaultId).toBe(VAULT);
    expect(header?.expectedMemberId).toBe('current-member');
    expect(header?.expectedDeviceId).toBe('current-device');
    // Non-identity fields are preserved untouched.
    expect(header?.revisionId).toBe('rev-1');
    expect(header?.fileId).toBe('file-1');
  });

  it('flags a whole-request 403 as permanent so the runner quarantines the offender instead of looping forever', async () => {
    const { transport } = build(() => ({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    }));
    await expect(transport.push([pushRevision])).rejects.toMatchObject({
      permanent: true,
      authDenied: false,
    });
  });

  it('throws a transport error when a push envelope cannot be resolved', async () => {
    const { transport } = build(
      () => ({ status: 200, json: { results: [] } }),
      () => undefined,
    );
    await expect(transport.push([pushRevision])).rejects.toBeInstanceOf(
      RequestUrlTransportError,
    );
  });

  it('throws a transient (non-permanent) error on a 5xx so the runner backs off', async () => {
    const { transport } = build(() => ({
      status: 503,
      json: { error: { code: 'INTERNAL' } },
    }));
    await expect(transport.push([pushRevision])).rejects.toMatchObject({
      name: 'RequestUrlTransportError',
      authDenied: false,
      permanent: false,
    });
  });

  it('flags a whole-request 4xx (413/422/400) as permanent so the runner quarantines it', async () => {
    for (const status of [400, 413, 422]) {
      const { transport } = build(() => ({
        status,
        json: { error: { code: 'INVALID_BATCH' } },
      }));
      await expect(transport.push([pushRevision])).rejects.toMatchObject({
        permanent: true,
        authDenied: false,
      });
    }
  });

  it('classifies a per-revision rejection: permanent for a poison code, transient otherwise', async () => {
    const permanent = build(() => ({
      status: 200,
      json: { results: [{ revisionId: 'rev-1', status: 'rejected', code: 'REVISION_ID_REUSE' }] },
    }));
    const transient = build(() => ({
      status: 200,
      json: { results: [{ revisionId: 'rev-1', status: 'rejected', code: 'HEAD_SET_CHANGED' }] },
    }));

    expect(await permanent.transport.push([pushRevision])).toEqual([
      { revisionId: 'rev-1', outcome: 'rejected', permanent: true },
    ]);
    expect(await transient.transport.push([pushRevision])).toEqual([
      { revisionId: 'rev-1', outcome: 'rejected', permanent: false },
    ]);
  });

  it('pulls ordered remote events shaped for the runner', async () => {
    const { transport, calls } = build(() => ({
      status: 200,
      json: {
        cursor: 12,
        events: [
          {
            type: 'revision-accepted',
            revisionId: 'rev-2',
            fileId: 'file-2',
            serverSequence: 12,
            receipt: { blobHash: 'blob-2', serverSequence: 12 },
          },
        ],
      },
    }));

    const result = await transport.pull(5);

    expect(result.cursor).toBe(12);
    expect(result.events).toEqual([
      {
        serverSequence: 12,
        revision: { revisionId: 'rev-2', fileId: 'file-2', contentHash: 'blob-2' },
      },
    ]);
    const call = calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`${API}/vaults/${VAULT}/events?after=5`);
  });

  it('throws on a malformed pull body', async () => {
    const { transport } = build(() => ({ status: 200, json: { cursor: 'x' } }));
    await expect(transport.pull(0)).rejects.toBeInstanceOf(
      RequestUrlTransportError,
    );
  });
});
