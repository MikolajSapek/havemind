/**
 * The largest attachment the plugin accepts must fit in one push the server
 * accepts.
 *
 * A 25 MiB file passed every plugin check and became a 44.4 MiB request
 * against a 40 MiB server limit: the file is base64-encoded inside the
 * revision payload, and the payload is base64-encoded again for transport.
 * The server answered 413 and the change sat in quarantine for good. The
 * limits live in three packages, so only a test that builds the real request
 * keeps them in agreement.
 */

import { describe, expect, it } from 'vitest';

import { MAX_BINARY_FILE_BYTES } from '../apps/obsidian-plugin/src/obsidian/vault-adapter';
import { MAX_BINARY_PAYLOAD_BYTES } from '../apps/obsidian-plugin/src/sync/outbox-repository';
import { DEFAULT_BODY_LIMIT_BYTES } from '../apps/server/src/config.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../apps/server/src/sync/sync-routes.js';
import { buildRevisionEnvelope } from '../packages/sync-core/src/revision-envelope.js';

describe('attachment size limits', () => {
  it('fits the largest accepted attachment into one accepted push', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: {
        vaultId: '70000000-0000-4000-8000-0000000000a3',
        fileId: '70000000-0000-4000-8000-0000000000a5',
        memberId: '70000000-0000-4000-8000-0000000000a4',
        deviceId: '70000000-0000-4000-8000-0000000000a2',
      },
      revisionId: '70000000-0000-4000-8000-000000000001',
      parentRevisionIds: [],
      operation: 'create',
      path: 'attachments/largest-allowed.pdf',
      kind: 'binary',
      content: null,
      binaryContent: new Uint8Array(MAX_BINARY_FILE_BYTES),
      idempotencyKey: 'largest-allowed',
      maxPayloadBytes: MAX_BINARY_PAYLOAD_BYTES,
    });

    const payloadBytes = Buffer.from(envelope.payloadBase64, 'base64').byteLength;
    expect(payloadBytes).toBeLessThanOrEqual(DEFAULT_MAX_PAYLOAD_BYTES);

    // The request body exactly as runtime/sync-transport.ts push() sends it.
    const body = JSON.stringify({
      revisions: [
        {
          header: envelope.header,
          idempotencyKey: envelope.idempotencyKey,
          payload: envelope.payloadBase64,
        },
      ],
    });
    expect(body.length).toBeLessThanOrEqual(DEFAULT_BODY_LIMIT_BYTES);
  }, 60_000);
});
