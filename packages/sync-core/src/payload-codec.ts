/**
 * Decodes the opaque revision payload back into the fields a client needs to
 * materialize a remote revision in its local vault: the operation, the target
 * path, an optional previous path (for renames) and the plaintext content.
 *
 * The opaque payload is the plaintext-JSON `InnerRevisionPayload`
 * (`@havemind/protocol`); this decoder validates only the materialization-
 * relevant fields and rejects reserved or non-canonical paths outright, so a
 * hostile or corrupt payload can never steer a write into `.obsidian/`,
 * `Havemind Conflicts/` or a path-traversal target (the trusted producer
 * validates the full schema — recipe, hashes — at creation time).
 */

import { canonicalizeVaultPath } from '@havemind/protocol';

export type RevisionOperation =
  | 'initial-import'
  | 'create'
  | 'update'
  | 'rename'
  | 'restore'
  | 'reconcile'
  | 'delete';

const OPERATIONS: ReadonlySet<string> = new Set<RevisionOperation>([
  'initial-import',
  'create',
  'update',
  'rename',
  'restore',
  'reconcile',
  'delete',
]);

export interface DecodedRevisionPayload {
  readonly operation: RevisionOperation;
  readonly path: string;
  readonly previousPath: string | null;
  /**
   * Whether the payload carries markdown text (`content`) or raw binary bytes
   * (`binaryContent`). The decoder always populates it; it is OPTIONAL only so
   * the many existing test doubles that build a decoded payload literally
   * (omitting it) keep type-checking — an absent `kind` means `'markdown'`.
   * A legacy on-wire payload with no `kind` field also decodes as `'markdown'`,
   * so old revisions keep working unchanged (F9).
   */
  readonly kind?: 'markdown' | 'binary';
  /** Plaintext markdown content, or `null` for a delete/binary payload. */
  readonly content: string | null;
  /**
   * Raw file bytes for a binary payload, or `null` for markdown/delete. The
   * bytes are the exact file content — never canonicalised — so materialising
   * them reproduces the source file byte-for-byte. Optional for the same
   * test-double reason as `kind`.
   */
  readonly binaryContent?: Uint8Array | null;
}

export class PayloadDecodeError extends Error {
  override readonly name = 'PayloadDecodeError';

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function decodeRevisionPayload(
  bytes: string | Uint8Array,
): DecodedRevisionPayload {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PayloadDecodeError('Revision payload is not valid JSON.', error);
  }

  if (!isRecord(json)) {
    throw new PayloadDecodeError('Revision payload must be a JSON object.');
  }
  if (json.schemaVersion !== 1) {
    throw new PayloadDecodeError('Unsupported revision payload schema version.');
  }
  if (typeof json.operation !== 'string' || !OPERATIONS.has(json.operation)) {
    throw new PayloadDecodeError('Revision payload has an unknown operation.');
  }
  const operation = json.operation as RevisionOperation;

  const path = assertCanonicalPath(json.path, 'path');
  const previousPath =
    json.previousPath === undefined || json.previousPath === null
      ? null
      : assertCanonicalPath(json.previousPath, 'previousPath');

  // Binary payloads (F9) carry raw bytes base64-encoded and never a delete
  // tombstone — a binary delete is still a markdown-kind tombstone. Whole-file
  // replace only, so `content` (markdown text) is always null here.
  if (json.kind === 'binary') {
    if (operation === 'delete') {
      throw new PayloadDecodeError('A binary payload cannot be a delete tombstone.');
    }
    if (typeof json.contentBase64 !== 'string') {
      throw new PayloadDecodeError('A binary revision must carry string contentBase64.');
    }
    const binaryContent = decodeBase64(json.contentBase64);
    return { operation, path, previousPath, kind: 'binary', content: null, binaryContent };
  }

  let content: string | null;
  if (operation === 'delete') {
    if (json.content !== null && json.content !== undefined) {
      throw new PayloadDecodeError('A delete tombstone must not carry content.');
    }
    content = null;
  } else {
    if (typeof json.content !== 'string') {
      throw new PayloadDecodeError('A content revision must carry string content.');
    }
    content = json.content;
  }

  return { operation, path, previousPath, kind: 'markdown', content, binaryContent: null };
}

/**
 * Decodes standard base64 to raw bytes. A malformed body (a payload a hostile
 * or corrupt peer forged) is rejected as a decode error rather than silently
 * yielding garbage bytes, matching the reserved-path guard's fail-closed stance.
 */
function decodeBase64(base64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new PayloadDecodeError('Binary revision content is not valid base64.');
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch (error) {
    throw new PayloadDecodeError('Binary revision content is not valid base64.', error);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assertCanonicalPath(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PayloadDecodeError(`Revision payload ${field} must be a string.`);
  }
  try {
    if (canonicalizeVaultPath(value) !== value) {
      throw new PayloadDecodeError(
        `Revision payload ${field} is not a canonical vault path.`,
      );
    }
  } catch (error) {
    if (error instanceof PayloadDecodeError) throw error;
    throw new PayloadDecodeError(
      `Revision payload ${field} is a reserved or invalid vault path.`,
      error,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
