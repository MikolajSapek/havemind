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

  it('builds a valid payload for an empty note', async () => {
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

  it('carries the note text once: no reconstruction recipe repeats it', async () => {
    const line = 'A line of note text that is long enough to count.\n';
    const content = line.repeat(400);
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_A,
      parentRevisionIds: [],
      operation: 'create',
      path: 'Notes/long.md',
      content,
      idempotencyKey: 'op-once',
    });

    const json = decodeBase64(envelope.payloadBase64);
    expect(Object.keys(JSON.parse(json))).toEqual([
      'schemaVersion',
      'operation',
      'path',
      'content',
      'plaintextHash',
    ]);
    // The payload is the text (as JSON) plus a small fixed envelope, not twice
    // the text.
    expect(Buffer.byteLength(json)).toBeLessThan(
      Buffer.byteLength(JSON.stringify(content)) + 512,
    );
  });

  it.each([
    ['a rename', { operation: 'rename', path: 'Notes/b.md', previousPath: 'Notes/a.md', content: 'Hello\n' }],
    ['a tombstone', { operation: 'delete', path: 'Notes/a.md', content: null }],
    ['an attachment', { operation: 'update', kind: 'binary', path: 'Attachments/pic.png', content: null, binaryContent: new Uint8Array([1, 2, 3]) }],
  ] as const)('writes no recipe into %s', async (_name, change) => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: REVISION_B,
      parentRevisionIds: [REVISION_A],
      idempotencyKey: 'op-one-parent',
      ...change,
    });

    expect(JSON.parse(decodeBase64(envelope.payloadBase64))).not.toHaveProperty(
      'recipe',
    );
  });
});

// Two devices that merge the same two heads must write the same bytes: the
// client recognises "the same merge" by the hash of the payload
// (`retireEquivalentMerges`, `reconcileHeads`). A device on release 1.5.7 or
// older still writes a `recipe`, so a payload with two or more parents keeps
// writing one, byte for byte as those releases did. The literals below are the
// output of the 1.5.7 encoder (packages/sync-core/src/revision-envelope.ts at
// that tag) for the same input.
describe('buildRevisionEnvelope, a payload with two parents', () => {
  const MERGE_PARENTS = [REVISION_A, REVISION_B];
  const MERGE_REVISION = '77777777-7777-4777-8777-777777777777';

  it.each([
    [
      'a note',
      { operation: 'update', content: 'ALPHA\nmiddle\nOMEGA\n' },
      '{"schemaVersion":1,"operation":"update","path":"Notes/a.md","content":"ALPHA\\nmiddle\\nOMEGA\\n","plaintextHash":"a673b54c629a6aeb58b1701841d60a7f24d04b0a3c80cc9eaf476ab439420106","recipe":{"version":1,"parts":[{"type":"literal","text":"ALPHA\\nmiddle\\nOMEGA\\n"}]}}',
      '6ae6076b5124aaffbb5a68de9c948cf4a1627577b8dd0d3cf7310d48766bcd6f',
    ],
    [
      'an empty note',
      { operation: 'update', content: '' },
      '{"schemaVersion":1,"operation":"update","path":"Notes/a.md","content":"","plaintextHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","recipe":{"version":1,"parts":[]}}',
      'f36172e15f6692a260357cafe7448ea55824b300b171fe9aa68e3e474e13a4cf',
    ],
    [
      'a tombstone',
      { operation: 'delete', content: null },
      '{"schemaVersion":1,"operation":"delete","path":"Notes/a.md","content":null,"plaintextHash":null,"recipe":null}',
      'bcf4cad89d528299aeea3a7fe6f88a224784aeac43ebffd83051d082394d2af1',
    ],
  ] as const)('is byte-identical to the 1.5.7 payload for %s', async (_name, change, expectedJson, expectedHash) => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: MERGE_REVISION,
      parentRevisionIds: MERGE_PARENTS,
      path: 'Notes/a.md',
      idempotencyKey: 'op-merge',
      ...change,
    });

    expect(decodeBase64(envelope.payloadBase64)).toBe(expectedJson);
    expect(envelope.contentHash).toBe(expectedHash);
  });

  it('is byte-identical to the 1.5.7 payload for an attachment', async () => {
    const envelope = await buildRevisionEnvelope({
      identity: IDENTITY,
      revisionId: MERGE_REVISION,
      parentRevisionIds: MERGE_PARENTS,
      operation: 'update',
      kind: 'binary',
      path: 'Attachments/pic.png',
      content: null,
      binaryContent: new Uint8Array([1, 2, 3]),
      idempotencyKey: 'op-merge-binary',
    });

    expect(decodeBase64(envelope.payloadBase64)).toBe(
      '{"schemaVersion":1,"operation":"update","kind":"binary","path":"Attachments/pic.png","contentBase64":"AQID","blobByteHash":"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81","recipe":null}',
    );
  });
});
