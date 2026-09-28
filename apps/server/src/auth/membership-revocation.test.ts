import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deviceStatus,
  familyStatus,
  liveAccessTokenCount,
  makeTempDir,
  openMigratedDatabase,
  openSession as openUserSession,
  releaseTestResources,
  rowSeeder,
} from '../test/fixtures/server-fixtures.js';
import {
  MembershipRevocationError,
  MembershipRevocationService,
} from './membership-revocation.js';
import { SessionRepository } from './session-repository.js';

const START_TIME = '2026-07-21T03:00:00.000Z';

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

const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(
  START_TIME,
  Buffer.alloc(32, 0x33),
);

interface Fixture {
  readonly database: Database.Database;
  readonly service: MembershipRevocationService;
  readonly sessions: SessionRepository;
  readonly inviteeFamilyId: string;
}

function makeFixture(): Fixture {
  const database = openMigratedDatabase(makeTempDir('havemind-membership-revoke-'));

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, { now });
  const service = new MembershipRevocationService(database, { now });

  insertUser(database, OWNER_USER, 'Alice', 1);
  insertUser(database, INVITEE_USER, 'Magda', 0);
  insertVault(database, VAULT, 'Shared Vault');
  insertDevice(database, OWNER_DEVICE, OWNER_USER, 'Alice Laptop', { vaultId: VAULT });
  insertDevice(database, INVITEE_DEVICE, INVITEE_USER, 'Magda Laptop', { vaultId: VAULT });
  insertMembership(database, OWNER_MEMBERSHIP, VAULT, OWNER_USER, 'owner');
  insertMembership(database, INVITEE_MEMBERSHIP, VAULT, INVITEE_USER, 'editor');

  const inviteeFamilyId = openUserSession(database, sessions, INVITEE_USER, INVITEE_DEVICE)
    .familyId;

  return { database, inviteeFamilyId, service, sessions };
}

/** Opens a live session for `deviceId` and returns the refresh family id. */
function openSession(fixture: Fixture, deviceId: string): string {
  return openUserSession(fixture.database, fixture.sessions, INVITEE_USER, deviceId).familyId;
}

/**
 * Gives the invitee a SECOND, independent vault: its own active membership and
 * its own device scoped to that vault, with a live session. Revoking the
 * membership in `VAULT` must leave everything here untouched.
 */
function addOtherVaultForInvitee(fixture: Fixture): string {
  insertVault(fixture.database, OTHER_VAULT, 'Other Vault');
  insertMembership(fixture.database, OTHER_MEMBERSHIP, OTHER_VAULT, INVITEE_USER, 'editor');
  insertDevice(fixture.database, OTHER_VAULT_DEVICE, INVITEE_USER, 'Magda Tablet', {
    vaultId: OTHER_VAULT,
  });
  return openSession(fixture, OTHER_VAULT_DEVICE);
}

afterEach(releaseTestResources);

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

  it('is idempotent, a second revocation is a harmless no-op', () => {
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
    // burning it, failing closed exactly as it did before the fix.
    insertDevice(fixture.database, LEGACY_DEVICE, INVITEE_USER, 'Magda Old Laptop', {
      vaultId: null,
    });
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
