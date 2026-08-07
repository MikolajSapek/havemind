import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  MembershipRevocationError,
  MembershipRevocationService,
} from './membership-revocation.js';
import { SessionRepository } from './session-repository.js';
import { generateRefreshToken } from './tokens.js';

const START_TIME = '2026-07-21T03:00:00.000Z';
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

const OWNER_USER = '92000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '92000000-0000-4000-8000-0000000000a2';
const VAULT = '92000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '92000000-0000-4000-8000-0000000000a4';
const INVITEE_USER = '92000000-0000-4000-8000-0000000000b1';
const INVITEE_DEVICE = '92000000-0000-4000-8000-0000000000b2';
const INVITEE_MEMBERSHIP = '92000000-0000-4000-8000-0000000000b4';
const UNKNOWN_MEMBERSHIP = '92000000-0000-4000-8000-0000000000c4';

// A SECOND vault the same invitee also belongs to (AUD2-04): revoking the
// membership in `VAULT` must not touch anything scoped to this one.
const OTHER_VAULT = '92000000-0000-4000-8000-0000000000d3';
const OTHER_MEMBERSHIP = '92000000-0000-4000-8000-0000000000d4';
const OTHER_VAULT_DEVICE = '92000000-0000-4000-8000-0000000000d2';
// A device onboarded before the vault-scope column existed (vault_id IS NULL).
const LEGACY_DEVICE = '92000000-0000-4000-8000-0000000000e2';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function insertUser(db: Database.Database, id: string, name: string, owner: 0 | 1): void {
  db.prepare(
    `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
     VALUES (?, ?, ?, 'active', ?, NULL)`,
  ).run(id, name, owner, START_TIME);
}

function insertDevice(
  db: Database.Database,
  id: string,
  userId: string,
  name: string,
  vaultId: string | null,
): void {
  db.prepare(
    `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at, vault_id)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL, ?)`,
  ).run(id, userId, name, Buffer.alloc(32, 0x33), START_TIME, START_TIME, vaultId);
}

function insertVault(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
     VALUES (?, ?, 0, 1, ?, NULL)`,
  ).run(id, name, START_TIME);
}

function insertMembership(
  db: Database.Database,
  id: string,
  userId: string,
  role: 'owner' | 'editor',
  vaultId: string = VAULT,
): void {
  db.prepare(
    `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
  ).run(id, vaultId, userId, role, START_TIME);
}

interface Fixture {
  readonly database: Database.Database;
  readonly service: MembershipRevocationService;
  readonly sessions: SessionRepository;
  readonly inviteeFamilyId: string;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-membership-revoke-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, { now });
  const service = new MembershipRevocationService(database, { now });

  insertUser(database, OWNER_USER, 'Alice', 1);
  insertUser(database, INVITEE_USER, 'Magda', 0);
  insertVault(database, VAULT, 'Shared Vault');
  insertDevice(database, OWNER_DEVICE, OWNER_USER, 'Alice Laptop', VAULT);
  insertDevice(database, INVITEE_DEVICE, INVITEE_USER, 'Magda Laptop', VAULT);
  insertMembership(database, OWNER_MEMBERSHIP, OWNER_USER, 'owner');
  insertMembership(database, INVITEE_MEMBERSHIP, INVITEE_USER, 'editor');

  const issued = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId: INVITEE_DEVICE,
      initialRefreshToken: generateRefreshToken(),
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId: INVITEE_USER,
    }),
  );
  const inviteeFamilyId = issued.immediate().familyId;

  return { database, inviteeFamilyId, service, sessions };
}

/** Opens a live session for `deviceId` and returns the refresh family id. */
function openSession(fixture: Fixture, deviceId: string): string {
  const issued = fixture.database.transaction(() =>
    fixture.sessions.createInitialSessionInCurrentTransaction({
      deviceId,
      initialRefreshToken: generateRefreshToken(),
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId: INVITEE_USER,
    }),
  );
  return issued.immediate().familyId;
}

/**
 * Gives the invitee a SECOND, independent vault: its own active membership and
 * its own device scoped to that vault, with a live session. Revoking the
 * membership in `VAULT` must leave everything here untouched.
 */
function addOtherVaultForInvitee(fixture: Fixture): string {
  insertVault(fixture.database, OTHER_VAULT, 'Other Vault');
  insertMembership(
    fixture.database,
    OTHER_MEMBERSHIP,
    INVITEE_USER,
    'editor',
    OTHER_VAULT,
  );
  insertDevice(
    fixture.database,
    OTHER_VAULT_DEVICE,
    INVITEE_USER,
    'Magda Tablet',
    OTHER_VAULT,
  );
  return openSession(fixture, OTHER_VAULT_DEVICE);
}

function liveAccessTokenCount(
  fixture: Fixture,
  deviceId: string,
): number {
  const row = fixture.database
    .prepare(
      `SELECT COUNT(*) AS live FROM access_tokens
       WHERE device_id = ? AND revoked_at IS NULL`,
    )
    .get(deviceId) as { live: number };
  return row.live;
}

function deviceStatus(fixture: Fixture, deviceId: string): string {
  return (
    fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(deviceId) as { status: string }
  ).status;
}

function familyStatus(fixture: Fixture, familyId: string): string {
  return (
    fixture.database
      .prepare('SELECT status FROM refresh_token_families WHERE id = ?')
      .get(familyId) as { status: string }
  ).status;
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

describe('MembershipRevocationService', () => {
  it('flips the membership status to revoked without deleting the row', () => {
    const fixture = makeFixture();
    const result = fixture.service.revokeMembership({
      membershipId: INVITEE_MEMBERSHIP,
    });
    expect(result).toEqual({ membershipId: INVITEE_MEMBERSHIP, status: 'revoked' });

    const membership = fixture.database
      .prepare('SELECT status, revoked_at AS revokedAt FROM memberships WHERE id = ?')
      .get(INVITEE_MEMBERSHIP) as { status: string; revokedAt: string | null };
    expect(membership.status).toBe('revoked');
    expect(membership.revokedAt).not.toBeNull();
  });

  it("revokes all of the member's devices and burns their refresh families", () => {
    const fixture = makeFixture();
    fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP });

    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(INVITEE_DEVICE) as { status: string };
    expect(device.status).toBe('revoked');

    const family = fixture.database
      .prepare('SELECT status FROM refresh_token_families WHERE id = ?')
      .get(fixture.inviteeFamilyId) as { status: string };
    expect(family.status).toBe('revoked');

    const liveAccess = fixture.database
      .prepare(
        `SELECT COUNT(*) AS live FROM access_tokens
         WHERE device_id = ? AND revoked_at IS NULL`,
      )
      .get(INVITEE_DEVICE) as { live: number };
    expect(liveAccess.live).toBe(0);
  });

  it("leaves the owner's own membership and device untouched", () => {
    const fixture = makeFixture();
    fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP });

    const owner = fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(OWNER_MEMBERSHIP) as { status: string };
    expect(owner.status).toBe('active');
    const ownerDevice = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(OWNER_DEVICE) as { status: string };
    expect(ownerDevice.status).toBe('approved');
  });

  it('is idempotent — a second revocation is a harmless no-op', () => {
    const fixture = makeFixture();
    fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP });
    const first = fixture.database
      .prepare('SELECT revoked_at AS revokedAt FROM memberships WHERE id = ?')
      .get(INVITEE_MEMBERSHIP) as { revokedAt: string };
    expect(() =>
      fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP }),
    ).not.toThrow();
    const second = fixture.database
      .prepare('SELECT revoked_at AS revokedAt FROM memberships WHERE id = ?')
      .get(INVITEE_MEMBERSHIP) as { revokedAt: string };
    // The original revocation timestamp is preserved (append-only, COALESCE).
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('leaves the member device and sessions of another vault alive (AUD2-04)', () => {
    const fixture = makeFixture();
    const otherFamilyId = addOtherVaultForInvitee(fixture);

    fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP });

    // The revoked vault's device is burned...
    expect(deviceStatus(fixture, INVITEE_DEVICE)).toBe('revoked');
    // ...but the SECOND vault's membership, device and session are untouched:
    // losing access to one vault must never lock the member out of another.
    const otherMembership = fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(OTHER_MEMBERSHIP) as { status: string };
    expect(otherMembership.status).toBe('active');
    expect(deviceStatus(fixture, OTHER_VAULT_DEVICE)).toBe('approved');
    expect(familyStatus(fixture, otherFamilyId)).toBe('active');
    expect(liveAccessTokenCount(fixture, OTHER_VAULT_DEVICE)).toBe(1);
  });

  it('still revokes a legacy device with no vault scope (conservative fallback)', () => {
    const fixture = makeFixture();
    // A device onboarded before the vault-scope column existed carries
    // vault_id IS NULL. Its vault cannot be proven, so revocation must keep
    // burning it — failing closed exactly as it did before the fix.
    insertDevice(
      fixture.database,
      LEGACY_DEVICE,
      INVITEE_USER,
      'Magda Old Laptop',
      null,
    );
    const legacyFamilyId = openSession(fixture, LEGACY_DEVICE);

    fixture.service.revokeMembership({ membershipId: INVITEE_MEMBERSHIP });

    expect(deviceStatus(fixture, LEGACY_DEVICE)).toBe('revoked');
    expect(familyStatus(fixture, legacyFamilyId)).toBe('revoked');
    expect(liveAccessTokenCount(fixture, LEGACY_DEVICE)).toBe(0);
  });

  it('throws MEMBERSHIP_NOT_FOUND for an unknown membership', () => {
    const fixture = makeFixture();
    expect(() =>
      fixture.service.revokeMembership({ membershipId: UNKNOWN_MEMBERSHIP }),
    ).toThrowError(MembershipRevocationError);
  });
});
