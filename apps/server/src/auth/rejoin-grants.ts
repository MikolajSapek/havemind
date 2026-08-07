import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { SessionRepository } from './session-repository.js';
import { rejoinSecretMatchesHash } from './tokens.js';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Rejoin grants live for exactly 15 minutes and cannot be replayed. */
export const REJOIN_GRANT_TTL_SECONDS = 15 * 60;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RejoinGrantErrorCode =
  | 'GRANT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'MEMBERSHIP_INACTIVE'
  | 'NO_BOUND_DEVICE'
  | 'NOT_AUTHORIZED'
  | 'REPOSITORY_INTEGRITY'
  | 'SECRET_MISMATCH'
  | 'WRONG_DEVICE';

const ERROR_MESSAGES: Readonly<Record<RejoinGrantErrorCode, string>> = {
  GRANT_NOT_FOUND: 'No live rejoin grant matches the presented binding.',
  INVALID_INPUT: 'Invalid rejoin input.',
  MEMBERSHIP_INACTIVE: 'The membership is not active and cannot be rejoined.',
  NO_BOUND_DEVICE: 'No approved device is bound to the target membership.',
  NOT_AUTHORIZED: 'The membership may not perform this action.',
  REPOSITORY_INTEGRITY: 'Stored rejoin state is invalid.',
  SECRET_MISMATCH:
    'The presented rejoin secret is absent or does not match the bound device.',
  WRONG_DEVICE: 'The presented device is not the one bound to the grant.',
};

const ERROR_HTTP_STATUS: Readonly<Record<RejoinGrantErrorCode, number>> = {
  GRANT_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  MEMBERSHIP_INACTIVE: 403,
  NO_BOUND_DEVICE: 409,
  NOT_AUTHORIZED: 403,
  REPOSITORY_INTEGRITY: 500,
  SECRET_MISMATCH: 401,
  WRONG_DEVICE: 403,
};

/** A deliberately secret-free rejoin error safe to log or serialize. */
export class RejoinGrantError extends Error {
  public readonly code: RejoinGrantErrorCode;

  public constructor(code: RejoinGrantErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RejoinGrantError';
    this.code = code;
  }

  public get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  public toJSON(): Readonly<{
    name: string;
    code: RejoinGrantErrorCode;
    message: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

export interface RejoinGrantServiceOptions {
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export interface CreateRejoinGrantInput {
  /** The owner's active membership issuing the grant (from the auth session). */
  readonly ownerMembershipId: string;
  /** The known contact to re-admit — the membership recorded at approval. */
  readonly targetMembershipId: string;
}

export interface CreateRejoinGrantResult {
  readonly grantId: string;
  readonly membershipId: string;
  /** The device the grant is bound to; non-secret, safe to surface to the owner. */
  readonly boundDeviceId: string;
  readonly expiresAt: string;
}

export interface RedeemRejoinGrantInput {
  /** The invitee's own membership, read back from its persisted data.json. */
  readonly membershipId: string;
  /** The invitee's own device id, read back from its persisted data.json. */
  readonly deviceId: string;
  /**
   * SHA-256 hash of a freshly generated initial refresh token. The raw secret
   * never reaches the server (mirrors `/owner/pair` and the invitee redeem
   * contract); the invitee later rotates it via `POST /auth/refresh`.
   */
  readonly initialRefreshTokenHash: string;
  /**
   * The device's per-device rejoin secret (`hm_rj_…`), provisioned at
   * onboarding and held only by the legitimate device. Presented RAW over TLS;
   * the server hashes it and constant-time compares to the hash stored on the
   * bound device. This is the capability that defeats audit finding #1: knowing
   * the (membershipId, deviceId) binding alone no longer redeems a grant.
   */
  readonly rejoinSecret: string;
}

export interface RedeemRejoinGrantResult {
  readonly membershipId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly refreshExpiresAt: string;
}

interface MembershipRow {
  readonly userId: string;
  readonly vaultId: string;
  readonly role: string;
  readonly status: string;
}

interface GrantRow {
  readonly id: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new RejoinGrantError('INVALID_INPUT');
  }
  return value;
}

function readClock(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RejoinGrantError('INVALID_INPUT');
  }
  return value;
}

function addSeconds(date: Date, seconds: number): string {
  const milliseconds = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RejoinGrantError('INVALID_INPUT');
  }
  return new Date(milliseconds).toISOString();
}

function requireStoredDate(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RejoinGrantError('REPOSITORY_INTEGRITY');
  }
  return milliseconds;
}

/**
 * Owner-issued, single-use rejoin grants. A pairing is persistent: once the
 * owner has approved a contact once, the owner can re-admit that EXACT contact
 * after a terminal auth failure without re-running pairing (no PIN, nothing to
 * read aloud). The grant is bound server-side to the (membershipId, deviceId)
 * pair recorded at the original approval; redemption verifies the presenting
 * device matches the bound deviceId and the server assigns identity from the
 * stored binding — it never trusts an actor id from the request body.
 *
 * Credential: redemption requires the device's per-device rejoin SECRET
 * (`hm_rj_…`), provisioned to the legitimate device at onboarding and stored
 * server-side only as a SHA-256 hash. The (membershipId, deviceId) binding is
 * an ADDITIONAL check, not the credential — both ids leak to every vault member
 * through event/receipt metadata, so binding alone must never redeem (audit
 * finding #1). A device with no provisioned secret is fail-closed and cannot
 * rejoin. The grant is still single-use and expires in 15 minutes.
 */
export class RejoinGrantService {
  readonly #database: Database.Database;
  readonly #accessTokenTtlSeconds: number;
  readonly #refreshTokenTtlSeconds: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #sessions: SessionRepository;

  public constructor(
    database: Database.Database,
    options: RejoinGrantServiceOptions = {},
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

  /**
   * Owner issues a grant for a known contact. Authorises the caller as an active
   * owner in the target membership's vault, requires the target membership to be
   * active, resolves the approved device bound to that member and records a
   * single-use grant. Returns nothing secret — the binding is the credential.
   */
  public createGrant(
    input: CreateRejoinGrantInput,
  ): CreateRejoinGrantResult {
    const ownerMembershipId = requireUuid(input.ownerMembershipId);
    const targetMembershipId = requireUuid(input.targetMembershipId);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const expiresAt = addSeconds(now, REJOIN_GRANT_TTL_SECONDS);

    const create = this.#database.transaction((): CreateRejoinGrantResult => {
      const target = this.#loadMembership(targetMembershipId);
      if (target.status !== 'active') {
        throw new RejoinGrantError('MEMBERSHIP_INACTIVE');
      }
      this.#requireOwnerMembership(ownerMembershipId, target.vaultId);

      const boundDeviceId = this.#resolveBoundDevice(
        target.userId,
        target.vaultId,
      );
      const grantId = this.#newUuid();
      this.#database
        .prepare(
          `INSERT INTO rejoin_grants (
             id, membership_id, device_id, created_by_membership_id,
             created_at, expires_at, consumed_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          grantId,
          targetMembershipId,
          boundDeviceId,
          ownerMembershipId,
          createdAt,
          expiresAt,
        );

      return {
        boundDeviceId,
        expiresAt,
        grantId,
        membershipId: targetMembershipId,
      };
    });

    return create.immediate();
  }

  /**
   * Invitee redeems a live grant by presenting the (membershipId, deviceId) pair
   * it already holds locally. On success the server mints a fresh refresh family
   * (generation zero) from the supplied hash, bound to the SAME (userId,
   * deviceId), so sync resumes under the SAME membership — attribution and
   * colours are unchanged. No user-visible pairing occurs.
   */
  public redeemGrant(input: RedeemRejoinGrantInput): RedeemRejoinGrantResult {
    const membershipId = requireUuid(input.membershipId);
    const deviceId = requireUuid(input.deviceId);
    if (
      typeof input.initialRefreshTokenHash !== 'string' ||
      !SHA256_HEX_PATTERN.test(input.initialRefreshTokenHash)
    ) {
      throw new RejoinGrantError('INVALID_INPUT');
    }
    const now = readClock(this.#now);
    const consumedAt = now.toISOString();

    const redeem = this.#database.transaction((): RedeemRejoinGrantResult => {
      const grant = this.#loadLiveGrant(membershipId, now.getTime());
      // The server assigns identity from the stored binding, never from the
      // request body: the presented device must be the one bound at issue time.
      if (grant.deviceId !== deviceId) {
        throw new RejoinGrantError('WRONG_DEVICE');
      }

      const membership = this.#loadMembership(membershipId);
      if (membership.status !== 'active') {
        // A revoked membership is re-invite territory, out of scope for rejoin.
        throw new RejoinGrantError('MEMBERSHIP_INACTIVE');
      }

      const device = this.#database
        .prepare(
          `SELECT user_id AS userId, status,
                  rejoin_secret_hash AS rejoinSecretHash
           FROM devices WHERE id = ?`,
        )
        .get(deviceId) as
        | { userId: string; status: string; rejoinSecretHash: string | null }
        | undefined;
      if (
        device === undefined ||
        device.status !== 'approved' ||
        device.userId !== membership.userId
      ) {
        throw new RejoinGrantError('WRONG_DEVICE');
      }

      // Capability check BEFORE consuming the single-use grant: a wrong or
      // absent secret must leave the grant unconsumed and mint no session, so a
      // member who merely knows the victim's (membershipId, deviceId) cannot
      // redeem (audit finding #1). A device with no provisioned hash (onboarded
      // before this hardening) is fail-closed and must re-onboard.
      if (!rejoinSecretMatchesHash(input.rejoinSecret, device.rejoinSecretHash)) {
        throw new RejoinGrantError('SECRET_MISMATCH');
      }

      const consumed = this.#database
        .prepare(
          `UPDATE rejoin_grants SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(consumedAt, grant.id);
      if (consumed.changes !== 1) {
        // Lost the single-use race: another redemption consumed it first.
        throw new RejoinGrantError('GRANT_NOT_FOUND');
      }

      const family =
        this.#sessions.createInitialFamilyFromHashInCurrentTransaction({
          deviceId,
          refreshTokenHash: input.initialRefreshTokenHash,
          refreshTokenTtlSeconds: this.#refreshTokenTtlSeconds,
          userId: membership.userId,
        });

      return {
        deviceId,
        membershipId,
        refreshExpiresAt: family.refreshExpiresAt,
        vaultId: membership.vaultId,
      };
    });

    return redeem.immediate();
  }

  #loadLiveGrant(membershipId: string, nowMs: number): GrantRow {
    const row = this.#database
      .prepare(
        `SELECT id,
                membership_id AS membershipId,
                device_id AS deviceId,
                expires_at AS expiresAt,
                consumed_at AS consumedAt
         FROM rejoin_grants
         WHERE membership_id = ? AND consumed_at IS NULL
         ORDER BY created_at DESC, id
         LIMIT 1`,
      )
      .get(membershipId) as GrantRow | undefined;
    if (row === undefined) {
      throw new RejoinGrantError('GRANT_NOT_FOUND');
    }
    if (requireStoredDate(row.expiresAt) <= nowMs) {
      throw new RejoinGrantError('GRANT_NOT_FOUND');
    }
    return row;
  }

  #loadMembership(membershipId: string): MembershipRow {
    const row = this.#database
      .prepare(
        `SELECT user_id AS userId, vault_id AS vaultId, role, status
         FROM memberships WHERE id = ?`,
      )
      .get(membershipId) as MembershipRow | undefined;
    if (row === undefined) {
      throw new RejoinGrantError('GRANT_NOT_FOUND');
    }
    return row;
  }

  #requireOwnerMembership(membershipId: string, vaultId: string): void {
    const row = this.#database
      .prepare(
        `SELECT role, status, vault_id AS vaultId
         FROM memberships WHERE id = ?`,
      )
      .get(membershipId) as
      | { role: string; status: string; vaultId: string }
      | undefined;
    if (
      row === undefined ||
      row.status !== 'active' ||
      row.role !== 'owner' ||
      row.vaultId !== vaultId
    ) {
      throw new RejoinGrantError('NOT_AUTHORIZED');
    }
  }

  #resolveBoundDevice(userId: string, vaultId: string): string {
    // Scoped to the grant's vault: a member who also belongs to another vault
    // has an approved device there too, and an unscoped selection would bind
    // the grant to it — handing an owner authority over a device in a vault
    // they do not administer (same class as AUD2-04). `vault_id IS NULL` is the
    // legacy fallback: a device onboarded before the scope column cannot prove
    // its vault, so it stays eligible rather than losing rejoin entirely.
    // Ordering makes that a LAST resort — a device proven to be in this vault
    // always wins — and within each group the most recently approved is chosen,
    // so the grant still targets a single, well-defined device.
    const row = this.#database
      .prepare(
        `SELECT id FROM devices
         WHERE user_id = ? AND status = 'approved'
           AND (vault_id = ? OR vault_id IS NULL)
         ORDER BY (vault_id IS NULL), approved_at DESC, id
         LIMIT 1`,
      )
      .get(userId, vaultId) as { id: string } | undefined;
    if (row === undefined) {
      throw new RejoinGrantError('NO_BOUND_DEVICE');
    }
    return row.id;
  }

  #newUuid(): string {
    return requireUuid(this.#randomUuid());
  }
}
