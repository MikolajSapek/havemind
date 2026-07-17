/**
 * Builds the opaque revision envelope a client PUSHes to the server. This is the
 * producer half of the sync loop: a local vault change becomes a protected
 * header plus a base64 payload that the peer decodes with `decodeRevisionPayload`
 * (`payload-codec.ts`). The server never inspects the payload — it stores the
 * bytes and computes their content-addressed hash — so the header must be valid
 * on its own and the payload must be decodable by the peer.
 *
 * The recipe is deliberately literal-only: a single literal part carrying the
 * whole note (or an empty parts list for an empty note). A literal-only recipe
 * has no `source` parts, so it validates against any header regardless of
 * parents — correct for both root creates and parented updates. Source-range
 * (delta) recipes are a later optimisation and are not required for correctness.
 */

import {
  canonicalizeMarkdown,
  canonicalizeVaultPath,
  hashPlaintext,
  PROTOCOL_VERSION,
  sha256Hex,
  validateRevisionPayloadAgainstHeader,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';

export type RevisionEnvelopeOperation =
  | 'initial-import'
  | 'create'
  | 'update'
  | 'rename'
  | 'delete';

export interface RevisionEnvelopeIdentity {
  readonly vaultId: string;
  readonly fileId: string;
  /** Server-side membership id (`memberships.id`) for the pushing user. */
  readonly memberId: string;
  /** Server-issued device id bound to the current session. */
  readonly deviceId: string;
}

export interface BuildRevisionEnvelopeInput {
  readonly identity: RevisionEnvelopeIdentity;
  readonly revisionId: string;
  readonly parentRevisionIds: readonly string[];
  readonly operation: RevisionEnvelopeOperation;
  readonly path: string;
  readonly previousPath?: string | null;
  /** Note content, or `null` for a delete tombstone. */
  readonly content: string | null;
  readonly idempotencyKey: string;
  /**
   * Reject (rather than build) an envelope whose payload exceeds this many
   * bytes. This is the real effective ceiling the server enforces per payload,
   * so a note too large to ever be accepted is caught here — before it can be
   * enqueued and silently wedge the whole outbox. Defaults to
   * {@link DEFAULT_MAX_REVISION_PAYLOAD_BYTES}.
   */
  readonly maxPayloadBytes?: number;
}

/**
 * The server's per-payload ceiling (`DEFAULT_MAX_PAYLOAD_BYTES`). The payload is
 * measured as the exact bytes the server stores, which is what its own limit
 * checks — so a payload at or under this size is guaranteed to clear the
 * per-payload gate.
 */
export const DEFAULT_MAX_REVISION_PAYLOAD_BYTES = 512 * 1024;

/**
 * Thrown by {@link buildRevisionEnvelope} when a change's payload exceeds the
 * effective server limit. Surfacing this (instead of enqueuing) is what stops a
 * single oversized note from permanently blocking every other file's sync.
 */
export class RevisionPayloadTooLargeError extends Error {
  override readonly name = 'RevisionPayloadTooLargeError';

  constructor(
    readonly path: string,
    readonly byteLength: number,
    readonly maxByteLength: number,
  ) {
    super(
      `Note "${path}" is too large to sync: ${byteLength} bytes exceeds the ${maxByteLength}-byte limit.`,
    );
  }
}

export interface BuiltRevisionEnvelope {
  readonly header: ProtectedRevisionHeader;
  /** Base64 of the exact payload bytes shipped to the server. */
  readonly payloadBase64: string;
  /** SHA-256 hex of the payload bytes (matches the server's stored blob hash). */
  readonly contentHash: string;
  readonly revisionId: string;
  readonly fileId: string;
  readonly idempotencyKey: string;
}

const REQUIRED_SEMANTICS = {
  payloadFormat: 'revision-payload-v1',
  syncSemantics: 'dag-cas-v1',
  provenanceRecipe: 'source-range-v1',
  pathNormalization: 'nfc-lowercase-v1',
} as const;

/**
 * Builds a fully validated, ready-to-push revision envelope from a local change.
 * Throws if the resulting header/payload pair is internally inconsistent, so a
 * malformed revision can never reach the outbox.
 */
export async function buildRevisionEnvelope(
  input: BuildRevisionEnvelopeInput,
): Promise<BuiltRevisionEnvelope> {
  const path = canonicalizeVaultPath(input.path);
  const parentRevisionIds = [...new Set(input.parentRevisionIds)].sort();

  const header: ProtectedRevisionHeader = {
    protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
    vaultId: input.identity.vaultId,
    fileId: input.identity.fileId,
    revisionId: input.revisionId,
    parentRevisionIds,
    expectedMemberId: input.identity.memberId,
    expectedDeviceId: input.identity.deviceId,
    payloadEncoding: 'plaintext-json-v1',
    semantics: REQUIRED_SEMANTICS,
  };

  const payload = await buildInnerPayload(input, path);
  // Fail fast: never enqueue an envelope the server (or the peer) would reject.
  validateRevisionPayloadAgainstHeader(header, payload);

  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);

  // Fail fast on an oversized payload: the server would reject these bytes with
  // a 4xx that no retry can satisfy, so surface it here rather than enqueue a
  // revision that would wedge the outbox forever.
  const maxPayloadBytes =
    input.maxPayloadBytes ?? DEFAULT_MAX_REVISION_PAYLOAD_BYTES;
  if (bytes.byteLength > maxPayloadBytes) {
    throw new RevisionPayloadTooLargeError(
      path,
      bytes.byteLength,
      maxPayloadBytes,
    );
  }

  return {
    header,
    payloadBase64: bytesToBase64(bytes),
    contentHash: await sha256Hex(bytes),
    revisionId: input.revisionId,
    fileId: input.identity.fileId,
    idempotencyKey: input.idempotencyKey,
  };
}

async function buildInnerPayload(
  input: BuildRevisionEnvelopeInput,
  path: string,
): Promise<Record<string, unknown>> {
  if (input.operation === 'delete') {
    return {
      schemaVersion: 1,
      operation: 'delete',
      path,
      content: null,
      plaintextHash: null,
      recipe: null,
    };
  }

  const content = canonicalizeMarkdown(input.content ?? '');
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    operation: input.operation,
    path,
  };
  if (input.operation === 'rename') {
    if (input.previousPath === undefined || input.previousPath === null) {
      throw new Error('A rename revision requires a previousPath.');
    }
    base.previousPath = canonicalizeVaultPath(input.previousPath);
  }
  base.content = content;
  base.plaintextHash = await hashPlaintext(content);
  // NOTE: this stores the content a second time inside the literal recipe part,
  // so the payload carries the note twice. This duplication is NOT removable
  // without a protocol change: `contentRevisionPayloadSchema` (revision-schema)
  // requires BOTH a non-null `content` string AND a non-null `recipe`, and a
  // literal recipe part must carry its own `text`. Dropping either field, or
  // reconstructing `content` from the recipe alone, would break the peer decoder
  // and the header/payload validation contract. Halving the payload therefore
  // belongs to a future protocol revision, not this fix; the effective ceiling
  // is instead raised by the pre-enqueue size guard above catching payloads that
  // would be rejected. See revision-schema.ts contentRevisionPayloadSchema.
  base.recipe = buildLiteralRecipe(content);
  return base;
}

function buildLiteralRecipe(content: string): Record<string, unknown> {
  // An empty note reconstructs from no parts; a non-empty note from one literal.
  const parts =
    content.length === 0 ? [] : [{ type: 'literal', text: content }];
  return { version: 1, parts };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
