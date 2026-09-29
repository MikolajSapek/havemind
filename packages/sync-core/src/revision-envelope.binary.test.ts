import { bytesToBase64, hashBlob } from '@havemind/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildRevisionEnvelope, binary', () => {
  it('encodes an attachment in slices, not one string character per byte', async () => {
    // Twice per attachment (its own base64 inside the payload, then the payload
    // for the wire), so a per-byte build costs a 25 MB file two blocked seconds
    // each on a laptop and far more on a phone.
    const fromCharCode = vi.spyOn(String, 'fromCharCode');

    await buildRevisionEnvelope({
      identity,
      revisionId,
      parentRevisionIds: [],
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/big.bin',
      content: null,
      binaryContentBase64: bytesToBase64(new Uint8Array(300_000)),
      idempotencyKey: 'idem-slices',
    });

    expect(fromCharCode.mock.calls.length).toBeLessThan(1000);
  });

  it('ships the attachment base64 it is given and encodes only the payload around it', async () => {
    // A caller that has read the file already holds its base64 (the observer's
    // `content`); decoding it and encoding it again is 25 MB and a second of
    // blocked thread spent on the same string.
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const contentBase64 = bytesToBase64(bytes);
    const btoaSpy = vi.spyOn(globalThis, 'btoa');

    const built = await buildRevisionEnvelope({
      identity,
      revisionId,
      parentRevisionIds: [],
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/big.bin',
      content: null,
      binaryContentBase64: contentBase64,
      idempotencyKey: 'idem-given',
    });

    const encodes = btoaSpy.mock.calls.length;
    btoaSpy.mockRestore();
    const payload = JSON.parse(
      new TextDecoder().decode(base64ToBytes(built.payloadBase64)),
    ) as { contentBase64: string; blobByteHash: string };
    expect(payload.contentBase64).toBe(contentBase64);
    expect(payload.blobByteHash).toBe(await hashBlob(bytes));
    expect(encodes).toBe(1); // the payload for the wire
  });

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
      binaryContentBase64: bytesToBase64(bytes),
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
      binaryContentBase64: bytesToBase64(bytes),
      idempotencyKey: 'idem-2',
    });

    const payloadJson = new TextDecoder().decode(
      base64ToBytes(built.payloadBase64),
    );
    const parsed = JSON.parse(payloadJson) as { blobByteHash: string };
    expect(parsed.blobByteHash).toBe(await hashBlob(bytes));
  });
});
