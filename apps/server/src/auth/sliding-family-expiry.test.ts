/**
 * A device in regular use must not be logged out by the calendar.
 *
 * A refresh-token family is created with a fixed 30-day expiry and nothing ever
 * moved it, so a device that synced every few minutes for a month was cut off
 * anyway. On the pilot desktop that happened mid-session: the family expired at
 * 20:53, the last successful contact was 20:37, and from then on every refresh
 * answered 401 while the panel still showed the last good cycle. The queue grew
 * for nineteen hours and the only way back was re-pairing by hand.
 *
 * Rotation is proof of use: the device presented a valid, unconsumed refresh
 * token, so it is live. Each rotation therefore slides the family's expiry
 * forward to a full window from now, and an idle device still ages out on the
 * same schedule as before.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { slideFamilyExpiry, REFRESH_FAMILY_WINDOW_MS } from './sliding-family-expiry.js';

const USER = '10000000-0000-4000-8000-000000000001';
const DEVICE = '20000000-0000-4000-8000-000000000001';
const FAMILY = '30000000-0000-4000-8000-000000000001';
const CREATED = '2026-08-18T20:53:57.000Z';

const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function makeFamily(expiresAt: string): Promise<Database.Database> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-family-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at)
       VALUES (?, 'Owner', 1, 'active', ?)`,
    )
    .run(USER, CREATED);
  database
    .prepare(
      `INSERT INTO devices
         (id, user_id, display_name, public_key, status, created_at, approved_at)
       VALUES (?, ?, 'Desktop', ?, 'approved', ?, ?)`,
    )
    .run(DEVICE, USER, Buffer.alloc(32, 0x11), CREATED, CREATED);
  database
    .prepare(
      `INSERT INTO refresh_token_families
         (id, user_id, device_id, status, current_generation, created_at, expires_at)
       VALUES (?, ?, ?, 'active', 1, ?, ?)`,
    )
    .run(FAMILY, USER, DEVICE, CREATED, expiresAt);
  return database;
}

function expiryOf(database: Database.Database): string {
  return (
    database
      .prepare(`SELECT expires_at AS at FROM refresh_token_families WHERE id = ?`)
      .get(FAMILY) as { at: string }
  ).at;
}

describe('sliding refresh-family expiry', () => {
  it('moves the expiry a full window ahead of the rotation', async () => {
    const database = await makeFamily('2026-09-17T20:53:57.000Z');
    const now = new Date('2026-09-10T12:00:00.000Z');

    slideFamilyExpiry(database, FAMILY, now);

    expect(Date.parse(expiryOf(database))).toBe(
      now.getTime() + REFRESH_FAMILY_WINDOW_MS,
    );
  });

  it('keeps a device alive indefinitely while it keeps syncing', async () => {
    // The real scenario: a desktop rotating every ten minutes for months.
    const database = await makeFamily('2026-09-17T20:53:57.000Z');
    let now = new Date('2026-09-01T00:00:00.000Z');

    for (let day = 0; day < 120; day += 1) {
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      slideFamilyExpiry(database, FAMILY, now);
      // Never expired at any point along the way.
      expect(Date.parse(expiryOf(database))).toBeGreaterThan(now.getTime());
    }
  });

  it('never shortens an expiry that is already further out', async () => {
    // A family minted with a longer window (or a clock that stepped backwards)
    // must not be cut short by a routine rotation.
    const farFuture = '2027-01-01T00:00:00.000Z';
    const database = await makeFamily(farFuture);

    slideFamilyExpiry(database, FAMILY, new Date('2026-09-10T12:00:00.000Z'));

    expect(expiryOf(database)).toBe(farFuture);
  });

  it('does not resurrect a family that already expired', async () => {
    // Expiry is checked before rotation, so this should be unreachable; pinned
    // because sliding an expired family would silently undo a security boundary.
    const expired = '2026-09-17T20:53:57.000Z';
    const database = await makeFamily(expired);

    slideFamilyExpiry(database, FAMILY, new Date('2026-09-18T15:00:00.000Z'));

    expect(expiryOf(database)).toBe(expired);
  });

  it('does not touch a revoked family', async () => {
    const database = await makeFamily('2026-12-01T00:00:00.000Z');
    database
      .prepare(
        `UPDATE refresh_token_families SET status = 'revoked' WHERE id = ?`,
      )
      .run(FAMILY);

    slideFamilyExpiry(database, FAMILY, new Date('2026-09-10T12:00:00.000Z'));

    expect(expiryOf(database)).toBe('2026-12-01T00:00:00.000Z');
  });

  it('leaves an idle device ageing out on the original schedule', async () => {
    // Nothing rotates, nothing slides: an abandoned device still expires.
    const database = await makeFamily('2026-09-17T20:53:57.000Z');
    expect(expiryOf(database)).toBe('2026-09-17T20:53:57.000Z');
  });

  it('is a no-op for a family that does not exist', async () => {
    const database = await makeFamily('2026-12-01T00:00:00.000Z');
    expect(() =>
      slideFamilyExpiry(
        database,
        '40000000-0000-4000-8000-000000000009',
        new Date(),
      ),
    ).not.toThrow();
  });
});
