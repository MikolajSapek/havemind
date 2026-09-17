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
     VALUES (?, ?, 'revision-accepted', ?, ?, ?)`,
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
    insertEvent.run(
      VAULT,
      sequence,
      revisionId,
      JSON.stringify({
        fileId: FILE,
        receipt: { revisionId, serverSequence: sequence },
      }),
      TIME,
    );
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

  it('renumbers revisions in lockstep with their events', async () => {
    // `listHeadEvents` joins `vault_events` to `revisions` ON server_sequence.
    // Renumbering only one side silently breaks that join: a head whose revision
    // still carries the OLD sequence resolves to no event, so the snapshot pull
    // returns a short page and the vault looks half-empty. Both tables carry the
    // same sequence for the same commit and must move together.
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const revisionSequences = (
      database
        .prepare(
          `SELECT server_sequence AS s FROM revisions WHERE vault_id = ? ORDER BY s`,
        )
        .all(VAULT) as Array<{ s: number }>
    ).map((row) => row.s);
    expect(revisionSequences).toEqual([1, 2, 3, 4]);

    // Every revision still pairs with its own event, which is what the head
    // lookup depends on.
    const orphans = (
      database
        .prepare(
          `SELECT COUNT(*) AS c
             FROM revisions r
             LEFT JOIN vault_events e
               ON e.vault_id = r.vault_id AND e.server_sequence = r.server_sequence
            WHERE r.vault_id = ? AND e.server_sequence IS NULL`,
        )
        .get(VAULT) as { c: number }
    ).c;
    expect(orphans).toBe(0);
  });

  it('keeps each event paired with the revision it was committed for', async () => {
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const pairs = (
      database
        .prepare(
          `SELECT e.server_sequence AS seq, e.revision_id AS eventRevision,
                  r.id AS revisionId
             FROM vault_events e
             JOIN revisions r
               ON r.vault_id = e.vault_id AND r.server_sequence = e.server_sequence
            WHERE e.vault_id = ? ORDER BY e.server_sequence`,
        )
        .all(VAULT) as Array<{ seq: number; eventRevision: string; revisionId: string }>
    );
    expect(pairs).toHaveLength(4);
    for (const pair of pairs) {
      expect(pair.eventRevision).toBe(pair.revisionId);
    }
  });

  it('leaves an already-contiguous log alone', async () => {
    const { path, database } = await makeGappyVault([1, 2, 3]);
    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('already contiguous');
    expect(sequences(database)).toEqual([1, 2, 3]);
  });
});

/**
 * Repairing a database left half-renumbered by the first version of this script.
 *
 * That version moved `vault_events.server_sequence` but not
 * `revisions.server_sequence`, so the two tables disagree and the head lookup
 * (which joins them on that column) resolves most files to nothing. The link
 * that survives is `vault_events.revision_id`, so each revision can be put back
 * on the sequence its own event carries.
 */
describe('renumber-event-log --resync-revisions', () => {
  it('restores each revision to the sequence its event carries', async () => {
    const { path, database } = await makeGappyVault([1, 2, 3, 4]);
    // Simulate the half-renumbered damage: shift revisions away from events.
    database
      .prepare(
        `UPDATE revisions SET server_sequence = server_sequence + 500 WHERE vault_id = ?`,
      )
      .run(VAULT);
    const before = (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM revisions r
             LEFT JOIN vault_events e
               ON e.vault_id = r.vault_id AND e.server_sequence = r.server_sequence
            WHERE e.server_sequence IS NULL`,
        )
        .get() as { c: number }
    ).c;
    expect(before).toBe(4);

    run(path, '--vault', VAULT, '--resync-revisions', '--apply');

    const after = (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM revisions r
             LEFT JOIN vault_events e
               ON e.vault_id = r.vault_id AND e.server_sequence = r.server_sequence
            WHERE e.server_sequence IS NULL`,
        )
        .get() as { c: number }
    ).c;
    expect(after).toBe(0);

    // Each revision sits on the sequence of the event that names it.
    const mismatches = (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM vault_events e
             JOIN revisions r ON r.id = e.revision_id
            WHERE r.server_sequence <> e.server_sequence`,
        )
        .get() as { c: number }
    ).c;
    expect(mismatches).toBe(0);
  });

  it('rewrites the sequence embedded in each event payload', async () => {
    // `#parseEventRow` rejects a row whose payload receipt disagrees with the
    // cursor column ("Event receipt does not match its cursor row"), which the
    // route turns into a 500 on every pull. The payload carries its own copy of
    // serverSequence, so renumbering has to rewrite it too.
    const { path, database } = await makeGappyVault([3, 5, 6, 9]);
    run(path, '--vault', VAULT, '--apply');

    const mismatches = (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM vault_events
            WHERE CAST(json_extract(event_payload, '$.receipt.serverSequence') AS INTEGER)
                  <> server_sequence`,
        )
        .get() as { c: number }
    ).c;
    expect(mismatches).toBe(0);
  });

  it('leaves a healthy database untouched', async () => {
    const { path, database } = await makeGappyVault([1, 2, 3]);
    const before = (
      database
        .prepare(`SELECT group_concat(server_sequence) AS s FROM revisions WHERE vault_id = ?`)
        .get(VAULT) as { s: string }
    ).s;

    run(path, '--vault', VAULT, '--resync-revisions', '--apply');

    const after = (
      database
        .prepare(`SELECT group_concat(server_sequence) AS s FROM revisions WHERE vault_id = ?`)
        .get(VAULT) as { s: string }
    ).s;
    expect(after).toBe(before);
  });
});
