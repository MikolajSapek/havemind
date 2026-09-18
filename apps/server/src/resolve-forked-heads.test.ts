/**
 * Collapsing forked heads must never lose a revision, a blob or an event, and
 * must never leave a file without a current version.
 *
 * Driven through the real script, so the thing that touches production data is
 * the thing under test. This is the same discipline the event-log repair needed
 * after it shipped three times half-finished.
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
  'resolve-forked-heads.mjs',
);

const USER = '10000000-0000-4000-8000-000000000001';
const DEVICE = '20000000-0000-4000-8000-000000000001';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const VAULT = '40000000-0000-4000-8000-000000000001';
const TIME = '2026-09-18T10:00:00.000Z';

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

interface HeadSpec {
  /** Distinct blob hashes mean genuinely different content. */
  readonly blob: string;
  /** Later date wins. */
  readonly acceptedAt: string;
}

async function makeVaultWithForks(
  files: ReadonlyArray<{ fileId: string; heads: readonly HeadSpec[] }>,
): Promise<{ path: string; database: Database.Database }> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-forks-'));
  directories.push(directory);
  const path = join(directory, 'havemind.sqlite');
  const database = openDatabase(path);
  databases.push(database);
  runMigrations(database);

  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at)
       VALUES (?, 'Owner', 1, 'active', ?)`,
    )
    .run(USER, TIME);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at)
       VALUES (?, 'Vault', 0, 1, ?)`,
    )
    .run(VAULT, TIME);
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    )
    .run(MEMBER, VAULT, USER, TIME);
  database
    .prepare(
      `INSERT INTO devices
         (id, user_id, display_name, public_key, status, created_at, approved_at, vault_id)
       VALUES (?, ?, 'Device', ?, 'approved', ?, ?, ?)`,
    )
    .run(DEVICE, USER, Buffer.alloc(32, 0x11), TIME, TIME, VAULT);

  const insertFile = database.prepare(
    `INSERT INTO files (id, vault_id, created_at) VALUES (?, ?, ?)`,
  );
  const insertRevision = database.prepare(
    `INSERT INTO revisions
       (id, vault_id, file_id, membership_id, device_id, server_sequence,
        write_epoch, protected_header, protected_header_hash, blob_hash,
        blob_size, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`,
  );
  const insertHead = database.prepare(
    `INSERT INTO file_heads (file_id, revision_id) VALUES (?, ?)`,
  );

  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  let sequence = 0;
  for (const file of files) {
    insertFile.run(file.fileId, VAULT, TIME);
    for (const head of file.heads) {
      sequence += 1;
      const revisionId = `60000000-0000-4000-8000-${pad(sequence, 12)}`;
      insertRevision.run(
        revisionId,
        VAULT,
        file.fileId,
        MEMBER,
        DEVICE,
        sequence,
        Buffer.from(`header-${sequence}`),
        pad(sequence, 64),
        head.blob.padStart(64, '0'),
        TIME,
        head.acceptedAt,
      );
      insertHead.run(file.fileId, revisionId);
    }
  }
  database
    .prepare(`UPDATE vaults SET next_server_sequence = ? WHERE id = ?`)
    .run(sequence + 1, VAULT);
  return { path, database };
}

function run(path: string, ...args: string[]): string {
  return execFileSync('node', [SCRIPT, path, ...args], { encoding: 'utf8' });
}

function headCount(database: Database.Database, fileId: string): number {
  return (
    database
      .prepare(`SELECT COUNT(*) AS c FROM file_heads WHERE file_id = ?`)
      .get(fileId) as { c: number }
  ).c;
}

function headAcceptedAt(database: Database.Database, fileId: string): string {
  return (
    database
      .prepare(
        `SELECT r.accepted_at AS at FROM file_heads fh
           JOIN revisions r ON r.id = fh.revision_id
          WHERE fh.file_id = ?`,
      )
      .get(fileId) as { at: string }
  ).at;
}

const FILE_ONE = '50000000-0000-4000-8000-000000000001';
const FILE_TWO = '50000000-0000-4000-8000-000000000002';

describe('resolve-forked-heads', () => {
  it('reports without changing anything on a dry run', async () => {
    const { path, database } = await makeVaultWithForks([
      {
        fileId: FILE_ONE,
        heads: [
          { blob: 'aa', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'bb', acceptedAt: '2026-09-17T11:00:00.000Z' },
        ],
      },
    ]);

    const output = run(path, '--vault', VAULT);
    expect(output).toContain('forked files: 1');
    expect(output).toContain('Dry run');
    expect(headCount(database, FILE_ONE)).toBe(2);
  });

  it('keeps the most recently accepted head', async () => {
    const { path, database } = await makeVaultWithForks([
      {
        fileId: FILE_ONE,
        heads: [
          { blob: 'aa', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'bb', acceptedAt: '2026-09-17T12:00:00.000Z' },
          { blob: 'cc', acceptedAt: '2026-09-17T11:00:00.000Z' },
        ],
      },
    ]);

    run(path, '--vault', VAULT, '--apply');

    expect(headCount(database, FILE_ONE)).toBe(1);
    expect(headAcceptedAt(database, FILE_ONE)).toBe('2026-09-17T12:00:00.000Z');
  });

  it('never deletes a revision, only the head pointer', async () => {
    const { path, database } = await makeVaultWithForks([
      {
        fileId: FILE_ONE,
        heads: [
          { blob: 'aa', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'bb', acceptedAt: '2026-09-17T12:00:00.000Z' },
        ],
      },
    ]);
    const before = (
      database.prepare(`SELECT COUNT(*) AS c FROM revisions`).get() as { c: number }
    ).c;

    run(path, '--vault', VAULT, '--apply');

    const after = (
      database.prepare(`SELECT COUNT(*) AS c FROM revisions`).get() as { c: number }
    ).c;
    expect(after).toBe(before);
    // The losing version is still reachable in history.
    expect(after).toBe(2);
  });

  it('leaves no file without a head', async () => {
    const { path, database } = await makeVaultWithForks([
      {
        fileId: FILE_ONE,
        heads: [
          { blob: 'aa', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'bb', acceptedAt: '2026-09-17T12:00:00.000Z' },
        ],
      },
      { fileId: FILE_TWO, heads: [{ blob: 'cc', acceptedAt: TIME }] },
    ]);

    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('Verified');
    expect(headCount(database, FILE_ONE)).toBe(1);
    // An already-healthy file is untouched.
    expect(headCount(database, FILE_TWO)).toBe(1);
  });

  it('--identical-only merges the safe forks and leaves divergent ones alone', async () => {
    const { path, database } = await makeVaultWithForks([
      {
        // Same content under two heads: an artefact, nothing to choose.
        fileId: FILE_ONE,
        heads: [
          { blob: 'aa', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'aa', acceptedAt: '2026-09-17T11:00:00.000Z' },
        ],
      },
      {
        // Genuinely different versions: left for a human.
        fileId: FILE_TWO,
        heads: [
          { blob: 'bb', acceptedAt: '2026-09-17T10:00:00.000Z' },
          { blob: 'cc', acceptedAt: '2026-09-17T11:00:00.000Z' },
        ],
      },
    ]);

    run(path, '--vault', VAULT, '--identical-only', '--apply');

    expect(headCount(database, FILE_ONE)).toBe(1);
    expect(headCount(database, FILE_TWO)).toBe(2);
  });

  it('does nothing to a vault with no forks', async () => {
    const { path, database } = await makeVaultWithForks([
      { fileId: FILE_ONE, heads: [{ blob: 'aa', acceptedAt: TIME }] },
    ]);

    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('Nothing to resolve');
    expect(headCount(database, FILE_ONE)).toBe(1);
  });
});
