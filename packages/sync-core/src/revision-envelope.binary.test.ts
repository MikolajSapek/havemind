import { hashBlob } from '@havemind/protocol';
import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from './payload-codec.js';
import { buildRevisionEnvelope } from './revision-envelope.js';

const identity = {
  vaultId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  memberId: '00000000-0000-4000-8000-000000000005',
  deviceId: '00000000-0000-4000-8000-000000000006',
};
const revisionId = '00000000-0000-4000-8000-000000000003';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe('buildRevisionEnvelope — binary', () => {
  it('round-trips raw bytes exactly through encode → decode', async () => {
    const bytes = new Uint8Array([0x00, 0x10, 0xff, 0x80, 0x7f, 0x00, 0xab]);

    const built = await buildRevisionEnvelope({
      identity,
      revisionId,
      parentRevisionIds: [],
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/pic.png',
      content: null,
      binaryContent: bytes,
      idempotencyKey: 'idem-1',
    });

    // The pushed blob is the JSON payload; the peer decodes it back to bytes.
    const payloadJson = new TextDecoder().decode(
      base64ToBytes(built.payloadBase64),
    );
    const decoded = decodeRevisionPayload(payloadJson);

    expect(decoded.kind).toBe('binary');
    expect(decoded.binaryContent).toEqual(bytes);
  });

  it('carries a raw-byte hash (no canonicalisation) in the payload', async () => {
    const bytes = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]); // CRLFs: must NOT be normalised
    const built = await buildRevisionEnvelope({
      identity,
      revisionId,
      parentRevisionIds: [],
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/x.bin',
      content: null,
      binaryContent: bytes,
      idempotencyKey: 'idem-2',
    });

    const payloadJson = new TextDecoder().decode(
      base64ToBytes(built.payloadBase64),
    );
    const parsed = JSON.parse(payloadJson) as { blobByteHash: string };
    expect(parsed.blobByteHash).toBe(await hashBlob(bytes));
  });
});
