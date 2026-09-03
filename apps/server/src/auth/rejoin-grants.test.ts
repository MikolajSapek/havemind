import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  RejoinGrantError,
  RejoinGrantService,
} from './rejoin-grants.js';
import { SessionRepository } from './session-repository.js';
import {
  createRefreshSuccessor,
  generateRefreshToken,
  generateRejoinSecret,
  hashRefreshToken,
  hashRejoinSecret,
  parseRefreshToken,
} from './tokens.js';

/**
 * The invitee's per-device rejoin secret. Provisioned (hash only) onto the
 * invitee device in the fixture; the raw value is presented at redemption. An
 * attacker who knows only (membershipId, deviceId) never holds this.
 */
const INVITEE_REJOIN_SECRET = generateRejoinSecret();

const START_TIME = '2026-07-21T03:00:00.000Z';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

const OWNER_USER = '90000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '90000000-0000-4000-8000-0000000000a2';
const VAULT = '90000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '90000000-0000-4000-8000-0000000000a4';
const INVITEE_USER = '90000000-0000-4000-8000-0000000000b1';
const INVITEE_DEVICE = '90000000-0000-4000-8000-0000000000b2';
const INVITEE_MEMBERSHIP = '90000000-0000-4000-8000-0000000000b4';

interface MutableClock {
  readonly now: () => Date;
  advance(milliseconds: number): void;
}

interface Fixture {
  readonly clock: MutableClock;
  readonly database: Database.Database;
  readonly service: RejoinGrantService;
  readonly sessions: SessionRepository;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createClock(initial = START_TIME): MutableClock {
  let milliseconds = Date.parse(initial);
  return {
    advance(value): void {
      milliseconds += value;
    },
    now: () => new Date(milliseconds),
  };
}

function insertUser(database: Database.Database, id: string, name: string, owner: 0 | 1): void {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, NULL)`,
    )
    .run(id, name, owner, START_TIME);
}

function insertDevice(
  database: Database.Database,
  id: string,
  userId: string,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(id, userId, name, Buffer.alloc(32, 0x22), START_TIME, START_TIME);
}

function insertMembership(
  database: Database.Database,
  id: string,
  userId: string,
  role: 'owner' | 'editor',
): void {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
    )
    .run(id, VAULT, userId, role, START_TIME);
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-rejoin-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const clock = createClock();
  insertUser(database, OWNER_USER, 'Owner', 1);
  insertUser(database, INVITEE_USER, 'Magda', 0);
  insertDevice(database, OWNER_DEVICE, OWNER_USER, "Owner's laptop");
  insertDevice(database, INVITEE_DEVICE, INVITEE_USER, "Magda's laptop");
  // Provision the invitee device with its rejoin secret hash, as onboarding does.
  database
    .prepare('UPDATE devices SET rejoin_secret_hash = ? WHERE id = ?')
    .run(hashRejoinSecret(INVITEE_REJOIN_SECRET), INVITEE_DEVICE);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, ?, 0, 1, ?, NULL)`,
    )
    .run(VAULT, 'Pilot vault', START_TIME);
  insertMembership(database, OWNER_MEMBERSHIP, OWNER_USER, 'owner');
  insertMembership(database, INVITEE_MEMBERSHIP, INVITEE_USER, 'editor');

  const service = new RejoinGrantService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now: clock.now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now: clock.now,
  });
  return { clock, database, service, sessions };
}

function expectRejoinError(fn: () => unknown, code: RejoinGrantError['code']): void {
  try {
    fn();
    throw new Error('Expected RejoinGrantError but none was thrown.');
  } catch (error) {
    expect(error).toBeInstanceOf(RejoinGrantError);
    expect((error as RejoinGrantError).code).toBe(code);
  }
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe('RejoinGrantService.createGrant', () => {
  it('binds a grant to the target membership and its approved device', () => {
    const { database, service } = makeFixture();
    const result = service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    expect(result.membershipId).toBe(INVITEE_MEMBERSHIP);
    expect(result.boundDeviceId).toBe(INVITEE_DEVICE);

    const row = database
      .prepare(
        `SELECT membership_id AS membershipId, device_id AS deviceId, consumed_at AS consumedAt
         FROM rejoin_grants WHERE id = ?`,
      )
      .get(result.grantId) as
      | { membershipId: string; deviceId: string; consumedAt: string | null }
      | undefined;
    expect(row).toEqual({
      membershipId: INVITEE_MEMBERSHIP,
      deviceId: INVITEE_DEVICE,
      consumedAt: null,
    });
  });

  it('rejects a caller that is not an active owner of the vault', () => {
    const { service } = makeFixture();
    // The invitee (editor) may not issue a grant for itself.
    expectRejoinError(
      () =>
        service.createGrant({
          ownerMembershipId: INVITEE_MEMBERSHIP,
          targetMembershipId: INVITEE_MEMBERSHIP,
        }),
      'NOT_AUTHORIZED',
    );
  });

  it('refuses to grant a revoked membership', () => {
    const { database, service } = makeFixture();
    database
      .prepare(
        `UPDATE memberships SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      )
      .run(START_TIME, INVITEE_MEMBERSHIP);
    expectRejoinError(
      () =>
        service.createGrant({
          ownerMembershipId: OWNER_MEMBERSHIP,
          targetMembershipId: INVITEE_MEMBERSHIP,
        }),
      'MEMBERSHIP_INACTIVE',
    );
  });
});

describe('RejoinGrantService.redeemGrant', () => {
  function grant(fixture: Fixture): void {
    fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
  }

  it('mints a fresh session for the same identity that works for push', () => {
    const fixture = makeFixture();
    grant(fixture);
    const refreshToken = generateRefreshToken();

    const result = fixture.service.redeemGrant({
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: hashRefreshToken(refreshToken),
      membershipId: INVITEE_MEMBERSHIP,
      rejoinSecret: INVITEE_REJOIN_SECRET,
    });
    expect(result.membershipId).toBe(INVITEE_MEMBERSHIP);
    expect(result.vaultId).toBe(VAULT);
    expect(result.deviceId).toBe(INVITEE_DEVICE);

    // The invitee rotates its own refresh token into an access token: the
    // resumed session resolves to the SAME user and device.
    const successor = createRefreshSuccessor();
    const rotated = fixture.sessions.rotateRefresh({
      currentRefreshToken: refreshToken,
      rotationId: successor.rotationId,
      successorRefreshToken: successor.refreshToken,
    });
    const session = fixture.sessions.lookupAccess(rotated.accessToken);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(INVITEE_USER);
    expect(session?.deviceId).toBe(INVITEE_DEVICE);

    // Push authorises expectedMemberId against the active membership, unchanged.
    const membership = fixture.database
      .prepare(
        `SELECT id AS membershipId FROM memberships
         WHERE user_id = ? AND vault_id = ? AND status = 'active'`,
      )
      .get(INVITEE_USER, VAULT) as { membershipId: string };
    expect(membership.membershipId).toBe(INVITEE_MEMBERSHIP);
  });

  it('is single-use: a second redemption is rejected', () => {
    const fixture = makeFixture();
    grant(fixture);
    fixture.service.redeemGrant({
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
      membershipId: INVITEE_MEMBERSHIP,
      rejoinSecret: INVITEE_REJOIN_SECRET,
    });
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'GRANT_NOT_FOUND',
    );
  });

  it('rejects a redemption after the grant expires', () => {
    const fixture = makeFixture();
    grant(fixture);
    fixture.clock.advance(FIFTEEN_MINUTES_MS + 1_000);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'GRANT_NOT_FOUND',
    );
  });

  it('refuses to rejoin a membership revoked after the grant was issued', () => {
    const fixture = makeFixture();
    grant(fixture);
    fixture.database
      .prepare(
        `UPDATE memberships SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      )
      .run(START_TIME, INVITEE_MEMBERSHIP);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'MEMBERSHIP_INACTIVE',
    );
  });

  it('rejects a device that is not the one bound to the grant', () => {
    const fixture = makeFixture();
    grant(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: OWNER_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'WRONG_DEVICE',
    );
  });

  it('rejects a redemption when no grant was ever issued', () => {
    const fixture = makeFixture();
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'GRANT_NOT_FOUND',
    );
  });

  it('rejects a malformed refresh token hash', () => {
    const fixture = makeFixture();
    grant(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: 'not-a-hash',
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'INVALID_INPUT',
    );
    // The raw refresh token parser is still the primitive of record.
    expect(() => parseRefreshToken('hm_rt_short')).toThrow();
  });

  it('rejects a redemption presenting the wrong rejoin secret and leaves the grant unconsumed', () => {
    const fixture = makeFixture();
    grant(fixture);
    // A different, syntactically valid secret the attacker generated themselves.
    const attackerSecret = generateRejoinSecret();
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: attackerSecret,
        }),
      'SECRET_MISMATCH',
    );

    // The grant was NOT consumed: the legitimate device (holding the real
    // secret) can still redeem it.
    const grantRow = fixture.database
      .prepare(
        'SELECT consumed_at AS consumedAt FROM rejoin_grants WHERE membership_id = ?',
      )
      .get(INVITEE_MEMBERSHIP) as { consumedAt: string | null };
    expect(grantRow.consumedAt).toBeNull();

    const result = fixture.service.redeemGrant({
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
      membershipId: INVITEE_MEMBERSHIP,
      rejoinSecret: INVITEE_REJOIN_SECRET,
    });
    expect(result.membershipId).toBe(INVITEE_MEMBERSHIP);
  });

  it('rejects the impersonation: knowing the victim membership+device but not the secret cannot redeem', () => {
    // This is audit finding #1: a second party who learned the victim's
    // (membershipId, deviceId) from event/receipt metadata redeems with their
    // OWN refresh hash and an invented secret. The secret gate stops them.
    const fixture = makeFixture();
    grant(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: generateRejoinSecret(),
        }),
      'SECRET_MISMATCH',
    );
  });

  it('is fail-closed for a legacy device with no provisioned secret hash', () => {
    const fixture = makeFixture();
    // Simulate a device onboarded before this hardening: clear its secret hash.
    fixture.database
      .prepare('UPDATE devices SET rejoin_secret_hash = NULL WHERE id = ?')
      .run(INVITEE_DEVICE);
    grant(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'SECRET_MISMATCH',
    );
  });
});

describe('AUD2-03: one live grant per membership', () => {
  it('supersedes an earlier live grant when a new one is issued', () => {
    const fixture = makeFixture();
    const first = fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    fixture.clock.advance(1_000);
    const second = fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    expect(second.grantId).not.toBe(first.grantId);

    // Exactly one grant is left live for this membership: the newest.
    const live = fixture.database
      .prepare(
        `SELECT id FROM rejoin_grants
         WHERE membership_id = ? AND consumed_at IS NULL`,
      )
      .all(INVITEE_MEMBERSHIP) as Array<{ id: string }>;
    expect(live.map((row) => row.id)).toEqual([second.grantId]);
  });

  it('yields exactly one redemption no matter how many grants were issued', () => {
    const fixture = makeFixture();
    for (let index = 0; index < 3; index += 1) {
      fixture.service.createGrant({
        ownerMembershipId: OWNER_MEMBERSHIP,
        targetMembershipId: INVITEE_MEMBERSHIP,
      });
      fixture.clock.advance(1_000);
    }

    // The first redemption succeeds...
    fixture.service.redeemGrant({
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
      membershipId: INVITEE_MEMBERSHIP,
      rejoinSecret: INVITEE_REJOIN_SECRET,
    });
    // ...and the superseded grants must NOT hand out extra sessions.
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'GRANT_NOT_FOUND',
    );
  });

  it('leaves the live grant of another membership untouched', () => {
    const fixture = makeFixture();
    const otherUser = '90000000-0000-4000-8000-0000000000c1';
    const otherDevice = '90000000-0000-4000-8000-0000000000c2';
    const otherMembership = '90000000-0000-4000-8000-0000000000c4';
    insertUser(fixture.database, otherUser, 'Ola', 0);
    insertDevice(fixture.database, otherDevice, otherUser, "Ola's laptop");
    insertMembership(fixture.database, otherMembership, otherUser, 'editor');

    const other = fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: otherMembership,
    });
    fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });

    const stillLive = fixture.database
      .prepare(
        `SELECT consumed_at AS consumedAt FROM rejoin_grants WHERE id = ?`,
      )
      .get(other.grantId) as { consumedAt: string | null };
    expect(stillLive.consumedAt).toBeNull();
  });
});

describe('AUD2-05: rejoin honours the vault soft-delete', () => {
  function softDeleteVault(fixture: Fixture): void {
    fixture.database
      .prepare('UPDATE vaults SET deleted_at = ? WHERE id = ?')
      .run(START_TIME, VAULT);
  }

  it('refuses to issue a grant for a membership in a soft-deleted vault', () => {
    const fixture = makeFixture();
    softDeleteVault(fixture);
    expectRejoinError(
      () =>
        fixture.service.createGrant({
          ownerMembershipId: OWNER_MEMBERSHIP,
          targetMembershipId: INVITEE_MEMBERSHIP,
        }),
      'MEMBERSHIP_INACTIVE',
    );
  });

  it('refuses to redeem a grant after the vault is soft-deleted', () => {
    const fixture = makeFixture();
    fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    softDeleteVault(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'MEMBERSHIP_INACTIVE',
    );
  });

  it('leaves the grant unconsumed when the vault is soft-deleted', () => {
    const fixture = makeFixture();
    const created = fixture.service.createGrant({
      ownerMembershipId: OWNER_MEMBERSHIP,
      targetMembershipId: INVITEE_MEMBERSHIP,
    });
    softDeleteVault(fixture);
    expectRejoinError(
      () =>
        fixture.service.redeemGrant({
          deviceId: INVITEE_DEVICE,
          initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
          membershipId: INVITEE_MEMBERSHIP,
          rejoinSecret: INVITEE_REJOIN_SECRET,
        }),
      'MEMBERSHIP_INACTIVE',
    );
    const row = fixture.database
      .prepare('SELECT consumed_at AS consumedAt FROM rejoin_grants WHERE id = ?')
      .get(created.grantId) as { consumedAt: string | null };
    expect(row.consumedAt).toBeNull();
  });
});

