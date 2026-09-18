/**
 * Merging duplicates must retire only byte-identical copies, and lose nothing.
 *
 * Driven through the real script, because every repair script in this project
 * that was tested only by reading it needed several attempts in production.
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
  'merge-duplicate-files.mjs',
);

const USER = '10000000-0000-4000-8000-000000000001';
const DEVICE_A = '20000000-0000-4000-8000-00000000000a';
const DEVICE_B = '20000000-0000-4000-8000-00000000000b';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const VAULT = '40000000-0000-4000-8000-000000000001';
const TIME = '2026-09-19T10:00:00.000Z';

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

interface FileSpec {
  readonly fileId: string;
  /** Distinct blobs mean distinct content. */
  readonly blob: string;
  readonly device: string;
}

async function makeVault(
  files: readonly FileSpec[],
): Promise<{ path: string; database: Database.Database }> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-dup-'));
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
  const insertDevice = database.prepare(
    `INSERT INTO devices
       (id, user_id, display_name, public_key, status, created_at, approved_at, vault_id)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`,
  );
  insertDevice.run(DEVICE_A, USER, 'Desktop', Buffer.alloc(32, 0x11), TIME, TIME, VAULT);
  insertDevice.run(DEVICE_B, USER, 'Phone', Buffer.alloc(32, 0x22), TIME, TIME, VAULT);

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
    sequence += 1;
    insertFile.run(file.fileId, VAULT, TIME);
    const revisionId = `60000000-0000-4000-8000-${pad(sequence, 12)}`;
    insertRevision.run(
      revisionId,
      VAULT,
      file.fileId,
      MEMBER,
      file.device,
      sequence,
      Buffer.from(`header-${sequence}`),
      pad(sequence, 64),
      file.blob.padStart(64, '0'),
      TIME,
      TIME,
    );
    insertHead.run(file.fileId, revisionId);
  }
  database
    .prepare(`UPDATE vaults SET next_server_sequence = ? WHERE id = ?`)
    .run(sequence + 1, VAULT);
  return { path, database };
}

function run(path: string, ...args: string[]): string {
  return execFileSync('node', [SCRIPT, path, ...args], { encoding: 'utf8' });
}

function currentFiles(database: Database.Database): string[] {
  return (
    database
      .prepare(`SELECT file_id AS id FROM file_heads ORDER BY file_id`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id.slice(0, 8));
}

const F1 = '50000000-0000-4000-8000-000000000001';
const F2 = '50000000-0000-4000-8000-000000000002';
const F3 = '50000000-0000-4000-8000-000000000003';

describe('merge-duplicate-files', () => {
  it('reports without changing anything on a dry run', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'aa', device: DEVICE_B },
    ]);

    const output = run(path, '--vault', VAULT);

    expect(output).toContain('duplicated contents:  1');
    expect(output).toContain('Dry run');
    expect(currentFiles(database)).toHaveLength(2);
  });

  it('keeps the earliest upload and retires the later copy', async () => {
    // The desktop uploaded first; the phone re-sent the same bytes.
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'aa', device: DEVICE_B },
    ]);

    run(path, '--vault', VAULT, '--apply');

    expect(currentFiles(database)).toEqual([F1.slice(0, 8)]);
  });

  it('never touches files whose content differs', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'bb', device: DEVICE_B },
      { fileId: F3, blob: 'cc', device: DEVICE_B },
    ]);

    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('Nothing to merge');
    expect(currentFiles(database)).toHaveLength(3);
  });

  it('deletes no revision, blob reference or event', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'aa', device: DEVICE_B },
    ]);
    const before = (
      database.prepare(`SELECT COUNT(*) AS c FROM revisions`).get() as { c: number }
    ).c;

    run(path, '--vault', VAULT, '--apply');

    const after = (
      database.prepare(`SELECT COUNT(*) AS c FROM revisions`).get() as { c: number }
    ).c;
    expect(after).toBe(before);
    // The retired copy is still reachable in history, just not current.
    expect(after).toBe(2);
  });

  it('collapses a content duplicated three ways to one', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'aa', device: DEVICE_B },
      { fileId: F3, blob: 'aa', device: DEVICE_B },
    ]);

    run(path, '--vault', VAULT, '--apply');

    expect(currentFiles(database)).toEqual([F1.slice(0, 8)]);
  });

  it('handles a vault mixing duplicates and unique files', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
      { fileId: F2, blob: 'bb', device: DEVICE_A },
      { fileId: F3, blob: 'aa', device: DEVICE_B },
    ]);

    const output = run(path, '--vault', VAULT, '--apply');

    expect(currentFiles(database)).toEqual([F1.slice(0, 8), F2.slice(0, 8)].sort());
    expect(output).toContain('Verified');
  });

  it('does nothing to a vault with no duplicates', async () => {
    const { path, database } = await makeVault([
      { fileId: F1, blob: 'aa', device: DEVICE_A },
    ]);

    const output = run(path, '--vault', VAULT, '--apply');

    expect(output).toContain('Nothing to merge');
    expect(currentFiles(database)).toHaveLength(1);
  });
});
