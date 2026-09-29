import { describe, expect, it } from 'vitest';

import {
  innerRevisionPayloadSchema,
  opaqueBlobReceiptSchema,
  protectedRevisionHeaderSchema,
  requiredSemanticsSchema,
  validateRevisionPayloadAgainstHeader,
} from './revision-schema.js';

const vaultId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const revisionId = '00000000-0000-4000-8000-000000000003';
const parentRevisionId = '00000000-0000-4000-8000-000000000004';
const memberId = '00000000-0000-4000-8000-000000000005';
const deviceId = '00000000-0000-4000-8000-000000000006';
const laterParentId = '00000000-0000-4000-8000-000000000007';
const hash = 'a'.repeat(64);

const semantics = {
  payloadFormat: 'revision-payload-v1',
  syncSemantics: 'dag-cas-v1',
  provenanceRecipe: 'source-range-v1',
  pathNormalization: 'nfc-lowercase-v1',
} as const;

const protectedHeader = {
  protocol: { major: 1, minor: 0 },
  vaultId,
  fileId,
  revisionId,
  parentRevisionIds: [parentRevisionId],
  expectedMemberId: memberId,
  expectedDeviceId: deviceId,
  payloadEncoding: 'plaintext-json-v1',
  semantics,
} as const;

const updatePayload = {
  schemaVersion: 1,
  operation: 'update',
  path: 'Notes/Plan.md',
  content: '# Plan\n updated',
  plaintextHash: hash,
} as const;

describe('revision-schema', () => {
  it('validates required sync semantics independently', () => {
    expect(requiredSemanticsSchema.parse(semantics)).toEqual(semantics);
    expect(
      requiredSemanticsSchema.safeParse({
        ...semantics,
        provenanceRecipe: undefined,
      }).success,
    ).toBe(false);
  });

  it('accepts a strict protected client header', () => {
    expect(protectedRevisionHeaderSchema.parse(protectedHeader)).toEqual(
      protectedHeader,
    );
  });

  it.each(['serverSequence', 'serverTime', 'blobHash', 'byteLength', 'memberId'])(
    'rejects receipt-only field %s in the protected client header',
    (field) => {
      expect(
        protectedRevisionHeaderSchema.safeParse({
          ...protectedHeader,
          [field]: field === 'serverSequence' ? 1 : 'forbidden',
        }).success,
      ).toBe(false);
    },
  );

  it('rejects duplicate, self-referential and unsorted parents', () => {
    expect(
      protectedRevisionHeaderSchema.safeParse({
        ...protectedHeader,
        parentRevisionIds: [parentRevisionId, parentRevisionId],
      }).success,
    ).toBe(false);
    expect(
      protectedRevisionHeaderSchema.safeParse({
        ...protectedHeader,
        parentRevisionIds: [revisionId],
      }).success,
    ).toBe(false);
    expect(
      protectedRevisionHeaderSchema.safeParse({
        ...protectedHeader,
        parentRevisionIds: [laterParentId, parentRevisionId],
      }).success,
    ).toBe(false);
  });

  it('does not claim an unspecified encrypted payload format in protocol v1', () => {
    expect(
      protectedRevisionHeaderSchema.safeParse({
        ...protectedHeader,
        payloadEncoding: 'opaque-bytes-v1',
      }).success,
    ).toBe(false);
  });

  it('validates the server receipt independently from protected input', () => {
    const receipt = opaqueBlobReceiptSchema.parse({
      revisionId,
      memberId,
      deviceId,
      serverSequence: 12,
      serverTime: '2026-07-15T12:34:56.000Z',
      blobHash: hash,
      byteLength: 42,
    });

    expect(receipt.serverSequence).toBe(12);
  });

  it('relays the revision parents on the receipt so apply can prove causal fast-forward', () => {
    const receipt = opaqueBlobReceiptSchema.parse({
      revisionId,
      memberId,
      deviceId,
      serverSequence: 12,
      serverTime: '2026-07-15T12:34:56.000Z',
      blobHash: hash,
      byteLength: 42,
      parentRevisionIds: [parentRevisionId],
    });

    expect(receipt.parentRevisionIds).toEqual([parentRevisionId]);
  });

  it('accepts a legacy receipt with no parents (backward compatible)', () => {
    const receipt = opaqueBlobReceiptSchema.parse({
      revisionId,
      memberId,
      deviceId,
      serverSequence: 12,
      serverTime: '2026-07-15T12:34:56.000Z',
      blobHash: hash,
      byteLength: 42,
    });

    expect(receipt.parentRevisionIds).toBeUndefined();
  });

  it('validates a normalized Markdown snapshot', () => {
    const payload = innerRevisionPayloadSchema.parse(updatePayload);
    expect(payload.operation).toBe('update');
    expect(
      validateRevisionPayloadAgainstHeader(protectedHeader, updatePayload),
    ).toEqual({ header: protectedHeader, payload: updatePayload });
  });

  it('enforces operation parent counts and rename path semantics', () => {
    const rootHeader = { ...protectedHeader, parentRevisionIds: [] };

    expect(
      validateRevisionPayloadAgainstHeader(rootHeader, {
        ...updatePayload,
        operation: 'create',
        content: '# New\n',
      }).payload.operation,
    ).toBe('create');
    expect(
      validateRevisionPayloadAgainstHeader(rootHeader, {
        ...updatePayload,
        operation: 'initial-import',
        content: '# New\n',
      }).payload.operation,
    ).toBe('initial-import');
    expect(() =>
      validateRevisionPayloadAgainstHeader(rootHeader, updatePayload),
    ).toThrow(/parent/i);
    expect(() =>
      validateRevisionPayloadAgainstHeader(protectedHeader, {
        ...updatePayload,
        operation: 'rename',
      }),
    ).toThrow(/previousPath/i);
    expect(() =>
      validateRevisionPayloadAgainstHeader(protectedHeader, {
        ...updatePayload,
        operation: 'rename',
        previousPath: updatePayload.path,
      }),
    ).toThrow(/different/i);
  });

  it('rejects non-normalized Markdown and malformed tombstones', () => {
    expect(
      innerRevisionPayloadSchema.safeParse({
        ...updatePayload,
        content: '# Plan\r\n',
      }).success,
    ).toBe(false);
    expect(
      innerRevisionPayloadSchema.safeParse({
        ...updatePayload,
        path: '../Plan.md',
      }).success,
    ).toBe(false);
    expect(
      innerRevisionPayloadSchema.safeParse({
        schemaVersion: 1,
        operation: 'delete',
        path: 'Notes/Plan.md',
        content: '# must not survive',
        plaintextHash: hash,
      }).success,
    ).toBe(false);
  });

  it('accepts a strict tombstone without plaintext content', () => {
    expect(
      validateRevisionPayloadAgainstHeader(protectedHeader, {
        schemaVersion: 1,
        operation: 'delete',
        path: 'Notes/Plan.md',
        content: null,
        plaintextHash: null,
      }).payload.operation,
    ).toBe('delete');
  });
});
