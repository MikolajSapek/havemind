import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { runStaleCleanup } from './cleanup-stale.js';

const temporaryDirectories: string[] = [];

function makeDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-cleanup-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.db'));
  runMigrations(database);
  return database;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

const NOW = new Date('2026-07-21T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

interface Seed {
  readonly approvedDeviceId: string;
  readonly consumedInvitationId: string;
  readonly expiredInvitationId: string;
  readonly freshInvitationId: string;
  readonly freshPendingDeviceId: string;
  readonly ownerMembershipId: string;
  readonly staleInvitationWithReferencingDeviceId: string;
  readonly stalePendingDeviceId: string;
  readonly userId: string;
  readonly vaultId: string;
}

/**
 * Seeds a database with one of everything the cleanup sweep must
 * distinguish between: an expired invitation, a consumed (but not
 * expired) invitation, a fresh invitation, an old pending device, a fresh
 * pending device, and an approved device, plus one invitation whose
 * `inviter_device_id` still points at the approved device, so the
 * cleanup's own dependency check has something real to read.
 */
function seed(database: Database.Database): Seed {
  const userId = randomUUID();
  const vaultId = randomUUID();
  const ownerMembershipId = randomUUID();
  const approvedDeviceId = randomUUID();
  const stalePendingDeviceId = randomUUID();
  const freshPendingDeviceId = randomUUID();

  database.exec('BEGIN');
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at)
       VALUES (?, 'Alice', 1, 'active', ?)`,
    )
    .run(userId, NOW.toISOString());
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, created_at)
       VALUES (?, 'Notes', ?)`,
    )
    .run(vaultId, NOW.toISOString());
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    )
    .run(ownerMembershipId, vaultId, userId, NOW.toISOString());
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at)
       VALUES (?, ?, 'Owner laptop', X'01', 'approved', ?, ?)`,
    )
    .run(approvedDeviceId, userId, NOW.toISOString(), NOW.toISOString());
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at)
       VALUES (?, ?, 'Old pending phone', X'02', 'pending', ?)`,
    )
    .run(
      stalePendingDeviceId,
      userId,
      new Date(NOW.getTime() - 48 * HOUR_MS).toISOString(),
    );
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at)
       VALUES (?, ?, 'Fresh pending phone', X'03', 'pending', ?)`,
    )
    .run(
      freshPendingDeviceId,
      userId,
      new Date(NOW.getTime() - HOUR_MS).toISOString(),
    );

  function insertInvitation(options: {
    readonly consumedAt: string | null;
    readonly expiresAt: string;
    readonly inviterDeviceId: string;
  }): string {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO invitations (
           id, vault_id, created_by_membership_id, inviter_device_id,
           token_hash, verification_secret, expires_at, created_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, '000000', ?, ?, ?)`,
      )
      .run(
        id,
        vaultId,
        ownerMembershipId,
        options.inviterDeviceId,
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
        options.expiresAt,
        NOW.toISOString(),
        options.consumedAt,
      );
    return id;
  }

  const expiredInvitationId = insertInvitation({
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    inviterDeviceId: approvedDeviceId,
  });
  const consumedInvitationId = insertInvitation({
    consumedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 48 * HOUR_MS).toISOString(),
    inviterDeviceId: approvedDeviceId,
  });
  const freshInvitationId = insertInvitation({
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + 48 * HOUR_MS).toISOString(),
    inviterDeviceId: approvedDeviceId,
  });
  const staleInvitationWithReferencingDeviceId = insertInvitation({
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    inviterDeviceId: approvedDeviceId,
  });
  database.exec('COMMIT');

  return {
    approvedDeviceId,
    consumedInvitationId,
    expiredInvitationId,
    freshInvitationId,
    freshPendingDeviceId,
    ownerMembershipId,
    staleInvitationWithReferencingDeviceId,
    stalePendingDeviceId,
    userId,
    vaultId,
  };
}

function deviceExists(database: Database.Database, id: string): boolean {
  return (
    database.prepare('SELECT 1 FROM devices WHERE id = ?').get(id) !==
    undefined
  );
}

function invitationExists(database: Database.Database, id: string): boolean {
  return (
    database.prepare('SELECT 1 FROM invitations WHERE id = ?').get(id) !==
    undefined
  );
}

describe('runStaleCleanup', () => {
  let database: Database.Database;
  let context: Seed;

  beforeEach(() => {
    database = makeDatabase();
    context = seed(database);
  });

  afterEach(() => {
    database.close();
  });

  it('removes only expired and consumed invitations, leaving the fresh one', () => {
    const result = runStaleCleanup(database, { now: () => NOW });

    expect(invitationExists(database, context.expiredInvitationId)).toBe(
      false,
    );
    expect(invitationExists(database, context.consumedInvitationId)).toBe(
      false,
    );
    expect(
      invitationExists(
        database,
        context.staleInvitationWithReferencingDeviceId,
      ),
    ).toBe(false);
    expect(invitationExists(database, context.freshInvitationId)).toBe(true);
    expect(result.invitationsRemoved).toBe(3);
  });

  it('removes the old pending device but leaves the fresh pending device', () => {
    const result = runStaleCleanup(database, { now: () => NOW });

    expect(deviceExists(database, context.stalePendingDeviceId)).toBe(false);
    expect(deviceExists(database, context.freshPendingDeviceId)).toBe(true);
    expect(result.pendingDevicesRemoved).toBe(1);
  });

  it('never touches the approved device', () => {
    runStaleCleanup(database, { now: () => NOW });

    expect(deviceExists(database, context.approvedDeviceId)).toBe(true);
  });

  it('respects a custom --pending-older-than-hours threshold', () => {
    // With a 72h threshold, the "old" pending device (48h) is not old enough.
    const result = runStaleCleanup(database, {
      now: () => NOW,
      pendingOlderThanHours: 72,
    });

    expect(deviceExists(database, context.stalePendingDeviceId)).toBe(true);
    expect(result.pendingDevicesRemoved).toBe(0);
  });

  it('skips and reports a stale pending device with a RESTRICT reference', () => {
    // Make the stale pending device an invitation's inviter_device_id, an
    // ON DELETE RESTRICT reference the cleanup must never violate.
    database
      .prepare('UPDATE invitations SET inviter_device_id = ? WHERE id = ?')
      .run(context.stalePendingDeviceId, context.freshInvitationId);

    const result = runStaleCleanup(database, { now: () => NOW });

    expect(deviceExists(database, context.stalePendingDeviceId)).toBe(true);
    expect(result.pendingDevicesRemoved).toBe(0);
    expect(result.skippedDueToReferences).toBe(1);
  });

  it('dry-run reports counts without deleting anything', () => {
    const result = runStaleCleanup(database, { dryRun: true, now: () => NOW });

    expect(result.invitationsRemoved).toBe(3);
    expect(result.pendingDevicesRemoved).toBe(1);
    expect(invitationExists(database, context.expiredInvitationId)).toBe(
      true,
    );
    expect(deviceExists(database, context.stalePendingDeviceId)).toBe(true);
  });

  it('rejects a negative pendingOlderThanHours', () => {
    expect(() =>
      runStaleCleanup(database, { now: () => NOW, pendingOlderThanHours: -1 }),
    ).toThrow(RangeError);
  });
});
