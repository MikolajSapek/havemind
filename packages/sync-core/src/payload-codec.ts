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
  /** Plaintext file content, or `null` for a delete tombstone. */
  readonly content: string | null;
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

  return { operation, path, previousPath, content };
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
