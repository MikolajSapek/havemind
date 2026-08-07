import type Database from 'better-sqlite3';

import { SessionRepository } from './session-repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type MembershipRevocationErrorCode =
  | 'INVALID_INPUT'
  | 'MEMBERSHIP_NOT_FOUND';

const ERROR_MESSAGES: Readonly<Record<MembershipRevocationErrorCode, string>> = {
  INVALID_INPUT: 'Invalid membership-revocation input.',
  MEMBERSHIP_NOT_FOUND: 'The membership to revoke does not exist.',
};

const ERROR_HTTP_STATUS: Readonly<Record<MembershipRevocationErrorCode, number>> =
  {
    INVALID_INPUT: 400,
    MEMBERSHIP_NOT_FOUND: 404,
  };

/** A deliberately secret-free revocation error safe to log or serialize. */
export class MembershipRevocationError extends Error {
  public readonly code: MembershipRevocationErrorCode;

  public constructor(code: MembershipRevocationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MembershipRevocationError';
    this.code = code;
  }

  public get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  public toJSON(): Readonly<{
    name: string;
    code: MembershipRevocationErrorCode;
    message: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

export interface MembershipRevocationServiceOptions {
  readonly now?: () => Date;
}

export interface RevokeMembershipInput {
  readonly membershipId: string;
}

export interface RevokeMembershipResult {
  readonly membershipId: string;
  readonly status: 'revoked';
}

interface MembershipRow {
  readonly userId: string;
  readonly status: string;
  readonly vaultId: string;
}

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MembershipRevocationError('INVALID_INPUT');
  }
  return value;
}

/**
 * Permanently revokes a member's connection to the vault. Revocation is
 * APPEND-ONLY: the membership row is never deleted, only its `status` flips to
 * `revoked` (with `revoked_at` stamped once). The member's past revisions and
 * their attribution stay intact and remain pullable by the remaining members —
 * this is a status change, not a history rewrite.
 *
 * In a single write transaction it: flips the membership to `revoked`, and for
 * every device the member owns IN THAT VAULT burns the device row plus every
 * refresh family and access token bound to it (via the session repository's
 * in-transaction primitive). Devices scoped to the member's OTHER vaults are
 * untouched — losing one vault never locks a member out of another (AUD2-04).
 * The member is therefore terminally locked out of this vault: their next
 * sync/refresh resolves to no active session and fails closed with the terminal
 * 401 path, and a revoked membership can no longer be rejoined or re-admitted
 * (re-adding them requires a fresh invitation and full pairing).
 */
export class MembershipRevocationService {
  readonly #database: Database.Database;
  readonly #now: () => Date;
  readonly #sessions: SessionRepository;

  public constructor(
    database: Database.Database,
    options: MembershipRevocationServiceOptions = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#sessions = new SessionRepository(database, { now: this.#now });
  }

  public revokeMembership(
    input: RevokeMembershipInput,
  ): RevokeMembershipResult {
    const membershipId = requireUuid(input.membershipId);
    const now = this.#readClock().toISOString();

    const revoke = this.#database.transaction((): RevokeMembershipResult => {
      const membership = this.#database
        .prepare(
          `SELECT user_id AS userId, status, vault_id AS vaultId
           FROM memberships WHERE id = ?`,
        )
        .get(membershipId) as MembershipRow | undefined;
      if (membership === undefined) {
        throw new MembershipRevocationError('MEMBERSHIP_NOT_FOUND');
      }

      // Append-only: flip the status, never delete the row. `revoked_at` is
      // stamped once (COALESCE) so re-revoking is a harmless no-op that keeps
      // the original revocation timestamp.
      this.#database
        .prepare(
          `UPDATE memberships
           SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
           WHERE id = ?`,
        )
        .run(now, membershipId);

      // Scoped to the revoked vault (AUD2-04): a member who also belongs to
      // another vault keeps that vault's devices and sessions. `vault_id IS
      // NULL` is the legacy fallback — a device onboarded before the scope
      // column cannot prove its vault, so it is still burned (fail closed,
      // exactly the pre-fix behaviour). NULL never spares a device.
      const devices = this.#database
        .prepare(
          `SELECT id FROM devices
           WHERE user_id = ? AND (vault_id = ? OR vault_id IS NULL)`,
        )
        .all(membership.userId, membership.vaultId) as ReadonlyArray<{
        id: string;
      }>;
      for (const device of devices) {
        this.#sessions.revokeDeviceInCurrentTransaction(device.id);
      }

      return { membershipId, status: 'revoked' };
    });

    return revoke.immediate();
  }

  #readClock(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new MembershipRevocationError('INVALID_INPUT');
    }
    return value;
  }
}
