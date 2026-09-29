/**
 * Builds the opaque revision envelope a client PUSHes to the server. This is the
 * producer half of the sync loop: a local vault change becomes a protected
 * header plus a base64 payload that the peer decodes with `decodeRevisionPayload`
 * (`payload-codec.ts`). The server never inspects the payload, it stores the
 * bytes and computes their content-addressed hash, so the header must be valid
 * on its own and the payload must be decodable by the peer.
 *
 * A note travels once, as `content` plus its hash. Releases up to 1.5.7 also
 * wrote the whole note a second time inside a one-part "recipe" that no plugin
 * read. Only a merge still carries one, see `legacyRecipe`.
 */

import {
  base64ToBytes,
  bytesToBase64,
  canonicalizeMarkdown,
  canonicalizeVaultPath,
  hashBlob,
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
  /**
   * Whether this change carries markdown text (`content`) or raw binary bytes
   * (`binaryContentBase64`). Defaults to `'markdown'` so every existing caller
   * is unchanged. A `'binary'` change is a whole-file replace (F9), no line
   * diff, no canonicalisation.
   */
  readonly kind?: 'markdown' | 'binary';
  /** Note content, or `null` for a delete tombstone / binary change. */
  readonly content: string | null;
  /**
   * A binary change's raw file bytes as standard base64, the form the payload
   * carries and the caller already holds; ignored for markdown/delete.
   */
  readonly binaryContentBase64?: string | null;
  readonly idempotencyKey: string;
  /**
   * Reject (rather than build) an envelope whose payload exceeds this many
   * bytes. This is the real effective ceiling the server enforces per payload,
   * so a note too large to ever be accepted is caught here, before it can be
   * enqueued and silently wedge the whole outbox. Defaults to
   * {@link DEFAULT_MAX_REVISION_PAYLOAD_BYTES}.
   */
  readonly maxPayloadBytes?: number;
}

/**
 * The server's per-payload ceiling (`DEFAULT_MAX_PAYLOAD_BYTES`). The payload is
 * measured as the exact bytes the server stores, which is what its own limit
 * checks, so a payload at or under this size is guaranteed to clear the
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
  if (parentRevisionIds.length >= 2) {
    payload.recipe = legacyRecipe(payload.content);
  }
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

/**
 * The `recipe` every payload carried up to release 1.5.7. Nothing ever read it,
 * so an ordinary revision no longer writes it. A revision with two or more
 * parents (a merge) still does, byte for byte as before: the client tells "the
 * same merge, made on two devices" from any other revision by the hash of the
 * payload (`retireEquivalentMerges`, `reconcileHeads`), and a device on 1.5.7 or
 * older writes the recipe. A device that did not would never recognise its
 * merge as equivalent to theirs and would keep it queued for good, stranding the
 * edits made on top of it. When those two checks compare content instead of
 * bytes, and no such device is left, delete this function, its call and the
 * `recipe` field of the payload schemas.
 */
function legacyRecipe(content: unknown): unknown {
  // A tombstone or an attachment carried `recipe: null`.
  if (typeof content !== 'string') return null;
  return {
    version: 1,
    parts: content === '' ? [] : [{ type: 'literal', text: content }],
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
    };
  }

  if (input.kind === 'binary') {
    // Whole-file replace over RAW bytes: no canonicalisation. Kept deliberately
    // separate from the markdown path below.
    //
    // `blobByteHash` is DESCRIPTIVE metadata, not an integrity guarantee
    // (AUD-10(b)). No consumer reads it: `decodeRevisionPayload` ignores the
    // field, and `applyRemoteBinary` recomputes `hashBlob(bytes)` from the
    // decoded bytes to track its base and detect divergence. Integrity of these
    // bytes is closed OUTSIDE the payload, the whole payload JSON (base64
    // included) is content-addressed and re-hashed on read in the server's blob
    // store, so a corrupted attachment fails there, not here. Do not describe
    // this field as a check until something actually verifies it.
    const contentBase64 = input.binaryContentBase64 ?? '';
    const base: Record<string, unknown> = {
      schemaVersion: 1,
      operation: input.operation,
      kind: 'binary',
      path,
    };
    if (input.operation === 'rename') {
      if (input.previousPath === undefined || input.previousPath === null) {
        throw new Error('A rename revision requires a previousPath.');
      }
      base.previousPath = canonicalizeVaultPath(input.previousPath);
    }
    base.contentBase64 = contentBase64;
    base.blobByteHash = await hashBlob(base64ToBytes(contentBase64));
    return base;
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
  return base;
}
