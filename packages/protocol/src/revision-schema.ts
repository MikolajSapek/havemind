import { z } from 'zod';

import { canonicalizeVaultPath } from './canonicalization.js';
import { blobHashSchema, plaintextHashSchema } from './hashing.js';
import { protocolVersionSchema } from './version.js';

const identifierSchema = z.string().uuid();
const parentRevisionIdsSchema = z.array(identifierSchema).max(32);

/**
 * Wire-format line-ending check: content and recipe-literal fragments must use
 * LF, never CR/CRLF. This is DELIBERATELY only a line-ending check, not the full
 * `canonicalizeMarkdown` transform: a literal recipe part is a mid-document
 * fragment, so it must NOT be forced to a single trailing newline (AUD-03).
 * Hashing/diff-base canonicalisation lives in `canonicalizeMarkdown`; this schema
 * validates wire structure only.
 */
function usesLfLineEndings(text: string): boolean {
  return !text.includes('\r');
}

export const requiredSemanticsSchema = z
  .object({
    payloadFormat: z.literal('revision-payload-v1'),
    syncSemantics: z.literal('dag-cas-v1'),
    provenanceRecipe: z.literal('source-range-v1'),
    pathNormalization: z.literal('nfc-lowercase-v1'),
  })
  .strict();

export type RequiredSemantics = z.infer<typeof requiredSemanticsSchema>;

export const protectedRevisionHeaderSchema = z
  .object({
    protocol: protocolVersionSchema,
    vaultId: identifierSchema,
    fileId: identifierSchema,
    revisionId: identifierSchema,
    parentRevisionIds: parentRevisionIdsSchema,
    expectedMemberId: identifierSchema,
    expectedDeviceId: identifierSchema,
    payloadEncoding: z.literal('plaintext-json-v1'),
    semantics: requiredSemanticsSchema,
  })
  .strict()
  .superRefine((header, context) => {
    if (new Set(header.parentRevisionIds).size !== header.parentRevisionIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Parent revision IDs must be unique.',
        path: ['parentRevisionIds'],
      });
    }

    if (header.parentRevisionIds.includes(header.revisionId)) {
      context.addIssue({
        code: 'custom',
        message: 'A revision cannot be its own parent.',
        path: ['parentRevisionIds'],
      });
    }

    for (let index = 1; index < header.parentRevisionIds.length; index += 1) {
      const previous = header.parentRevisionIds[index - 1];
      const current = header.parentRevisionIds[index];
      if (previous !== undefined && current !== undefined && previous > current) {
        context.addIssue({
          code: 'custom',
          message: 'Parent revision IDs must use canonical ascending order.',
          path: ['parentRevisionIds', index],
        });
      }
    }
  });

export type ProtectedRevisionHeader = z.infer<
  typeof protectedRevisionHeaderSchema
>;

export const opaqueBlobReceiptSchema = z
  .object({
    revisionId: identifierSchema,
    memberId: identifierSchema,
    deviceId: identifierSchema,
    serverSequence: z.number().int().positive().safe(),
    serverTime: z.string().datetime({ offset: true }),
    blobHash: blobHashSchema,
    byteLength: z.number().int().nonnegative().safe(),
  })
  .strict();

export type OpaqueBlobReceipt = z.infer<typeof opaqueBlobReceiptSchema>;

const sourceRangePartSchema = z
  .object({
    type: z.literal('source'),
    parentRevisionId: identifierSchema,
    start: z.number().int().nonnegative().safe(),
    end: z.number().int().positive().safe(),
  })
  .strict()
  .refine((part) => part.start < part.end, {
    message: 'Source range must not be empty or inverted.',
    path: ['end'],
  });

const literalPartSchema = z
  .object({
    type: z.literal('literal'),
    text: z
      .string()
      .min(1)
      .refine(usesLfLineEndings, {
        message: 'Literal text must use LF line endings.',
      }),
  })
  .strict();

export const reconstructionRecipeSchema = z
  .object({
    version: z.literal(1),
    parts: z.array(
      z.discriminatedUnion('type', [sourceRangePartSchema, literalPartSchema]),
    ),
  })
  .strict();

export type ReconstructionRecipe = z.infer<
  typeof reconstructionRecipeSchema
>;

const canonicalPathSchema = z.string().refine(
  (path) => {
    try {
      return canonicalizeVaultPath(path) === path;
    } catch {
      return false;
    }
  },
  { message: 'Path must be a canonical non-reserved vault path.' },
);

const normalizedMarkdownSchema = z.string().refine(usesLfLineEndings, {
  message: 'Markdown content must use LF line endings.',
});

const contentRevisionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum([
      'initial-import',
      'create',
      'update',
      'rename',
      'restore',
      'reconcile',
    ]),
    path: canonicalPathSchema,
    previousPath: canonicalPathSchema.optional(),
    content: normalizedMarkdownSchema,
    plaintextHash: plaintextHashSchema,
    recipe: reconstructionRecipeSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.operation === 'rename') {
      if (payload.previousPath === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Rename requires previousPath.',
          path: ['previousPath'],
        });
      } else if (payload.previousPath === payload.path) {
        context.addIssue({
          code: 'custom',
          message: 'Rename path and previousPath must be different.',
          path: ['previousPath'],
        });
      }
    } else if (payload.previousPath !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'previousPath is valid only for rename.',
        path: ['previousPath'],
      });
    }
  });

const tombstoneRevisionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal('delete'),
    path: canonicalPathSchema,
    content: z.null(),
    plaintextHash: z.null(),
    recipe: z.null(),
  })
  .strict();

export const innerRevisionPayloadSchema = z.union([
  contentRevisionPayloadSchema,
  tombstoneRevisionPayloadSchema,
]);

export type InnerRevisionPayload = z.infer<
  typeof innerRevisionPayloadSchema
>;

export interface ValidatedRevisionInput {
  readonly header: ProtectedRevisionHeader;
  readonly payload: InnerRevisionPayload;
}

export function validateRevisionPayloadAgainstHeader(
  headerInput: unknown,
  payloadInput: unknown,
): ValidatedRevisionInput {
  const header = protectedRevisionHeaderSchema.parse(headerInput);
  const payload = innerRevisionPayloadSchema.parse(payloadInput);
  const parents = new Set(header.parentRevisionIds);

  if (payload.operation !== 'delete' && payload.operation !== 'restore') {
    for (const part of payload.recipe.parts) {
      if (part.type === 'source' && !parents.has(part.parentRevisionId)) {
        throw new Error(
          `Recipe source ${part.parentRevisionId} is not a protected-header parent.`,
        );
      }
    }
  }

  // A restore is causally based on the current head but copies provenance
  // ranges from an older revision. The trusted client must separately verify
  // that every such source exists in retained history for this vault and file.

  const isRootOperation =
    payload.operation === 'create' || payload.operation === 'initial-import';
  if (isRootOperation && header.parentRevisionIds.length !== 0) {
    throw new Error(`${payload.operation} must not have a parent revision.`);
  }
  if (!isRootOperation && header.parentRevisionIds.length === 0) {
    throw new Error(`${payload.operation} requires at least one parent revision.`);
  }
  if (
    payload.operation === 'reconcile' &&
    header.parentRevisionIds.length < 2
  ) {
    throw new Error('reconcile requires at least two parent revisions.');
  }

  return { header, payload };
}
