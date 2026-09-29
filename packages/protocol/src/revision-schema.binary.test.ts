import { describe, expect, it } from 'vitest';

import {
  innerRevisionPayloadSchema,
  validateRevisionPayloadAgainstHeader,
} from './revision-schema.js';

const vaultId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const revisionId = '00000000-0000-4000-8000-000000000003';
const parentRevisionId = '00000000-0000-4000-8000-000000000004';
const memberId = '00000000-0000-4000-8000-000000000005';
const deviceId = '00000000-0000-4000-8000-000000000006';
const byteHash = 'b'.repeat(64);

const semantics = {
  payloadFormat: 'revision-payload-v1',
  syncSemantics: 'dag-cas-v1',
  provenanceRecipe: 'source-range-v1',
  pathNormalization: 'nfc-lowercase-v1',
} as const;

function header(parentRevisionIds: readonly string[]) {
  return {
    protocol: { major: 1, minor: 0 },
    vaultId,
    fileId,
    revisionId,
    parentRevisionIds,
    expectedMemberId: memberId,
    expectedDeviceId: deviceId,
    payloadEncoding: 'plaintext-json-v1',
    semantics,
  } as const;
}

describe('innerRevisionPayloadSchema, binary variant', () => {
  it('parses a binary create payload with base64 content and a raw-byte hash', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/pic.png',
      contentBase64: 'AAEC/w==',
      blobByteHash: byteHash,
    };

    const parsed = innerRevisionPayloadSchema.parse(payload);

    expect(parsed).toMatchObject({ kind: 'binary', operation: 'create' });
  });

  it('parses a binary rename carrying previousPath', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'rename',
      kind: 'binary',
      path: 'Attachments/new.pdf',
      previousPath: 'Attachments/old.pdf',
      contentBase64: '',
      blobByteHash: byteHash,
    };

    expect(() => innerRevisionPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rejects a binary payload whose contentBase64 is not valid base64', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/pic.png',
      contentBase64: 'not base64!!',
      blobByteHash: byteHash,
    };

    expect(() => innerRevisionPayloadSchema.parse(payload)).toThrow();
  });

  it('rejects a binary payload carrying a field the schema does not define', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/pic.png',
      contentBase64: 'AAA=',
      blobByteHash: byteHash,
      extra: 'not part of the format',
    };

    expect(() => innerRevisionPayloadSchema.parse(payload)).toThrow();
  });
});

describe('validateRevisionPayloadAgainstHeader, binary', () => {
  it('accepts a binary create with no parents', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'create',
      kind: 'binary',
      path: 'Attachments/pic.png',
      contentBase64: 'AAEC/w==',
      blobByteHash: byteHash,
    };

    const result = validateRevisionPayloadAgainstHeader(header([]), payload);

    expect(result.payload).toMatchObject({ kind: 'binary' });
  });

  it('accepts a binary update parented on a prior revision', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'update',
      kind: 'binary',
      path: 'Attachments/pic.png',
      contentBase64: 'AAEC/w==',
      blobByteHash: byteHash,
    };

    expect(() =>
      validateRevisionPayloadAgainstHeader(header([parentRevisionId]), payload),
    ).not.toThrow();
  });

  it('still validates a legacy markdown payload that carries no kind field', () => {
    const payload = {
      schemaVersion: 1,
      operation: 'create',
      path: 'Notes/a.md',
      content: 'Hello\n',
      plaintextHash: 'a'.repeat(64),
    };

    expect(() =>
      validateRevisionPayloadAgainstHeader(header([]), payload),
    ).not.toThrow();
  });
});
