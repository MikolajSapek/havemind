/**
 * The event-log repair must produce exactly what the clients require: a log
 * running 1..N with no gaps, every revision and head still present, and no
 * device left holding a cursor into the old numbering.
 *
 * Driven through the real script so the thing that touches production data is
 * the thing under test.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './db.js';
import { runMigrations } from './migrations.js';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'renumber-event-log.mjs',
);

const USER = '10000000-0000-4000-8000-000000000001';
const DEVICE = '20000000-0000-4000-8000-000000000001';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const VAULT = '40000000-0000-4000-8000-000000000001';
const FILE = '50000000-0000-4000-8000-000000000001';
const TIME = '2026-09-17T10:00:00.000Z';

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

/** A vault whose event log carries the holes compaction used to punch. */
async function makeGappyVault(sequences: readonly number[]): Promise<{
  path: string;
  database: Database.Database;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-renumber-'));
  directories.push(directory);
  const path = join(directory, 'havemind.sqlite');
  const database = openDatabase(path);
  databases.push(database);
  runMigrations(database);

  const highest = Math.max(...sequences);
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at)
       VALUES (?, 'Owner', 1, 'active', ?)`,
    )
    .run(USER, TIME);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at)
       VALUES (?, 'Vault', 0, ?, ?)`,
    )
    .run(VAULT, highest + 1, TIME);
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    )
    .run(MEMBER, VAULT, USER, TIME);
  database
    .prepare(
      `INSERT INTO devices
         (id, user_id, display_name, public_key, status, created_at, approved_at,
          vault_id, last_ack_sequence, last_ack_at)
       VALUES (?, ?, 'Phone', ?, 'approved', ?, ?, ?, ?, ?)`,
    )
    .run(DEVICE, USER, Buffer.alloc(32, 0x11), TIME, TIME, VAULT, highest, TIME);
  database
    .prepare(
      `INSERT INTO files (id, vault_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(FILE, VAULT, TIME);

  const insertRevision = database.prepare(
    `INSERT INTO revisions
       (id, vault_id, file_id, membership_id, device_id, server_sequence,
        write_epoch, protected_header, protected_header_hash, blob_hash,
        blob_size, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO vault_events
       (vault_id, server_sequence, event_type, revision_id, event_payload, created_at)
     VALUES (?, ?, 'revision-accepted', ?, '{}', ?)`,
  );
  for (const sequence of sequences) {
    const revisionId = `60000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    insertRevision.run(
      revisionId,
      VAULT,
      FILE,
      MEMBER,
      DEVICE,
      sequence,
      Buffer.from(`header-${sequence}`),
      String(sequence).padStart(64, '0'),
      String(sequence).padStart(64, 'a'),
      TIME,
      TIME,
    );
    insertEvent.run(VAULT, sequence, revisionId, TIME);
  }
  const lastSequence = sequences[sequences.length - 1] ?? 0;
  database
    .prepare(
      `INSERT INTO file_heads (file_id, revision_id) VALUES (?, ?)`,
    )
    .run(
      FILE,
      `60000000-0000-4000-8000-${String(lastSequence).padStart(12, '0')}`,
    );
  return { path, database };
}

function run(path: string, ...args: string[]): string {
  return execFileSync('node', [SCRIPT, path, ...args], { encoding: 'utf8' });
}

function sequences(database: Database.Database): number[] {
  return (
    database
      .prepare(
        `SELECT server_sequence AS s FROM vault_events WHERE vault_id = ? ORDER BY s`,
      )
      .all(VAULT) as Array<{ s: number }>
  ).map((row) => row.s);
}

describe('renumber-event-log', () => {
  it('reports holes without touching anything on a dry run', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    const output = run(path, '--vault', VAULT);

    expect(output).toContain('HOLES');
    expect(output).toContain('Dry run');
    expect(sequences(database)).toEqual([3, 5, 6, 9]);
  });

  it('renumbers a gappy log to a contiguous 1..N', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    expect(sequences(database)).toEqual([1, 2, 3, 4]);
    const vault = database
      .prepare(`SELECT next_server_sequence AS next FROM vaults WHERE id = ?`)
      .get(VAULT) as { next: number };
    expect(vault.next).toBe(5);
  });

  it('keeps every revision, file and head', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const counts = database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM revisions) AS revisions,
                (SELECT COUNT(*) FROM files) AS files,
                (SELECT COUNT(*) FROM file_heads) AS heads`,
      )
      .get() as { revisions: number; files: number; heads: number };
    expect(counts).toEqual({ revisions: 4, files: 1, heads: 1 });
  });

  it('preserves the order the events were committed in', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const order = (
      database
        .prepare(
          `SELECT revision_id AS id FROM vault_events WHERE vault_id = ? ORDER BY server_sequence`,
        )
        .all(VAULT) as Array<{ id: string }>
    ).map((row) => row.id.slice(-2));
    expect(order).toEqual(['03', '05', '06', '09']);
  });

  it('clears device cursors, which point into the old numbering', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const device = database
      .prepare(`SELECT last_ack_sequence AS ack FROM devices WHERE id = ?`)
      .get(DEVICE) as { ack: number | null };
    expect(device.ack).toBeNull();
  });

  it('leaves an already-contiguous log alone', async () => {
    const { path, database } = await makeGappyVault([1, 2, 3]);
    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('already contiguous');
    expect(sequences(database)).toEqual([1, 2, 3]);
  });
});
