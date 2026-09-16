/**
 * A device that stopped pulling must not pin the history forever.
 *
 * Compaction requires every approved device to have acked the current head, and
 * a device that never pulled (NULL ack) or fell behind blocks it unconditionally.
 * One phone whose join never completed therefore keeps every superseded revision
 * alive for the life of the vault, which is exactly the unbounded growth this
 * guards against elsewhere.
 *
 * A device that has not been seen for a long time is treated as gone for
 * compaction purposes only: it stops blocking. Nothing about its membership or
 * its ability to come back changes, a returning device pulls the current heads
 * through the snapshot path, which never needed the superseded log.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  compactIfAllDevicesCaughtUp,
  STALE_DEVICE_ACK_MS,
} from './history-compaction.js';

const VAULT = 'vault-1';
const NOW = Date.parse('2026-09-16T18:00:00.000Z');

function seedDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      vault_id TEXT,
      status TEXT NOT NULL,
      last_ack_sequence INTEGER,
      last_ack_at TEXT
    );
    CREATE TABLE memberships (
      user_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return database;
}

function addDevice(
  database: Database.Database,
  row: {
    id: string;
    ack: number | null;
    ackAt: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO devices (id, user_id, vault_id, status, last_ack_sequence, last_ack_at)
       VALUES (?, 'user-1', ?, 'approved', ?, ?)`,
    )
    .run(row.id, VAULT, row.ack, row.ackAt);
}

function revisionsStub(head: number) {
  let removed = 0;
  return {
    getCursor: () => head,
    compactSupersededRevisions: () => {
      removed += 1;
      return 7;
    },
    get calls() {
      return removed;
    },
  };
}

describe('compaction with a stale device', () => {
  it('still blocks on a device that is behind but recently seen', () => {
    const database = seedDatabase();
    addDevice(database, {
      id: 'phone',
      ack: 3,
      ackAt: new Date(NOW - 60_000).toISOString(),
    });
    const revisions = revisionsStub(10);

    const result = compactIfAllDevicesCaughtUp(database, revisions, VAULT, {
      now: NOW,
    });

    expect(result.compactable).toBe(false);
    expect(revisions.calls).toBe(0);
  });

  it('ignores a device that has not pulled for longer than the stale window', () => {
    const database = seedDatabase();
    addDevice(database, {
      id: 'laptop',
      ack: 10,
      ackAt: new Date(NOW - 1000).toISOString(),
    });
    addDevice(database, {
      id: 'abandoned-phone',
      ack: 3,
      ackAt: new Date(NOW - STALE_DEVICE_ACK_MS - 60_000).toISOString(),
    });
    const revisions = revisionsStub(10);

    const result = compactIfAllDevicesCaughtUp(database, revisions, VAULT, {
      now: NOW,
    });

    expect(result.compactable).toBe(true);
    expect(result.removedRevisions).toBe(7);
  });

  it('still blocks on a device that never pulled at all', () => {
    // A NULL ack carries no timestamp to age out, and it is the shape of a
    // device that was approved moments ago and is about to join. Keep failing
    // closed there.
    const database = seedDatabase();
    addDevice(database, { id: 'fresh', ack: null, ackAt: null });
    const revisions = revisionsStub(10);

    const result = compactIfAllDevicesCaughtUp(database, revisions, VAULT, {
      now: NOW,
    });

    expect(result.compactable).toBe(false);
  });

  it('compacts when every device is caught up, as before', () => {
    const database = seedDatabase();
    addDevice(database, {
      id: 'laptop',
      ack: 10,
      ackAt: new Date(NOW - 1000).toISOString(),
    });
    const revisions = revisionsStub(10);

    expect(
      compactIfAllDevicesCaughtUp(database, revisions, VAULT, { now: NOW })
        .compactable,
    ).toBe(true);
  });
});
