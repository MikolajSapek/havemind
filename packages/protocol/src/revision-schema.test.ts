import { describe, expect, it } from 'vitest';

import {
  innerRevisionPayloadSchema,
  opaqueBlobReceiptSchema,
  protectedRevisionHeaderSchema,
  reconstructionRecipeSchema,
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

const recipe = {
  version: 1,
  parts: [
    {
      type: 'source',
      parentRevisionId,
      start: 0,
      end: 4,
    },
    { type: 'literal', text: ' updated' },
  ],
} as const;

const updatePayload = {
  schemaVersion: 1,
  operation: 'update',
  path: 'Notes/Plan.md',
  content: '# Plan\n updated',
  plaintextHash: hash,
  recipe,
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

  it('uses the same source-range recipe shape as sync-core', () => {
    expect(reconstructionRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(reconstructionRecipeSchema.parse({ version: 1, parts: [] })).toEqual({
      version: 1,
      parts: [],
    });
  });

  it('rejects invalid ranges, empty literals and CR text', () => {
    expect(
      reconstructionRecipeSchema.safeParse({
        ...recipe,
        parts: [
          {
            type: 'source',
            parentRevisionId,
            start: 4,
            end: 4,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      reconstructionRecipeSchema.safeParse({
        ...recipe,
        parts: [{ type: 'literal', text: '' }],
      }).success,
    ).toBe(false);
    expect(
      reconstructionRecipeSchema.safeParse({
        ...recipe,
        parts: [{ type: 'literal', text: 'bad\r\n' }],
      }).success,
    ).toBe(false);
  });

  it('validates a normalized Markdown snapshot and its recipe', () => {
    const payload = innerRevisionPayloadSchema.parse(updatePayload);
    expect(payload.operation).toBe('update');
    expect(
      validateRevisionPayloadAgainstHeader(protectedHeader, updatePayload),
    ).toEqual({ header: protectedHeader, payload: updatePayload });
  });

  it('rejects a recipe source that is not a protected-header parent', () => {
    expect(() =>
      validateRevisionPayloadAgainstHeader(protectedHeader, {
        ...updatePayload,
        recipe: {
          version: 1,
          parts: [
            {
              type: 'source',
              parentRevisionId: revisionId,
              start: 0,
              end: 1,
            },
          ],
        },
      }),
    ).toThrow(/parent/i);
  });

  it('allows restore provenance to reference an earlier non-head revision', () => {
    const currentHeadHeader = {
      ...protectedHeader,
      parentRevisionIds: [laterParentId],
    };
    const historicalRestore = {
      ...updatePayload,
      operation: 'restore',
      recipe: {
        version: 1,
        parts: [
          {
            type: 'source',
            parentRevisionId,
            start: 0,
            end: 4,
          },
        ],
      },
    } as const;

    expect(
      validateRevisionPayloadAgainstHeader(
        currentHeadHeader,
        historicalRestore,
      ),
    ).toEqual({ header: currentHeadHeader, payload: historicalRestore });
  });

  it('enforces operation parent counts and rename path semantics', () => {
    const rootHeader = { ...protectedHeader, parentRevisionIds: [] };
    const literalRecipe = {
      version: 1,
      parts: [{ type: 'literal', text: '# New\n' }],
    } as const;

    expect(
      validateRevisionPayloadAgainstHeader(rootHeader, {
        ...updatePayload,
        operation: 'create',
        content: '# New\n',
        recipe: literalRecipe,
      }).payload.operation,
    ).toBe('create');
    expect(
      validateRevisionPayloadAgainstHeader(rootHeader, {
        ...updatePayload,
        operation: 'initial-import',
        content: '# New\n',
        recipe: literalRecipe,
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
        recipe: null,
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
        recipe: null,
      }).payload.operation,
    ).toBe('delete');
  });
});
