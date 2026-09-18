/**
 * Paging a snapshot must never drop a file.
 *
 * A joining device asks for the vault's CURRENT heads, and the server hands them
 * back a page at a time. The page boundary is `server_sequence`, but head
 * sequences are SPARSE: superseded revisions keep their numbers, so on the pilot
 * vault 898 heads are spread over sequences 1..933, with 35 gaps.
 *
 * That sparseness is what makes `server_sequence` unusable as a page cursor. The
 * client resumes from the highest sequence it received, which is correct only if
 * sequences are dense. With gaps, a page can end at 920 while heads at 915 and
 * 918 were never on any page, and those files are then invisible to that device
 * forever: the next page starts strictly above 920.
 *
 * These tests pin the invariant that matters regardless of implementation:
 * paging the whole snapshot returns EVERY head exactly once.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import { RevisionRepository } from './revision-repository.js';
import { BlobStore } from './blob-store.js';

const USER = '10000000-0000-4000-8000-000000000001';
const DEVICE = '20000000-0000-4000-8000-000000000001';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const VAULT = '40000000-0000-4000-8000-000000000001';
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

/**
 * A vault holding `headCount` files whose head sequences are deliberately
 * sparse: every `gapEvery`-th sequence belongs to a superseded revision instead,
 * reproducing the shape a long-lived vault actually has.
 */
async function makeSparseVault(
  headCount: number,
  gapEvery: number,
): Promise<{ repository: RevisionRepository; database: Database.Database }> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-snapshot-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
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
       VALUES (?, ?, 'Phone', ?, 'approved', ?, ?, ?)`,
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
  const insertEvent = database.prepare(
    `INSERT INTO vault_events
       (vault_id, server_sequence, event_type, revision_id, event_payload, created_at)
     VALUES (?, ?, 'revision-accepted', ?, ?, ?)`,
  );
  const insertHead = database.prepare(
    `INSERT INTO file_heads (file_id, revision_id) VALUES (?, ?)`,
  );

  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  let sequence = 0;
  let heads = 0;
  let fileIndex = 0;
  // Walk sequences, making most of them a head and every `gapEvery`-th one a
  // superseded revision of a file that already has a newer head.
  while (heads < headCount) {
    sequence += 1;
    const revisionId = `60000000-0000-4000-8000-${pad(sequence, 12)}`;
    const superseded = sequence % gapEvery === 0 && fileIndex > 0;
    const fileId = superseded
      ? `50000000-0000-4000-8000-${pad(fileIndex, 12)}`
      : `50000000-0000-4000-8000-${pad(fileIndex + 1, 12)}`;
    if (!superseded) {
      fileIndex += 1;
      insertFile.run(fileId, VAULT, TIME);
    }
    insertRevision.run(
      revisionId,
      VAULT,
      fileId,
      MEMBER,
      DEVICE,
      sequence,
      Buffer.from(`header-${sequence}`),
      pad(sequence, 64),
      pad(sequence, 64),
      TIME,
      TIME,
    );
    insertEvent.run(
      VAULT,
      sequence,
      revisionId,
      JSON.stringify({
        fileId,
        receipt: {
          revisionId,
          serverSequence: sequence,
          memberId: MEMBER,
          deviceId: DEVICE,
          serverTime: TIME,
          blobHash: pad(sequence, 64),
          byteLength: 0,
        },
      }),
      TIME,
    );
    if (!superseded) {
      insertHead.run(fileId, revisionId);
      heads += 1;
    }
  }
  database
    .prepare(`UPDATE vaults SET next_server_sequence = ? WHERE id = ?`)
    .run(sequence + 1, VAULT);

  const blobStore = new BlobStore(join(directory, 'blobs'));
  return {
    database,
    repository: new RevisionRepository(database, blobStore, {
      now: () => new Date(TIME),
    }),
  };
}

/** Drives the paging loop exactly as the client does and collects every head. */
function pageThroughSnapshot(
  repository: RevisionRepository,
  limit: number,
): string[] {
  const seen: string[] = [];
  let cursor = 0;
  for (let page = 0; page < 1000; page += 1) {
    const events = repository.listHeadEvents(VAULT, cursor, limit);
    if (events.length === 0) break;
    for (const event of events) seen.push(event.revisionId);
    const highest = events[events.length - 1]?.serverSequence ?? cursor;
    if (highest <= cursor) break;
    cursor = highest;
    if (events.length < limit) break;
  }
  return seen;
}

describe('snapshot paging over sparse head sequences', () => {
  it('returns every head when the vault fits in one page', async () => {
    const { repository } = await makeSparseVault(50, 7);
    expect(pageThroughSnapshot(repository, 1000)).toHaveLength(50);
  });

  it('returns every head when paging is required', async () => {
    // The pilot shape: many more heads than one page holds, sequences sparse.
    const { repository } = await makeSparseVault(250, 7);
    const seen = pageThroughSnapshot(repository, 100);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });

  it('returns every head at a page size that lands exactly on a boundary', async () => {
    const { repository } = await makeSparseVault(200, 5);
    const seen = pageThroughSnapshot(repository, 100);
    expect(seen).toHaveLength(200);
  });

  it('never repeats a head across pages', async () => {
    const { repository } = await makeSparseVault(180, 3);
    const seen = pageThroughSnapshot(repository, 40);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
