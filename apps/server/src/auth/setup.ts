import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { SessionRepository } from './session-repository.js';
import {
  generatePairingToken,
  hashPairingToken,
  parsePairingToken,
  type AccessToken,
  type PairingToken,
} from './tokens.js';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Owner pairing tokens live for exactly 15 minutes (plan 03, single-use). */
export const OWNER_PAIRING_TTL_SECONDS = 15 * 60;
const MAX_DISPLAY_NAME_LENGTH = 80;
const PUBLIC_KEY_LENGTH = 32;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_CHARACTER_CEILING = 0x20;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < CONTROL_CHARACTER_CEILING) {
      return true;
    }
  }
  return false;
}

export type OwnerSetupErrorCode =
  | 'ALREADY_INITIALIZED'
  | 'INVALID_CLOCK'
  | 'INVALID_INPUT'
  | 'INVALID_PAIRING'
  | 'LOCAL_CONTEXT_REQUIRED'
  | 'NOT_INITIALIZED';

const ERROR_MESSAGES: Readonly<Record<OwnerSetupErrorCode, string>> = {
  ALREADY_INITIALIZED: 'The instance owner is already initialized.',
  INVALID_CLOCK: 'The server clock is invalid.',
  INVALID_INPUT: 'Invalid owner setup input.',
  INVALID_PAIRING: 'Invalid owner pairing.',
  LOCAL_CONTEXT_REQUIRED: 'A local CLI capability is required.',
  NOT_INITIALIZED: 'The instance owner has not been initialized yet.',
};

/** A deliberately secret-free setup error safe to log or serialize. */
export class OwnerSetupError extends Error {
  public readonly code: OwnerSetupErrorCode;

  public constructor(code: OwnerSetupErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OwnerSetupError';
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: string;
    code: OwnerSetupErrorCode;
    message: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

/**
 * A non-serializable proof that owner setup is being driven from the local
 * server CLI. The marker lives only in this module's {@link localContexts}
 * registry, so a plain `{ kind: 'local-cli' }` object (or anything crossing a
 * network/JSON boundary) can never impersonate it.
 */
export interface LocalOwnerSetupContext {
  readonly kind: 'local-cli';
}

const localContexts = new WeakSet<object>();

export function createLocalOwnerSetupContext(): LocalOwnerSetupContext {
  const context: LocalOwnerSetupContext = { kind: 'local-cli' };
  localContexts.add(context);
  return context;
}

export interface OwnerSetupServiceOptions {
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export interface InitializeOwnerInput {
  readonly ownerDisplayName: string;
  readonly vaultDisplayName: string;
}

export interface InitializeOwnerResult {
  readonly instanceId: string;
  readonly membershipId: string;
  readonly ownerUserId: string;
  readonly pairingExpiresAt: string;
  readonly pairingToken: string;
  readonly serverEpoch: string;
}

export interface PairOwnerDeviceInput {
  readonly deviceDisplayName: string;
  readonly deviceId: string;
  readonly initialRefreshToken: string;
  readonly pairingToken: string;
  readonly publicKey: Buffer;
}

export interface PairOwnerDeviceResult {
  readonly accessExpiresAt: string;
  readonly accessToken: AccessToken;
  readonly deviceId: string;
  readonly familyId: string;
  readonly ownerUserId: string;
  readonly refreshExpiresAt: string;
}

export interface PairOwnerDeviceFromHashInput {
  readonly deviceDisplayName: string;
  readonly deviceId: string;
  readonly pairingToken: string;
  readonly publicKey: Buffer;
  readonly refreshTokenHash: string;
}

export interface PairOwnerDeviceFromHashResult {
  readonly deviceId: string;
  readonly familyId: string;
  readonly ownerUserId: string;
  readonly refreshExpiresAt: string;
  /**
   * The vault carried by the consumed pairing row. An owner can hold several
   * vaults (each `create-vault` mints its own pairing), so the caller must bind
   * the connection to THIS pairing's vault, never the owner's first/oldest one.
   */
  readonly vaultId: string;
}

export interface CreateVaultInput {
  readonly ownerDisplayName: string;
  readonly vaultDisplayName: string;
}

export interface CreateVaultResult {
  readonly membershipId: string;
  readonly ownerUserId: string;
  readonly pairingExpiresAt: string;
  readonly pairingToken: string;
  readonly vaultId: string;
}

export interface RotateOwnerPairingResult {
  readonly ownerUserId: string;
  readonly pairingExpiresAt: string;
  readonly pairingToken: string;
  readonly vaultId: string;
}

interface PairingRow {
  readonly consumedAt: string | null;
  readonly expiresAt: string;
  readonly id: string;
  readonly userId: string;
  readonly vaultId: string;
}

interface OwnerRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly vaultId: string;
}

function isLocalContext(value: unknown): value is LocalOwnerSetupContext {
  return (
    typeof value === 'object' && value !== null && localContexts.has(value)
  );
}

function requireDisplayName(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new OwnerSetupError('INVALID_INPUT');
  }
  return value;
}

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new OwnerSetupError('INVALID_INPUT');
  }
  return value;
}

function requirePublicKey(value: Buffer): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.length !== PUBLIC_KEY_LENGTH ||
    value.every((byte) => byte === 0)
  ) {
    throw new OwnerSetupError('INVALID_INPUT');
  }
  return value;
}

function requirePairingToken(value: string): PairingToken {
  try {
    return parsePairingToken(value);
  } catch {
    throw new OwnerSetupError('INVALID_PAIRING');
  }
}

function readClock(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new OwnerSetupError('INVALID_CLOCK');
  }
  return value;
}

function addSeconds(date: Date, seconds: number): string {
  const milliseconds = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new OwnerSetupError('INVALID_CLOCK');
  }
  return new Date(milliseconds).toISOString();
}

/** Initializes the single instance owner and pairs their first device. */
export class OwnerSetupService {
  readonly #database: Database.Database;
  readonly #accessTokenTtlSeconds: number;
  readonly #refreshTokenTtlSeconds: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #sessions: SessionRepository;

  public constructor(
    database: Database.Database,
    options: OwnerSetupServiceOptions = {},
  ) {
    this.#database = database;
    this.#accessTokenTtlSeconds =
      options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.#refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    this.#now = options.now ?? (() => new Date());
    this.#randomUuid = options.randomUuid ?? randomUUID;
    this.#sessions = new SessionRepository(database, {
      accessTokenTtlSeconds: this.#accessTokenTtlSeconds,
      now: this.#now,
      randomUuid: this.#randomUuid,
    });
  }

  public initializeOwner(
    context: LocalOwnerSetupContext,
    input: InitializeOwnerInput,
  ): InitializeOwnerResult {
    if (!isLocalContext(context)) {
      throw new OwnerSetupError('LOCAL_CONTEXT_REQUIRED');
    }
    const ownerDisplayName = requireDisplayName(input.ownerDisplayName);
    const vaultDisplayName = requireDisplayName(input.vaultDisplayName);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const pairingExpiresAt = addSeconds(now, OWNER_PAIRING_TTL_SECONDS);
    const pairingToken = generatePairingToken();
    const pairingTokenHash = hashPairingToken(pairingToken);

    const initialize = this.#database.transaction((): InitializeOwnerResult => {
      const existing = this.#database
        .prepare('SELECT COUNT(*) AS count FROM instance_state')
        .get() as { count: number };
      if (existing.count > 0) {
        throw new OwnerSetupError('ALREADY_INITIALIZED');
      }
      const instanceId = this.#newUuid();
      const serverEpoch = this.#newUuid();
      const ownerUserId = this.#newUuid();
      const vaultId = this.#newUuid();
      const membershipId = this.#newUuid();
      const pairingId = this.#newUuid();

      this.#database
        .prepare(
          `INSERT INTO instance_state (
             singleton, instance_id, server_epoch, restore_epoch, initialized_at
           ) VALUES (1, ?, ?, 0, ?)`,
        )
        .run(instanceId, serverEpoch, createdAt);
      this.#database
        .prepare(
          `INSERT INTO users (
             id, display_name, is_instance_owner, status, created_at, revoked_at
           ) VALUES (?, ?, 1, 'active', ?, NULL)`,
        )
        .run(ownerUserId, ownerDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO vaults (
             id, display_name, write_epoch, next_server_sequence,
             created_at, deleted_at
           ) VALUES (?, ?, 0, 1, ?, NULL)`,
        )
        .run(vaultId, vaultDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO memberships (
             id, vault_id, user_id, role, status, created_at, revoked_at
           ) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
        )
        .run(membershipId, vaultId, ownerUserId, createdAt);
      this.#database
        .prepare(
          `INSERT INTO owner_pairings (
             id, user_id, vault_id, membership_id, token_hash,
             created_at, expires_at, consumed_at, consumed_by_device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          pairingId,
          ownerUserId,
          vaultId,
          membershipId,
          pairingTokenHash,
          createdAt,
          pairingExpiresAt,
        );

      return {
        instanceId,
        membershipId,
        ownerUserId,
        pairingExpiresAt,
        pairingToken,
        serverEpoch,
      };
    });

    return initialize.immediate();
  }

  public pairOwnerDevice(input: PairOwnerDeviceInput): PairOwnerDeviceResult {
    const deviceId = requireUuid(input.deviceId);
    const deviceDisplayName = requireDisplayName(input.deviceDisplayName);
    const publicKey = requirePublicKey(input.publicKey);
    const pairingToken = requirePairingToken(input.pairingToken);
    const pairingTokenHash = hashPairingToken(pairingToken);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();

    const pair = this.#database.transaction((): PairOwnerDeviceResult => {
      const pairing = this.#database
        .prepare(
          `SELECT id, user_id AS userId,
                  expires_at AS expiresAt, consumed_at AS consumedAt
           FROM owner_pairings WHERE token_hash = ?`,
        )
        .get(pairingTokenHash) as PairingRow | undefined;
      if (
        pairing === undefined ||
        pairing.consumedAt !== null ||
        Date.parse(pairing.expiresAt) <= now.getTime()
      ) {
        throw new OwnerSetupError('INVALID_PAIRING');
      }

      this.#database
        .prepare(
          `INSERT INTO devices (
             id, user_id, display_name, public_key, status,
             created_at, approved_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
        )
        .run(deviceId, pairing.userId, deviceDisplayName, publicKey, createdAt, createdAt);

      const session = this.#sessions.createInitialSessionInCurrentTransaction({
        deviceId,
        initialRefreshToken: input.initialRefreshToken,
        refreshTokenTtlSeconds: this.#refreshTokenTtlSeconds,
        userId: pairing.userId,
      });

      this.#database
        .prepare(
          `UPDATE owner_pairings
           SET consumed_at = ?, consumed_by_device_id = ?
           WHERE id = ?`,
        )
        .run(createdAt, deviceId, pairing.id);

      return {
        accessExpiresAt: session.accessExpiresAt,
        accessToken: session.accessToken,
        deviceId,
        familyId: session.familyId,
        ownerUserId: pairing.userId,
        refreshExpiresAt: session.refreshExpiresAt,
      };
    });

    return pair.immediate();
  }

  /**
   * Onboarding-friendly owner pairing: binds the refresh family to a client-held
   * refresh-token *hash* (the raw token never reaches the server) and mints no
   * access token — the device rotates via `/auth/refresh` to obtain access. This
   * mirrors the invitee redeem contract, so the owner's `/auth/refresh` succeeds.
   */
  public pairOwnerDeviceFromHash(
    input: PairOwnerDeviceFromHashInput,
  ): PairOwnerDeviceFromHashResult {
    const deviceId = requireUuid(input.deviceId);
    const deviceDisplayName = requireDisplayName(input.deviceDisplayName);
    const publicKey = requirePublicKey(input.publicKey);
    const pairingToken = requirePairingToken(input.pairingToken);
    const pairingTokenHash = hashPairingToken(pairingToken);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();

    const pair = this.#database.transaction(
      (): PairOwnerDeviceFromHashResult => {
        const pairing = this.#database
          .prepare(
            `SELECT id, user_id AS userId, vault_id AS vaultId,
                    expires_at AS expiresAt, consumed_at AS consumedAt
             FROM owner_pairings WHERE token_hash = ?`,
          )
          .get(pairingTokenHash) as PairingRow | undefined;
        if (
          pairing === undefined ||
          pairing.consumedAt !== null ||
          Date.parse(pairing.expiresAt) <= now.getTime()
        ) {
          throw new OwnerSetupError('INVALID_PAIRING');
        }

        this.#database
          .prepare(
            `INSERT INTO devices (
               id, user_id, display_name, public_key, status,
               created_at, approved_at, revoked_at
             ) VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
          )
          .run(deviceId, pairing.userId, deviceDisplayName, publicKey, createdAt, createdAt);

        const family = this.#sessions.createInitialFamilyFromHashInCurrentTransaction(
          {
            deviceId,
            refreshTokenHash: input.refreshTokenHash,
            refreshTokenTtlSeconds: this.#refreshTokenTtlSeconds,
            userId: pairing.userId,
          },
        );

        this.#database
          .prepare(
            `UPDATE owner_pairings
             SET consumed_at = ?, consumed_by_device_id = ?
             WHERE id = ?`,
          )
          .run(createdAt, deviceId, pairing.id);

        return {
          deviceId,
          familyId: family.familyId,
          ownerUserId: pairing.userId,
          refreshExpiresAt: family.refreshExpiresAt,
          vaultId: pairing.vaultId,
        };
      },
    );

    return pair.immediate();
  }

  /**
   * Creates an ADDITIONAL vault owned by a NEW, independent owner (Model B).
   *
   * The new owner is deliberately not the instance owner (`is_instance_owner = 0`),
   * so the `one_active_instance_owner` unique index — held by the original
   * bootstrap owner — stays intact. Requires the instance owner to be initialised.
   * In one transaction it mints the new user, vault, an active owner membership and
   * a fresh single-use owner pairing token, returning the plaintext token exactly
   * as owner setup does.
   */
  public createVault(input: CreateVaultInput): CreateVaultResult {
    const ownerDisplayName = requireDisplayName(input.ownerDisplayName);
    const vaultDisplayName = requireDisplayName(input.vaultDisplayName);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const pairingExpiresAt = addSeconds(now, OWNER_PAIRING_TTL_SECONDS);
    const pairingToken = generatePairingToken();
    const pairingTokenHash = hashPairingToken(pairingToken);

    const create = this.#database.transaction((): CreateVaultResult => {
      const owner = this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM users
           WHERE is_instance_owner = 1 AND status = 'active'`,
        )
        .get() as { count: number };
      if (owner.count === 0) {
        throw new OwnerSetupError('NOT_INITIALIZED');
      }
      const ownerUserId = this.#newUuid();
      const vaultId = this.#newUuid();
      const membershipId = this.#newUuid();
      const pairingId = this.#newUuid();

      this.#database
        .prepare(
          `INSERT INTO users (
             id, display_name, is_instance_owner, status, created_at, revoked_at
           ) VALUES (?, ?, 0, 'active', ?, NULL)`,
        )
        .run(ownerUserId, ownerDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO vaults (
             id, display_name, write_epoch, next_server_sequence,
             created_at, deleted_at
           ) VALUES (?, ?, 0, 1, ?, NULL)`,
        )
        .run(vaultId, vaultDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO memberships (
             id, vault_id, user_id, role, status, created_at, revoked_at
           ) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
        )
        .run(membershipId, vaultId, ownerUserId, createdAt);
      this.#database
        .prepare(
          `INSERT INTO owner_pairings (
             id, user_id, vault_id, membership_id, token_hash,
             created_at, expires_at, consumed_at, consumed_by_device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          pairingId,
          ownerUserId,
          vaultId,
          membershipId,
          pairingTokenHash,
          createdAt,
          pairingExpiresAt,
        );

      return {
        membershipId,
        ownerUserId,
        pairingExpiresAt,
        pairingToken,
        vaultId,
      };
    });

    return create.immediate();
  }

  /**
   * Invalidates any unconsumed owner pairing token for the single instance owner
   * and issues a fresh single-use one (15 minutes). Vault data, memberships and
   * already-consumed (used) pairings are left untouched. Requires the local CLI
   * capability.
   */
  public rotateOwnerPairing(
    context: LocalOwnerSetupContext,
  ): RotateOwnerPairingResult {
    if (!isLocalContext(context)) {
      throw new OwnerSetupError('LOCAL_CONTEXT_REQUIRED');
    }
    return this.#rotatePairing(() => this.#resolveInstanceOwnerRow());
  }

  /**
   * Like {@link rotateOwnerPairing}, but targets the active `owner` membership of
   * a SPECIFIC vault — whether or not that owner is the instance owner. This is
   * how a `create-vault` secondary owner recovers a lost/expired pairing token
   * instead of being permanently locked out. Requires the local CLI capability.
   */
  public rotateVaultOwnerPairing(
    context: LocalOwnerSetupContext,
    vaultId: string,
  ): RotateOwnerPairingResult {
    if (!isLocalContext(context)) {
      throw new OwnerSetupError('LOCAL_CONTEXT_REQUIRED');
    }
    const requestedVaultId = requireUuid(vaultId);
    return this.#rotatePairing(() =>
      this.#resolveVaultOwnerRow(requestedVaultId),
    );
  }

  /**
   * Shared rotate implementation: resolve the target owner membership, delete its
   * unconsumed pairings (vault-scoped) and mint a fresh single-use token bound to
   * that user/vault/membership. Consumed pairings stay for the audit log.
   */
  #rotatePairing(
    resolveOwner: () => OwnerRow | undefined,
  ): RotateOwnerPairingResult {
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const pairingExpiresAt = addSeconds(now, OWNER_PAIRING_TTL_SECONDS);
    const pairingToken = generatePairingToken();
    const pairingTokenHash = hashPairingToken(pairingToken);

    const rotate = this.#database.transaction((): RotateOwnerPairingResult => {
      const owner = resolveOwner();
      if (owner === undefined) {
        throw new OwnerSetupError('NOT_INITIALIZED');
      }

      // Unconsumed pairings are deleted (the CHECK constraint forbids marking
      // consumed_at without a device); consumed pairings stay for the audit log.
      // Scoped to the resolved vault so an owner's other vaults keep their tokens.
      this.#database
        .prepare(
          `DELETE FROM owner_pairings
           WHERE user_id = ? AND vault_id = ? AND consumed_at IS NULL`,
        )
        .run(owner.userId, owner.vaultId);

      this.#database
        .prepare(
          `INSERT INTO owner_pairings (
             id, user_id, vault_id, membership_id, token_hash,
             created_at, expires_at, consumed_at, consumed_by_device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          this.#newUuid(),
          owner.userId,
          owner.vaultId,
          owner.membershipId,
          pairingTokenHash,
          createdAt,
          pairingExpiresAt,
        );

      return {
        ownerUserId: owner.userId,
        pairingExpiresAt,
        pairingToken,
        vaultId: owner.vaultId,
      };
    });

    return rotate.immediate();
  }

  #resolveInstanceOwnerRow(): OwnerRow | undefined {
    return this.#database
      .prepare(
        `SELECT u.id AS userId, m.vault_id AS vaultId, m.id AS membershipId
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         WHERE u.is_instance_owner = 1 AND u.status = 'active'
           AND m.status = 'active' AND m.role = 'owner'
         ORDER BY m.created_at, m.id
         LIMIT 1`,
      )
      .get() as OwnerRow | undefined;
  }

  #resolveVaultOwnerRow(vaultId: string): OwnerRow | undefined {
    return this.#database
      .prepare(
        `SELECT u.id AS userId, m.vault_id AS vaultId, m.id AS membershipId
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         WHERE m.vault_id = ? AND u.status = 'active'
           AND m.status = 'active' AND m.role = 'owner'
         ORDER BY m.created_at, m.id
         LIMIT 1`,
      )
      .get(vaultId) as OwnerRow | undefined;
  }

  #newUuid(): string {
    return requireUuid(this.#randomUuid());
  }
}
