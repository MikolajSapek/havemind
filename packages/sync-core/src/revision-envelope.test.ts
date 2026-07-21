import { describe, expect, it } from 'vitest';

import {
  protectedRevisionHeaderSchema,
  validateRevisionPayloadAgainstHeader,
} from '@havemind/protocol';

import { decodeRevisionPayload } from './index';
import {
  buildRevisionEnvelope,
  RevisionPayloadTooLargeError,
} from './revision-envelope';

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  fileId: '22222222-2222-4222-8222-222222222222',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

const REVISION_A = '55555555-5555-4555-8555-555555555555';
const REVISION_B = '66666666-6666-4666-8666-666666666666';

function decodeBase64(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('buildRevisionEnvelope', () => {
  it('builds a root create whose payload decodes to the note content', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_A,
      parentRevisionIds: [],
      operation: 'create',
      path: 'Notes/a.md',
      content: 'Hello\n',
      idempotencyKey: 'op-1',
    });

    expect(envelope.revisionId).toBe(REVISION_A);
    expect(envelope.fileId).toBe(IDENTITY.fileId);
    expect(envelope.idempotencyKey).toBe('op-1');
    // Content hash is the SHA-256 of the exact payload bytes the server stores.
    expect(envelope.contentHash).toMatch(/^[0-9a-f]{64}$/u);

    // The opaque server validates the header; it must parse cleanly.
    expect(() =>
      protectedRevisionHeaderSchema.parse(envelope.header),
    ).not.toThrow();
    expect(envelope.header.vaultId).toBe(IDENTITY.vaultId);
    expect(envelope.header.expectedMemberId).toBe(IDENTITY.memberId);
    expect(envelope.header.expectedDeviceId).toBe(IDENTITY.deviceId);
    expect(envelope.header.parentRevisionIds).toEqual([]);

    // The peer decodes the payload bytes back into the note.
    const decoded = decodeRevisionPayload(decodeBase64(envelope.payloadBase64));
    expect(decoded).toEqual({
      operation: 'create',
      path: 'Notes/a.md',
      previousPath: null,
      kind: 'markdown',
      content: 'Hello\n',
      binaryContent: null,
    });
  });

  it('builds an update carrying its parent revision', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_B,
      parentRevisionIds: [REVISION_A],
      operation: 'update',
      path: 'Notes/a.md',
      content: 'Hello again\n',
      idempotencyKey: 'op-2',
    });

    expect(envelope.header.parentRevisionIds).toEqual([REVISION_A]);
    // header + payload are internally consistent for a non-root op.
    const payload = JSON.parse(decodeBase64(envelope.payloadBase64));
    expect(() =>
      validateRevisionPayloadAgainstHeader(envelope.header, payload),
    ).not.toThrow();
    expect(decodeRevisionPayload(decodeBase64(envelope.payloadBase64)).content).toBe(
      'Hello again\n',
    );
  });

  it('builds a delete tombstone with no content', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_B,
      parentRevisionIds: [REVISION_A],
      operation: 'delete',
      path: 'Notes/a.md',
      content: null,
      idempotencyKey: 'op-3',
    });

    const decoded = decodeRevisionPayload(decodeBase64(envelope.payloadBase64));
    expect(decoded.operation).toBe('delete');
    expect(decoded.content).toBeNull();
  });

  it('rejects an oversized payload with RevisionPayloadTooLargeError instead of building it', async () => {
    // A tiny explicit limit makes even a small note "too large", proving the
    // guard fires before the envelope (and therefore the outbox) is built.
    await expect(
      buildRevisionEnvelope({
        identity: IDENTITY,
        revisionId: REVISION_A,
        parentRevisionIds: [],
        operation: 'create',
        path: 'Notes/big.md',
        content: 'This note is larger than the tiny limit under test.\n',
        idempotencyKey: 'op-big',
        maxPayloadBytes: 16,
      }),
    ).rejects.toBeInstanceOf(RevisionPayloadTooLargeError);
  });

  it('handles empty content without an invalid empty literal recipe', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_A,
      parentRevisionIds: [],
      operation: 'create',
      path: 'Notes/empty.md',
      content: '',
      idempotencyKey: 'op-4',
    });
    const payload = JSON.parse(decodeBase64(envelope.payloadBase64));
    expect(() =>
      validateRevisionPayloadAgainstHeader(envelope.header, payload),
    ).not.toThrow();
  });
});
