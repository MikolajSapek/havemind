import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  generateAccessToken,
  hashAccessToken,
  hashRefreshToken,
  parseAccessToken,
  parseRefreshRotationId,
  parseRefreshToken,
  tokenHashesEqual,
  validateAccessTokenTtl,
  validateRefreshTokenTtl,
  type AccessToken,
  type RefreshRotationId,
  type RefreshToken,
} from './tokens.js';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type SessionRepositoryErrorCode =
  | 'INVALID_CLOCK'
  | 'INVALID_INPUT'
  | 'INVALID_REFRESH'
  | 'NOT_FOUND'
  | 'REFRESH_REUSE_DETECTED'
  | 'REPOSITORY_INTEGRITY'
  | 'SESSION_REVOKED';

const ERROR_MESSAGES: Readonly<Record<SessionRepositoryErrorCode, string>> = {
  INVALID_CLOCK: 'The server clock is invalid.',
  INVALID_INPUT: 'Invalid session input.',
  INVALID_REFRESH: 'Invalid refresh session.',
  NOT_FOUND: 'Session target not found.',
  REFRESH_REUSE_DETECTED: 'Refresh token reuse was detected.',
  REPOSITORY_INTEGRITY: 'Stored session state is invalid.',
  SESSION_REVOKED: 'The session is revoked.',
};

/** A deliberately secret-free session error safe to log or serialize. */
export class SessionRepositoryError extends Error {
  public readonly code: SessionRepositoryErrorCode;

  public constructor(code: SessionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SessionRepositoryError';
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: string;
    code: SessionRepositoryErrorCode;
    message: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

export interface SessionRepositoryOptions {
  readonly accessTokenTtlSeconds?: number;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export interface CreateInitialSessionInput {
  readonly deviceId: string;
  readonly initialRefreshToken: string;
  readonly refreshTokenTtlSeconds: number;
  readonly userId: string;
}

export interface InitialSessionResult {
  readonly accessExpiresAt: string;
  readonly accessToken: AccessToken;
  readonly familyId: string;
  readonly refreshExpiresAt: string;
}

export interface RotateRefreshInput {
  readonly currentRefreshToken: string;
  readonly rotationId: string;
  readonly successorRefreshToken: string;
}

export interface RotateRefreshResult {
  readonly accessExpiresAt: string;
  readonly accessToken: AccessToken;
  readonly familyId: string;
  readonly generation: number;
  readonly wasRetry: boolean;
}

export interface AccessSession {
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly familyId: string;
  readonly userId: string;
}

export interface CreateInitialFamilyFromHashInput {
  readonly deviceId: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenTtlSeconds: number;
  readonly userId: string;
}

export interface InitialFamilyResult {
  readonly familyId: string;
  readonly refreshExpiresAt: string;
}

export interface RefreshContext {
  readonly deviceId: string;
  readonly familyId: string;
  readonly userId: string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

interface RefreshRow {
  readonly consumedAt: string | null;
  readonly deviceId: string;
  readonly deviceStatus: string;
  readonly familyExpiresAt: string;
  readonly familyId: string;
  readonly familyStatus: string;
  readonly generation: number;
  readonly refreshExpiresAt: string;
  readonly refreshId: string;
  readonly rotationId: string | null;
  readonly successorTokenHash: string | null;
  readonly currentGeneration: number;
  readonly userId: string;
  readonly userStatus: string;
}

interface AccessRow {
  readonly accessExpiresAt: string;
  readonly accessRevokedAt: string | null;
  readonly deviceId: string;
  readonly deviceStatus: string;
  readonly familyExpiresAt: string;
  readonly familyId: string;
  readonly familyStatus: string;
  readonly userId: string;
  readonly userStatus: string;
}

interface IssuedAccess {
  readonly accessExpiresAt: string;
  readonly accessToken: AccessToken;
}

interface PreparedRotation {
  readonly currentTokenHash: string;
  readonly rotationId: string;
  readonly successorTokenHash: string;
}

type RotationTransactionResult =
  | { readonly kind: 'reuse' }
  | {
      readonly kind: 'success';
      readonly access: IssuedAccess;
      readonly familyId: string;
      readonly generation: number;
      readonly wasRetry: boolean;
    };

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new SessionRepositoryError('INVALID_INPUT');
  }
  return value;
}

function requireStoredUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
  }
  return value;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
  }
  return value;
}

function readClock(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SessionRepositoryError('INVALID_CLOCK');
  }
  return value;
}

function requireStoredDate(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
  }
  return milliseconds;
}

function addSeconds(date: Date, seconds: number): string {
  const milliseconds = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new SessionRepositoryError('INVALID_CLOCK');
  }
  return new Date(milliseconds).toISOString();
}

function prepareRotation(input: RotateRefreshInput): PreparedRotation {
  let current: RefreshToken;
  try {
    current = parseRefreshToken(input.currentRefreshToken);
  } catch {
    throw new SessionRepositoryError('INVALID_REFRESH');
  }
  let successor: RefreshToken;
  let rotationId: RefreshRotationId;
  try {
    successor = parseRefreshToken(input.successorRefreshToken);
    rotationId = parseRefreshRotationId(input.rotationId);
  } catch {
    throw new SessionRepositoryError('INVALID_INPUT');
  }
  if (current === successor) {
    throw new SessionRepositoryError('INVALID_INPUT');
  }
  return {
    currentTokenHash: hashRefreshToken(current),
    rotationId,
    successorTokenHash: hashRefreshToken(successor),
  };
}

function parseRefreshForInitial(value: string): string {
  try {
    return hashRefreshToken(parseRefreshToken(value));
  } catch {
    throw new SessionRepositoryError('INVALID_REFRESH');
  }
}

/** Durable refresh families and short-lived access-token lookups. */
export class SessionRepository {
  readonly #database: Database.Database;
  readonly #accessTokenTtlSeconds: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;

  public constructor(
    database: Database.Database,
    options: SessionRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#randomUuid = options.randomUuid ?? randomUUID;
    try {
      this.#accessTokenTtlSeconds = validateAccessTokenTtl(
        options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      );
    } catch {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
  }

  /**
   * Creates generation zero inside the caller's existing write transaction.
   * This is intentionally unavailable outside a transaction so pairing and
   * session creation cannot become partially durable.
   */
  public createInitialSessionInCurrentTransaction(
    input: CreateInitialSessionInput,
  ): InitialSessionResult {
    if (!this.#database.inTransaction) {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
    const userId = requireUuid(input.userId);
    const deviceId = requireUuid(input.deviceId);
    const tokenHash = parseRefreshForInitial(input.initialRefreshToken);
    let refreshTtl: number;
    try {
      refreshTtl = validateRefreshTokenTtl(input.refreshTokenTtlSeconds);
    } catch {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
    if (refreshTtl < this.#accessTokenTtlSeconds) {
      throw new SessionRepositoryError('INVALID_INPUT');
    }

    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const refreshExpiresAt = addSeconds(now, refreshTtl);
    const familyId = this.#newUuid();
    const refreshId = this.#newUuid();
    this.#database
      .prepare(
        `INSERT INTO refresh_token_families (
           id, user_id, device_id, status, current_generation,
           created_at, expires_at, revoked_at
         ) VALUES (?, ?, ?, 'active', 0, ?, ?, NULL)`,
      )
      .run(familyId, userId, deviceId, createdAt, refreshExpiresAt);
    this.#database
      .prepare(
        `INSERT INTO refresh_tokens (
           id, family_id, generation, token_hash, created_at,
           consumed_at, rotation_id, successor_token_hash, expires_at
         ) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(refreshId, familyId, tokenHash, createdAt, refreshExpiresAt);
    const access = this.#issueAccess(
      familyId,
      userId,
      deviceId,
      now,
      refreshExpiresAt,
    );
    return { ...access, familyId, refreshExpiresAt };
  }

  /**
   * Creates generation zero from a stored refresh-token hash without minting an
   * access token. The onboarding flow binds the joining device's own refresh
   * token at redemption time (hash only) and activates its family here, at owner
   * approval, so the invitee — never the owner — holds the raw secret.
   */
  public createInitialFamilyFromHashInCurrentTransaction(
    input: CreateInitialFamilyFromHashInput,
  ): InitialFamilyResult {
    if (!this.#database.inTransaction) {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
    const userId = requireUuid(input.userId);
    const deviceId = requireUuid(input.deviceId);
    if (
      typeof input.refreshTokenHash !== 'string' ||
      !SHA256_HEX_PATTERN.test(input.refreshTokenHash)
    ) {
      throw new SessionRepositoryError('INVALID_REFRESH');
    }
    let refreshTtl: number;
    try {
      refreshTtl = validateRefreshTokenTtl(input.refreshTokenTtlSeconds);
    } catch {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
    if (refreshTtl < this.#accessTokenTtlSeconds) {
      throw new SessionRepositoryError('INVALID_INPUT');
    }

    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const refreshExpiresAt = addSeconds(now, refreshTtl);
    const familyId = this.#newUuid();
    const refreshId = this.#newUuid();
    this.#database
      .prepare(
        `INSERT INTO refresh_token_families (
           id, user_id, device_id, status, current_generation,
           created_at, expires_at, revoked_at
         ) VALUES (?, ?, ?, 'active', 0, ?, ?, NULL)`,
      )
      .run(familyId, userId, deviceId, createdAt, refreshExpiresAt);
    this.#database
      .prepare(
        `INSERT INTO refresh_tokens (
           id, family_id, generation, token_hash, created_at,
           consumed_at, rotation_id, successor_token_hash, expires_at
         ) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(refreshId, familyId, input.refreshTokenHash, createdAt, refreshExpiresAt);
    return { familyId, refreshExpiresAt };
  }

  /**
   * Resolves the identity behind a live refresh token without rotating it.
   * Bootstrap paging uses this so the joining device can stream its initial
   * download from its own refresh token before it holds an access token, while
   * a consumed, superseded, expired, or revoked token resolves to null.
   */
  public lookupRefreshContext(rawRefreshToken: string): RefreshContext | null {
    let tokenHash: string;
    try {
      tokenHash = hashRefreshToken(parseRefreshToken(rawRefreshToken));
    } catch {
      return null;
    }
    const now = readClock(this.#now).getTime();
    const row = this.#database
      .prepare(
        `SELECT tokens.generation AS generation,
                tokens.consumed_at AS consumedAt,
                tokens.expires_at AS refreshExpiresAt,
                families.id AS familyId,
                families.user_id AS userId,
                families.device_id AS deviceId,
                families.status AS familyStatus,
                families.current_generation AS currentGeneration,
                families.expires_at AS familyExpiresAt,
                users.status AS userStatus,
                devices.status AS deviceStatus
         FROM refresh_tokens AS tokens
         INNER JOIN refresh_token_families AS families
           ON families.id = tokens.family_id
         INNER JOIN users ON users.id = families.user_id
         INNER JOIN devices ON devices.id = families.device_id
         WHERE tokens.token_hash = ?`,
      )
      .get(tokenHash) as RefreshRow | undefined;
    if (row === undefined || row.consumedAt !== null) {
      return null;
    }
    if (
      requireStoredDate(row.refreshExpiresAt) <= now ||
      requireStoredDate(row.familyExpiresAt) <= now ||
      row.familyStatus !== 'active' ||
      row.userStatus !== 'active' ||
      row.deviceStatus !== 'approved' ||
      requireGeneration(row.generation) !== requireGeneration(row.currentGeneration)
    ) {
      return null;
    }
    return {
      deviceId: requireStoredUuid(row.deviceId),
      familyId: requireStoredUuid(row.familyId),
      userId: requireStoredUuid(row.userId),
    };
  }

  public rotateRefresh(input: RotateRefreshInput): RotateRefreshResult {
    const prepared = prepareRotation(input);
    const now = readClock(this.#now);
    const rotate = this.#database.transaction((): RotationTransactionResult =>
      this.#rotateInTransaction(prepared, now),
    );
    const result = rotate.immediate();
    if (result.kind === 'reuse') {
      throw new SessionRepositoryError('REFRESH_REUSE_DETECTED');
    }
    return {
      ...result.access,
      familyId: result.familyId,
      generation: result.generation,
      wasRetry: result.wasRetry,
    };
  }

  public lookupAccess(rawAccessToken: string): AccessSession | null {
    let tokenHash: string;
    try {
      tokenHash = hashAccessToken(parseAccessToken(rawAccessToken));
    } catch {
      return null;
    }
    const now = readClock(this.#now).getTime();
    const row = this.#database
      .prepare(
        `SELECT access.user_id AS userId,
                access.device_id AS deviceId,
                access.family_id AS familyId,
                access.expires_at AS accessExpiresAt,
                access.revoked_at AS accessRevokedAt,
                families.status AS familyStatus,
                families.expires_at AS familyExpiresAt,
                users.status AS userStatus,
                devices.status AS deviceStatus
         FROM access_tokens AS access
         INNER JOIN refresh_token_families AS families
           ON families.id = access.family_id
         INNER JOIN users ON users.id = access.user_id
         INNER JOIN devices ON devices.id = access.device_id
         WHERE access.token_hash = ?`,
      )
      .get(tokenHash) as AccessRow | undefined;
    if (row === undefined) {
      return null;
    }
    const accessExpiry = requireStoredDate(row.accessExpiresAt);
    const familyExpiry = requireStoredDate(row.familyExpiresAt);
    if (
      row.accessRevokedAt !== null ||
      row.familyStatus !== 'active' ||
      row.userStatus !== 'active' ||
      row.deviceStatus !== 'approved' ||
      accessExpiry <= now ||
      familyExpiry <= now
    ) {
      return null;
    }
    return {
      deviceId: requireStoredUuid(row.deviceId),
      expiresAt: row.accessExpiresAt,
      familyId: requireStoredUuid(row.familyId),
      userId: requireStoredUuid(row.userId),
    };
  }

  public revokeSession(familyId: string): void {
    requireUuid(familyId);
    const now = readClock(this.#now).toISOString();
    const revoke = this.#database.transaction(() => {
      const family = this.#database
        .prepare('SELECT id FROM refresh_token_families WHERE id = ?')
        .get(familyId) as { id: string } | undefined;
      if (family === undefined) {
        return false;
      }
      this.#database
        .prepare(
          `UPDATE refresh_token_families
           SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
           WHERE id = ?`,
        )
        .run(now, familyId);
      this.#database
        .prepare(
          `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?)
           WHERE family_id = ?`,
        )
        .run(now, familyId);
      return true;
    });
    if (!revoke.immediate()) {
      throw new SessionRepositoryError('NOT_FOUND');
    }
  }

  public revokeDevice(deviceId: string): void {
    requireUuid(deviceId);
    const revoke = this.#database.transaction(() => {
      const device = this.#database
        .prepare('SELECT id FROM devices WHERE id = ?')
        .get(deviceId) as { id: string } | undefined;
      if (device === undefined) {
        return false;
      }
      this.revokeDeviceInCurrentTransaction(deviceId);
      return true;
    });
    if (!revoke.immediate()) {
      throw new SessionRepositoryError('NOT_FOUND');
    }
  }

  /**
   * Revokes a device and burns every session bound to it — the device row, all
   * its refresh families, and all its access tokens — inside the caller's
   * existing write transaction. This is the primitive membership revocation
   * composes over, so flipping the membership row and killing each of the
   * member's devices is one atomic write. Unavailable outside a transaction so
   * a partial revocation can never become durable (mirrors the other
   * `…InCurrentTransaction` methods).
   */
  public revokeDeviceInCurrentTransaction(deviceId: string): void {
    if (!this.#database.inTransaction) {
      throw new SessionRepositoryError('INVALID_INPUT');
    }
    requireUuid(deviceId);
    const now = readClock(this.#now).toISOString();
    this.#database
      .prepare(
        `UPDATE devices
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
      )
      .run(now, deviceId);
    this.#database
      .prepare(
        `UPDATE refresh_token_families
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE device_id = ?`,
      )
      .run(now, deviceId);
    this.#database
      .prepare(
        `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?)
         WHERE device_id = ?`,
      )
      .run(now, deviceId);
  }

  #rotateInTransaction(
    prepared: PreparedRotation,
    now: Date,
  ): RotationTransactionResult {
    const row = this.#database
      .prepare(
        `SELECT tokens.id AS refreshId,
                tokens.generation AS generation,
                tokens.consumed_at AS consumedAt,
                tokens.rotation_id AS rotationId,
                tokens.successor_token_hash AS successorTokenHash,
                tokens.expires_at AS refreshExpiresAt,
                families.id AS familyId,
                families.user_id AS userId,
                families.device_id AS deviceId,
                families.status AS familyStatus,
                families.current_generation AS currentGeneration,
                families.expires_at AS familyExpiresAt,
                users.status AS userStatus,
                devices.status AS deviceStatus
         FROM refresh_tokens AS tokens
         INNER JOIN refresh_token_families AS families
           ON families.id = tokens.family_id
         INNER JOIN users ON users.id = families.user_id
         INNER JOIN devices ON devices.id = families.device_id
         WHERE tokens.token_hash = ?`,
      )
      .get(prepared.currentTokenHash) as RefreshRow | undefined;
    if (row === undefined) {
      throw new SessionRepositoryError('INVALID_REFRESH');
    }
    const nowMilliseconds = now.getTime();
    if (
      requireStoredDate(row.refreshExpiresAt) <= nowMilliseconds ||
      requireStoredDate(row.familyExpiresAt) <= nowMilliseconds
    ) {
      throw new SessionRepositoryError('INVALID_REFRESH');
    }
    if (
      row.familyStatus !== 'active' ||
      row.userStatus !== 'active' ||
      row.deviceStatus !== 'approved'
    ) {
      throw new SessionRepositoryError('SESSION_REVOKED');
    }
    const generation = requireGeneration(row.generation);
    const currentGeneration = requireGeneration(row.currentGeneration);
    requireStoredUuid(row.familyId);
    requireStoredUuid(row.userId);
    requireStoredUuid(row.deviceId);

    if (row.consumedAt !== null) {
      const exactRetry =
        row.rotationId === prepared.rotationId &&
        row.successorTokenHash !== null &&
        tokenHashesEqual(
          row.successorTokenHash,
          prepared.successorTokenHash,
        ) &&
        currentGeneration === generation + 1 &&
        this.#successorExists(
          row.familyId,
          generation + 1,
          prepared.successorTokenHash,
        );
      if (!exactRetry) {
        this.#markReuse(row.familyId, now.toISOString());
        return { kind: 'reuse' };
      }
      return {
        access: this.#issueAccess(
          row.familyId,
          row.userId,
          row.deviceId,
          now,
          row.familyExpiresAt,
        ),
        familyId: row.familyId,
        generation: generation + 1,
        kind: 'success',
        wasRetry: true,
      };
    }

    if (generation !== currentGeneration) {
      this.#markReuse(row.familyId, now.toISOString());
      return { kind: 'reuse' };
    }
    const collision = this.#database
      .prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?')
      .get(prepared.successorTokenHash) as { id: string } | undefined;
    if (collision !== undefined) {
      this.#markReuse(row.familyId, now.toISOString());
      return { kind: 'reuse' };
    }

    const consumed = this.#database
      .prepare(
        `UPDATE refresh_tokens
         SET consumed_at = ?, rotation_id = ?, successor_token_hash = ?
         WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(
        now.toISOString(),
        prepared.rotationId,
        prepared.successorTokenHash,
        row.refreshId,
      );
    if (consumed.changes !== 1) {
      throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
    }
    const nextGeneration = generation + 1;
    if (!Number.isSafeInteger(nextGeneration)) {
      throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
    }
    this.#database
      .prepare(
        `INSERT INTO refresh_tokens (
           id, family_id, generation, token_hash, created_at,
           consumed_at, rotation_id, successor_token_hash, expires_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        this.#newUuid(),
        row.familyId,
        nextGeneration,
        prepared.successorTokenHash,
        now.toISOString(),
        row.familyExpiresAt,
      );
    const advanced = this.#database
      .prepare(
        `UPDATE refresh_token_families SET current_generation = ?
         WHERE id = ? AND status = 'active' AND current_generation = ?`,
      )
      .run(nextGeneration, row.familyId, generation);
    if (advanced.changes !== 1) {
      throw new SessionRepositoryError('REPOSITORY_INTEGRITY');
    }
    return {
      access: this.#issueAccess(
        row.familyId,
        row.userId,
        row.deviceId,
        now,
        row.familyExpiresAt,
      ),
      familyId: row.familyId,
      generation: nextGeneration,
      kind: 'success',
      wasRetry: false,
    };
  }

  #successorExists(
    familyId: string,
    generation: number,
    tokenHash: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          `SELECT id FROM refresh_tokens
           WHERE family_id = ? AND generation = ? AND token_hash = ?`,
        )
        .get(familyId, generation, tokenHash) !== undefined
    );
  }

  #markReuse(familyId: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE refresh_token_families
         SET status = 'reuse-detected', revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
      )
      .run(now, familyId);
    this.#database
      .prepare(
        `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?)
         WHERE family_id = ?`,
      )
      .run(now, familyId);
  }

  #issueAccess(
    familyId: string,
    userId: string,
    deviceId: string,
    now: Date,
    familyExpiresAt: string,
  ): IssuedAccess {
    const accessToken = generateAccessToken();
    const requestedExpiry = addSeconds(now, this.#accessTokenTtlSeconds);
    const accessExpiresAt =
      requireStoredDate(familyExpiresAt) < requireStoredDate(requestedExpiry)
        ? familyExpiresAt
        : requestedExpiry;
    if (requireStoredDate(accessExpiresAt) <= now.getTime()) {
      throw new SessionRepositoryError('SESSION_REVOKED');
    }
    this.#database
      .prepare(
        `INSERT INTO access_tokens (
           id, family_id, user_id, device_id, token_hash,
           created_at, expires_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        this.#newUuid(),
        familyId,
        userId,
        deviceId,
        hashAccessToken(accessToken),
        now.toISOString(),
        accessExpiresAt,
      );
    return { accessExpiresAt, accessToken };
  }

  #newUuid(): string {
    return requireUuid(this.#randomUuid());
  }
}
