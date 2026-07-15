import {
  ERROR_CODES,
  blobHashSchema,
  canonicalJson,
  hashCanonicalJson,
  opaqueBlobReceiptSchema,
  protectedRevisionHeaderSchema,
  type BlobHash,
  type OpaqueBlobReceipt,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';

import { BlobIntegrityError, type BlobStore } from './blob-store.js';

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_IDEMPOTENCY_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_EVENT_PAGE_SIZE = 1_000;

export type RevisionRepositoryErrorCode =
  | 'CORRUPT_BLOB'
  | 'FILE_ALREADY_EXISTS'
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'MISSING_BLOB'
  | 'PARENT_FILE_MISMATCH'
  | 'REPOSITORY_INTEGRITY'
  | 'FORBIDDEN'
  | 'HEAD_SET_CHANGED'
  | 'INVALID_REQUEST'
  | 'MISSING_PARENT'
  | 'NOT_FOUND'
  | 'REVISION_ID_REUSE';

/** A fail-closed repository error with a machine-readable code. */
export class RevisionRepositoryError extends Error {
  public constructor(
    public readonly code: RevisionRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RevisionRepositoryError';
  }
}

export interface AuthenticatedRevisionActor {
  readonly deviceId: string;
  readonly memberId: string;
}

export interface CommitRevisionInput {
  readonly actor: AuthenticatedRevisionActor;
  readonly blobHash: BlobHash;
  readonly header: ProtectedRevisionHeader;
  readonly idempotencyKey: string;
}

export interface CommitRevisionResult {
  readonly receipt: OpaqueBlobReceipt;
  readonly status: 'accepted' | 'replayed';
}

export interface StoredRevisionEvent {
  readonly fileId: string;
  readonly receipt: OpaqueBlobReceipt;
  readonly revisionId: string;
  readonly serverSequence: number;
  readonly type: 'revision-accepted';
}

export interface RevisionRepositoryOptions {
  readonly idempotencyTtlMs?: number;
  readonly now?: () => Date;
}

interface PreparedCommit {
  readonly actor: AuthenticatedRevisionActor;
  readonly blobHash: BlobHash;
  readonly blobSize: number;
  readonly header: ProtectedRevisionHeader;
  readonly headerBytes: Buffer;
  readonly headerHash: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

interface ExistingRevisionRow {
  readonly acceptedAt: string;
  readonly blobHash: string;
  readonly blobSize: number;
  readonly deviceId: string;
  readonly fileId: string;
  readonly memberId: string;
  readonly protectedHeader: Buffer;
  readonly protectedHeaderHash: string;
  readonly revisionId: string;
  readonly serverSequence: number;
  readonly vaultId: string;
}

interface ActorRow {
  readonly deviceStatus: string;
  readonly deviceUserId: string;
  readonly membershipStatus: string;
  readonly membershipUserId: string;
  readonly userStatus: string;
  readonly vaultId: string;
}

interface VaultRow {
  readonly nextServerSequence: number;
  readonly writeEpoch: number;
}

interface FileRow {
  readonly vaultId: string;
}

interface ParentRow {
  readonly fileId: string;
  readonly revisionId: string;
  readonly vaultId: string;
}

interface IdempotencyRow {
  readonly requestHash: string;
  readonly responseBody: string;
}

interface EventRow {
  readonly eventPayload: string;
  readonly eventType: string;
  readonly revisionId: string;
  readonly serverSequence: number;
}

function validateIdempotencyTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_IDEMPOTENCY_TTL_MS
  ) {
    throw new RevisionRepositoryError(
      ERROR_CODES.INVALID_REQUEST,
      `idempotencyTtlMs must be a positive safe integer no greater than ${MAX_IDEMPOTENCY_TTL_MS}.`,
    );
  }

  return value;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f)
    ) {
      return true;
    }
  }

  return false;
}

function validateIdempotencyKey(value: string): string {
  if (
    value.trim().length === 0 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    containsAsciiControlCharacter(value)
  ) {
    throw new RevisionRepositoryError(
      ERROR_CODES.INVALID_REQUEST,
      `Idempotency key must contain 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable characters.`,
    );
  }

  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function getExistingRevision(
  database: Database.Database,
  revisionId: string,
): ExistingRevisionRow | undefined {
  return database
    .prepare(
      `SELECT
         id AS revisionId,
         vault_id AS vaultId,
         file_id AS fileId,
         membership_id AS memberId,
         device_id AS deviceId,
         server_sequence AS serverSequence,
         protected_header AS protectedHeader,
         protected_header_hash AS protectedHeaderHash,
         blob_hash AS blobHash,
         blob_size AS blobSize,
         accepted_at AS acceptedAt
       FROM revisions
       WHERE id = ?`,
    )
    .get(revisionId) as ExistingRevisionRow | undefined;
}

function storedRevisionMatches(
  stored: ExistingRevisionRow,
  prepared: PreparedCommit,
): boolean {
  return (
    stored.revisionId === prepared.header.revisionId &&
    stored.vaultId === prepared.header.vaultId &&
    stored.fileId === prepared.header.fileId &&
    stored.memberId === prepared.actor.memberId &&
    stored.deviceId === prepared.actor.deviceId &&
    stored.protectedHeaderHash === prepared.headerHash &&
    stored.protectedHeader.equals(prepared.headerBytes) &&
    stored.blobHash === prepared.blobHash &&
    stored.blobSize === prepared.blobSize
  );
}

function assertStoredRevisionMatches(
  stored: ExistingRevisionRow,
  prepared: PreparedCommit,
): void {
  if (!storedRevisionMatches(stored, prepared)) {
    throw new RevisionRepositoryError(
      ERROR_CODES.REVISION_ID_REUSE,
      `Revision ID ${prepared.header.revisionId} was reused with different protected bytes or blob bytes.`,
    );
  }
}

function receiptFromStoredRevision(
  stored: ExistingRevisionRow,
): OpaqueBlobReceipt {
  try {
    return opaqueBlobReceiptSchema.parse({
      blobHash: stored.blobHash,
      byteLength: stored.blobSize,
      deviceId: stored.deviceId,
      memberId: stored.memberId,
      revisionId: stored.revisionId,
      serverSequence: stored.serverSequence,
      serverTime: stored.acceptedAt,
    });
  } catch (error) {
    throw new RevisionRepositoryError(
      'REPOSITORY_INTEGRITY',
      `Stored receipt for revision ${stored.revisionId} is invalid.`,
      { cause: error },
    );
  }
}

function sameReceipt(
  left: OpaqueBlobReceipt,
  right: OpaqueBlobReceipt,
): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.memberId === right.memberId &&
    left.deviceId === right.deviceId &&
    left.serverSequence === right.serverSequence &&
    left.serverTime === right.serverTime &&
    left.blobHash === right.blobHash &&
    left.byteLength === right.byteLength
  );
}

function parseStoredResult(
  responseBody: string,
  expectedReceipt: OpaqueBlobReceipt,
): CommitRevisionResult {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new TypeError('Stored response must be an object.');
    }

    const record = parsed as Record<string, unknown>;
    if (record.status !== 'accepted' && record.status !== 'replayed') {
      throw new TypeError('Stored response status is invalid.');
    }

    const receipt = opaqueBlobReceiptSchema.parse(record.receipt);
    if (!sameReceipt(receipt, expectedReceipt)) {
      throw new TypeError('Stored response receipt does not match its revision.');
    }

    return { receipt, status: record.status };
  } catch (error) {
    throw new RevisionRepositoryError(
      'REPOSITORY_INTEGRITY',
      'Stored idempotency response is invalid.',
      { cause: error },
    );
  }
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireSafeSequence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RevisionRepositoryError(
      'REPOSITORY_INTEGRITY',
      `${field} is not a positive safe integer.`,
    );
  }

  return value;
}

function requireSafeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RevisionRepositoryError(
      'REPOSITORY_INTEGRITY',
      `${field} is not a non-negative safe integer.`,
    );
  }

  return value;
}

/**
 * Persists immutable revisions and their observable event/cursor state in one
 * SQLite write transaction after the referenced content-addressed blob passes
 * integrity verification.
 */
export class RevisionRepository {
  readonly #database: Database.Database;
  readonly #blobStore: Pick<BlobStore, 'read'>;
  readonly #now: () => Date;
  readonly #idempotencyTtlMs: number;

  public constructor(
    database: Database.Database,
    blobStore: Pick<BlobStore, 'read'>,
    options: RevisionRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#blobStore = blobStore;
    this.#now = options.now ?? (() => new Date());
    this.#idempotencyTtlMs = validateIdempotencyTtl(
      options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    );
  }

  /** Accepts or idempotently replays one protected revision. */
  public async commitRevision(
    input: CommitRevisionInput,
  ): Promise<CommitRevisionResult> {
    const prepared = await this.#prepareCommit(input);
    const commit = this.#database.transaction(() =>
      this.#commitPrepared(prepared),
    );
    return commit.immediate();
  }

  /** Returns the current canonical head set for a file. */
  public getHeads(vaultId: string, fileId: string): string[] {
    const rows = this.#database
      .prepare(
        `SELECT heads.revision_id AS revisionId
         FROM file_heads AS heads
         INNER JOIN files ON files.id = heads.file_id
         WHERE files.vault_id = ? AND files.id = ?
         ORDER BY heads.revision_id`,
      )
      .all(vaultId, fileId) as Array<{ revisionId: string }>;
    return rows.map(({ revisionId }) => revisionId);
  }

  /** Returns the highest durably committed event sequence for a vault. */
  public getCursor(vaultId: string): number {
    const row = this.#database
      .prepare(
        `SELECT next_server_sequence AS nextServerSequence
         FROM vaults
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(vaultId) as { nextServerSequence: number } | undefined;

    if (row === undefined) {
      throw new RevisionRepositoryError(
        ERROR_CODES.NOT_FOUND,
        `Vault ${vaultId} was not found.`,
      );
    }

    return requireSafeSequence(row.nextServerSequence, 'next_server_sequence') - 1;
  }

  /** Reads a bounded, ascending page strictly after the supplied cursor. */
  public listEvents(
    vaultId: string,
    afterSequence: number,
    limit: number,
  ): StoredRevisionEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RevisionRepositoryError(
        ERROR_CODES.INVALID_REQUEST,
        'Event cursor must be a non-negative safe integer.',
      );
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_EVENT_PAGE_SIZE) {
      throw new RevisionRepositoryError(
        ERROR_CODES.INVALID_REQUEST,
        `Event page size must be between 1 and ${MAX_EVENT_PAGE_SIZE}.`,
      );
    }

    const rows = this.#database
      .prepare(
        `SELECT
           server_sequence AS serverSequence,
           event_type AS eventType,
           revision_id AS revisionId,
           event_payload AS eventPayload
         FROM vault_events
         WHERE vault_id = ? AND server_sequence > ?
         ORDER BY server_sequence
         LIMIT ?`,
      )
      .all(vaultId, afterSequence, limit) as EventRow[];

    return rows.map((row) => this.#parseEventRow(row));
  }

  async #prepareCommit(input: CommitRevisionInput): Promise<PreparedCommit> {
    const header = protectedRevisionHeaderSchema.parse(input.header);
    const blobHash = blobHashSchema.parse(input.blobHash);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

    if (
      header.expectedMemberId !== input.actor.memberId ||
      header.expectedDeviceId !== input.actor.deviceId
    ) {
      throw new RevisionRepositoryError(
        ERROR_CODES.FORBIDDEN,
        'Protected actor IDs do not match the authenticated context.',
      );
    }
    this.#assertAuthorizedActor(input.actor, header);

    const headerJson = canonicalJson(header);
    const headerBytes = Buffer.from(headerJson, 'utf8');
    const [headerHash, requestHash] = await Promise.all([
      hashCanonicalJson(header),
      hashCanonicalJson({
        actor: input.actor,
        blobHash,
        header,
      }),
    ]);
    const preparedWithoutBlob: Omit<PreparedCommit, 'blobSize'> = {
      actor: { ...input.actor },
      blobHash,
      header,
      headerBytes,
      headerHash,
      idempotencyKey,
      requestHash,
    };

    const existing = getExistingRevision(this.#database, header.revisionId);
    if (existing !== undefined) {
      const candidate: PreparedCommit = {
        ...preparedWithoutBlob,
        blobSize: existing.blobSize,
      };
      if (
        existing.blobHash !== blobHash ||
        existing.protectedHeaderHash !== headerHash ||
        !existing.protectedHeader.equals(headerBytes)
      ) {
        throw new RevisionRepositoryError(
          ERROR_CODES.REVISION_ID_REUSE,
          `Revision ID ${header.revisionId} was reused with different protected bytes or blob bytes.`,
        );
      }
      assertStoredRevisionMatches(existing, candidate);
    }

    const blobBytes = await this.#readVerifiedBlob(blobHash);
    return { ...preparedWithoutBlob, blobSize: blobBytes.byteLength };
  }

  async #readVerifiedBlob(hash: BlobHash): Promise<Buffer> {
    try {
      return await this.#blobStore.read(hash);
    } catch (error) {
      if (error instanceof BlobIntegrityError) {
        throw new RevisionRepositoryError(
          'CORRUPT_BLOB',
          `Blob ${hash} failed integrity verification.`,
          { cause: error },
        );
      }
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new RevisionRepositoryError(
          'MISSING_BLOB',
          `Blob ${hash} does not exist.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  #commitPrepared(prepared: PreparedCommit): CommitRevisionResult {
    this.#assertAuthorizedActor(prepared.actor, prepared.header);
    const vault = this.#getVault(prepared.header.vaultId);
    const existing = getExistingRevision(
      this.#database,
      prepared.header.revisionId,
    );
    const idempotency = this.#getIdempotencyRecord(prepared);

    if (existing !== undefined) {
      return this.#replayExisting(prepared, existing, idempotency);
    }

    if (idempotency !== undefined) {
      this.#assertIdempotencyRequest(idempotency, prepared);
      throw new RevisionRepositoryError(
        'REPOSITORY_INTEGRITY',
        'Idempotency response exists without its committed revision.',
      );
    }

    return this.#commitNewRevision(prepared, vault);
  }

  #replayExisting(
    prepared: PreparedCommit,
    existing: ExistingRevisionRow,
    idempotency: IdempotencyRow | undefined,
  ): CommitRevisionResult {
    assertStoredRevisionMatches(existing, prepared);
    const receipt = receiptFromStoredRevision(existing);

    if (idempotency !== undefined) {
      this.#assertIdempotencyRequest(idempotency, prepared);
      return parseStoredResult(idempotency.responseBody, receipt);
    }

    const replayed = { receipt, status: 'replayed' } as const;
    this.#insertIdempotencyRecord(prepared, replayed, 200, this.#readNow());
    return replayed;
  }

  #commitNewRevision(
    prepared: PreparedCommit,
    vault: VaultRow,
  ): CommitRevisionResult {
    const now = this.#readNow();
    const serverTime = now.toISOString();
    const serverSequence = requireSafeSequence(
      vault.nextServerSequence,
      'next_server_sequence',
    );
    if (serverSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RevisionRepositoryError(
        'REPOSITORY_INTEGRITY',
        'Vault server sequence is exhausted.',
      );
    }

    this.#validateAndPrepareFileGraph(prepared, serverTime);
    this.#insertRevision(prepared, vault, serverSequence, serverTime);
    this.#replaceParentHeads(prepared);

    const receipt = opaqueBlobReceiptSchema.parse({
      blobHash: prepared.blobHash,
      byteLength: prepared.blobSize,
      deviceId: prepared.actor.deviceId,
      memberId: prepared.actor.memberId,
      revisionId: prepared.header.revisionId,
      serverSequence,
      serverTime,
    });
    this.#insertRevisionEvent(prepared, receipt, serverTime);
    this.#advanceCursor(prepared.header.vaultId, serverSequence);

    const accepted = { receipt, status: 'accepted' } as const;
    this.#insertIdempotencyRecord(prepared, accepted, 201, now);
    return accepted;
  }

  #insertRevision(
    prepared: PreparedCommit,
    vault: VaultRow,
    serverSequence: number,
    serverTime: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO revisions (
           id,
           vault_id,
           file_id,
           membership_id,
           device_id,
           server_sequence,
           write_epoch,
           protected_header,
           protected_header_hash,
           blob_hash,
           blob_size,
           created_at,
           accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prepared.header.revisionId,
        prepared.header.vaultId,
        prepared.header.fileId,
        prepared.actor.memberId,
        prepared.actor.deviceId,
        serverSequence,
        requireSafeNonNegativeInteger(vault.writeEpoch, 'write_epoch'),
        prepared.headerBytes,
        prepared.headerHash,
        prepared.blobHash,
        prepared.blobSize,
        serverTime,
        serverTime,
      );
  }

  #replaceParentHeads(prepared: PreparedCommit): void {
    const insertParent = this.#database.prepare(
      `INSERT INTO revision_parents
         (revision_id, parent_revision_id, parent_order)
       VALUES (?, ?, ?)`,
    );
    const removeHead = this.#database.prepare(
      `DELETE FROM file_heads
       WHERE file_id = ? AND revision_id = ?`,
    );
    prepared.header.parentRevisionIds.forEach((parentId, index) => {
      insertParent.run(prepared.header.revisionId, parentId, index);
      removeHead.run(prepared.header.fileId, parentId);
    });
    this.#database
      .prepare(
        `INSERT INTO file_heads (file_id, revision_id)
         VALUES (?, ?)`,
      )
      .run(prepared.header.fileId, prepared.header.revisionId);
  }

  #insertRevisionEvent(
    prepared: PreparedCommit,
    receipt: OpaqueBlobReceipt,
    serverTime: string,
  ): void {
    const eventPayload = JSON.stringify({
      fileId: prepared.header.fileId,
      receipt,
    });
    this.#database
      .prepare(
        `INSERT INTO vault_events (
           vault_id,
           server_sequence,
           event_type,
           revision_id,
           event_payload,
           created_at
         ) VALUES (?, ?, 'revision-accepted', ?, ?, ?)`,
      )
      .run(
        prepared.header.vaultId,
        receipt.serverSequence,
        prepared.header.revisionId,
        eventPayload,
        serverTime,
      );
  }

  #advanceCursor(vaultId: string, serverSequence: number): void {
    const cursorUpdate = this.#database
      .prepare(
        `UPDATE vaults
         SET next_server_sequence = next_server_sequence + 1
         WHERE id = ? AND next_server_sequence = ?`,
      )
      .run(vaultId, serverSequence);
    if (cursorUpdate.changes !== 1) {
      throw new RevisionRepositoryError(
        'REPOSITORY_INTEGRITY',
        'Vault cursor changed during its write transaction.',
      );
    }
  }

  #assertAuthorizedActor(
    actor: AuthenticatedRevisionActor,
    header: ProtectedRevisionHeader,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT
           membership.vault_id AS vaultId,
           membership.user_id AS membershipUserId,
           membership.status AS membershipStatus,
           users.status AS userStatus,
           devices.user_id AS deviceUserId,
           devices.status AS deviceStatus
         FROM memberships AS membership
         INNER JOIN users ON users.id = membership.user_id
         INNER JOIN devices ON devices.id = ?
         WHERE membership.id = ?`,
      )
      .get(actor.deviceId, actor.memberId) as
      | ActorRow
      | undefined;

    if (
      row === undefined ||
      row.vaultId !== header.vaultId ||
      row.membershipUserId !== row.deviceUserId ||
      row.membershipStatus !== 'active' ||
      row.userStatus !== 'active' ||
      row.deviceStatus !== 'approved'
    ) {
      throw new RevisionRepositoryError(
        ERROR_CODES.FORBIDDEN,
        'Authenticated member or device is not active for this vault.',
      );
    }
  }

  #getVault(vaultId: string): VaultRow {
    const row = this.#database
      .prepare(
        `SELECT
           write_epoch AS writeEpoch,
           next_server_sequence AS nextServerSequence
         FROM vaults
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(vaultId) as VaultRow | undefined;

    if (row === undefined) {
      throw new RevisionRepositoryError(
        ERROR_CODES.NOT_FOUND,
        `Vault ${vaultId} was not found.`,
      );
    }

    return row;
  }

  #getIdempotencyRecord(
    prepared: PreparedCommit,
  ): IdempotencyRow | undefined {
    return this.#database
      .prepare(
        `SELECT
           request_hash AS requestHash,
           response_body AS responseBody
         FROM idempotency_records
         WHERE device_id = ? AND idempotency_key = ?`,
      )
      .get(prepared.actor.deviceId, prepared.idempotencyKey) as
      | IdempotencyRow
      | undefined;
  }

  #assertIdempotencyRequest(
    stored: IdempotencyRow,
    prepared: PreparedCommit,
  ): void {
    if (stored.requestHash !== prepared.requestHash) {
      throw new RevisionRepositoryError(
        'IDEMPOTENCY_KEY_REUSE',
        'Idempotency key was already used for another request.',
      );
    }
  }

  #validateAndPrepareFileGraph(
    prepared: PreparedCommit,
    serverTime: string,
  ): void {
    const { fileId, parentRevisionIds, vaultId } = prepared.header;
    const file = this.#database
      .prepare(
        `SELECT vault_id AS vaultId
         FROM files
         WHERE id = ?`,
      )
      .get(fileId) as FileRow | undefined;

    if (parentRevisionIds.length === 0) {
      if (file !== undefined) {
        const code: RevisionRepositoryErrorCode =
          file.vaultId === vaultId
            ? 'FILE_ALREADY_EXISTS'
            : 'PARENT_FILE_MISMATCH';
        throw new RevisionRepositoryError(
          code,
          `File ${fileId} already exists.`,
        );
      }

      this.#database
        .prepare(
          `INSERT INTO files (id, vault_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(fileId, vaultId, serverTime);
      return;
    }

    if (file === undefined) {
      throw new RevisionRepositoryError(
        ERROR_CODES.MISSING_PARENT,
        `File ${fileId} has no committed parent revisions.`,
      );
    }
    if (file.vaultId !== vaultId) {
      throw new RevisionRepositoryError(
        'PARENT_FILE_MISMATCH',
        `File ${fileId} belongs to another vault.`,
      );
    }

    const findParent = this.#database.prepare(
      `SELECT id AS revisionId, vault_id AS vaultId, file_id AS fileId
       FROM revisions
       WHERE id = ?`,
    );
    for (const parentId of parentRevisionIds) {
      const parent = findParent.get(parentId) as ParentRow | undefined;
      if (parent === undefined) {
        throw new RevisionRepositoryError(
          ERROR_CODES.MISSING_PARENT,
          `Parent revision ${parentId} does not exist.`,
        );
      }
      if (parent.vaultId !== vaultId || parent.fileId !== fileId) {
        throw new RevisionRepositoryError(
          'PARENT_FILE_MISMATCH',
          `Parent revision ${parentId} belongs to another vault or file.`,
        );
      }
    }

    if (parentRevisionIds.length >= 2) {
      const currentHeads = this.getHeads(vaultId, fileId);
      if (!sameStringArray(currentHeads, parentRevisionIds)) {
        throw new RevisionRepositoryError(
          ERROR_CODES.HEAD_SET_CHANGED,
          'Reconciliation parents no longer match the exact current head set.',
        );
      }
    }
  }

  #insertIdempotencyRecord(
    prepared: PreparedCommit,
    result: CommitRevisionResult,
    responseStatus: number,
    now: Date,
  ): void {
    const expiresAt = new Date(
      now.getTime() + this.#idempotencyTtlMs,
    ).toISOString();
    this.#database
      .prepare(
        `INSERT INTO idempotency_records (
           device_id,
           idempotency_key,
           request_hash,
           response_status,
           response_body,
           created_at,
           expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prepared.actor.deviceId,
        prepared.idempotencyKey,
        prepared.requestHash,
        responseStatus,
        JSON.stringify(result),
        now.toISOString(),
        expiresAt,
      );
  }

  #readNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new RevisionRepositoryError(
        'REPOSITORY_INTEGRITY',
        'Repository clock returned an invalid date.',
      );
    }
    return now;
  }

  #parseEventRow(row: EventRow): StoredRevisionEvent {
    try {
      if (row.eventType !== 'revision-accepted') {
        throw new TypeError(`Unsupported event type ${row.eventType}.`);
      }
      const parsed = JSON.parse(row.eventPayload) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new TypeError('Event payload must be an object.');
      }

      const record = parsed as Record<string, unknown>;
      if (typeof record.fileId !== 'string') {
        throw new TypeError('Event file ID is invalid.');
      }
      const receipt = opaqueBlobReceiptSchema.parse(record.receipt);
      if (
        receipt.revisionId !== row.revisionId ||
        receipt.serverSequence !== row.serverSequence
      ) {
        throw new TypeError('Event receipt does not match its cursor row.');
      }

      return {
        fileId: record.fileId,
        receipt,
        revisionId: row.revisionId,
        serverSequence: row.serverSequence,
        type: 'revision-accepted',
      };
    } catch (error) {
      throw new RevisionRepositoryError(
        'REPOSITORY_INTEGRITY',
        `Stored event ${row.serverSequence} is invalid.`,
        { cause: error },
      );
    }
  }
}
