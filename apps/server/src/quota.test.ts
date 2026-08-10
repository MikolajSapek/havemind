import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_VAULT_QUOTA_BYTES } from './config.js';
import { DB_FILENAME, openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import {
  computeVaultStorageBytes,
  readVaultQuotaBytes,
  resolveEffectiveQuotaBytes,
  vaultContainsBlob,
} from './quota.js';

/**
 * Direct unit coverage for the per-vault storage accounting of plans/005.
 *
 * Revisions are inserted with raw SQL rather than through `RevisionRepository`
 * on purpose: the accounting contract is defined over `revisions.blob_hash` and
 * `revisions.blob_size` alone, and only raw inserts can express the boundary
 * rows a real commit path would never produce (a zero-byte blob, one hash with
 * two recorded sizes). These are characterisation tests — they pin down what
 * the module does today.
 */

const START_TIME = '2026-08-09T09:00:00.000Z';

const USER_A = '80000000-0000-4000-8000-0000000000a1';
const DEVICE_A = '80000000-0000-4000-8000-0000000000a2';
const VAULT_A = '80000000-0000-4000-8000-0000000000a3';
const VAULT_B = '80000000-0000-4000-8000-0000000000b3';
const MEMBERSHIP_A = '80000000-0000-4000-8000-0000000000a4';
const MEMBERSHIP_B = '80000000-0000-4000-8000-0000000000b4';
const FILE_A1 = '80000000-0000-4000-8000-0000000000a5';
const FILE_A2 = '80000000-0000-4000-8000-0000000000a6';
const FILE_B1 = '80000000-0000-4000-8000-0000000000b5';
const UNKNOWN_VAULT = '80000000-0000-4000-8000-00000000dead';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A syntactically valid 64-character blob hash derived from a readable label. */
function blobHash(label: string): string {
  return label.padEnd(64, '0').slice(0, 64);
}

interface InsertRevisionInput {
  readonly vaultId: string;
  readonly fileId: string;
  readonly blobHash: string;
  readonly blobSize: number;
}

interface Fixture {
  readonly database: Database.Database;
  insertRevision(input: InsertRevisionInput): void;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-quota-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, DB_FILENAME));
  databases.push(database);
  runMigrations(database);

  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, 1, 'active', ?, NULL)`,
    )
    .run(USER_A, 'Owner', START_TIME);
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(DEVICE_A, USER_A, 'Owner Laptop', Buffer.alloc(32, 0x22), START_TIME, START_TIME);

  const insertVault = database.prepare(
    `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
     VALUES (?, ?, 0, 1, ?, NULL)`,
  );
  const insertMembership = database.prepare(
    `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
  );
  const insertFile = database.prepare(
    `INSERT INTO files (id, vault_id, created_at) VALUES (?, ?, ?)`,
  );

  insertVault.run(VAULT_A, 'Vault A', START_TIME);
  insertVault.run(VAULT_B, 'Vault B', START_TIME);
  insertMembership.run(MEMBERSHIP_A, VAULT_A, USER_A, START_TIME);
  insertMembership.run(MEMBERSHIP_B, VAULT_B, USER_A, START_TIME);
  insertFile.run(FILE_A1, VAULT_A, START_TIME);
  insertFile.run(FILE_A2, VAULT_A, START_TIME);
  insertFile.run(FILE_B1, VAULT_B, START_TIME);

  const insertRevisionStatement = database.prepare(
    `INSERT INTO revisions (
       id, vault_id, file_id, membership_id, device_id, server_sequence, write_epoch,
       protected_header, protected_header_hash, blob_hash, blob_size, created_at, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );

  let revisionCount = 0;
  const sequences = new Map<string, number>();

  return {
    database,
    insertRevision(input: InsertRevisionInput): void {
      revisionCount += 1;
      const sequence = (sequences.get(input.vaultId) ?? 0) + 1;
      sequences.set(input.vaultId, sequence);
      const membershipId = input.vaultId === VAULT_B ? MEMBERSHIP_B : MEMBERSHIP_A;
      insertRevisionStatement.run(
        `revision-${String(revisionCount)}`,
        input.vaultId,
        input.fileId,
        membershipId,
        DEVICE_A,
        sequence,
        Buffer.from(`header-${String(revisionCount)}`, 'utf8'),
        blobHash(`header-hash-${String(revisionCount)}-`),
        input.blobHash,
        input.blobSize,
        START_TIME,
        START_TIME,
      );
    },
  };
}

describe('computeVaultStorageBytes', () => {
  it('reports zero bytes for a vault with no revisions and for an unknown vault id', () => {
    const fixture = makeFixture();

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(0);
    expect(computeVaultStorageBytes(fixture.database, UNKNOWN_VAULT)).toBe(0);
  });

  it('counts a zero-byte blob as zero bytes', () => {
    const fixture = makeFixture();
    fixture.insertRevision({
      blobHash: blobHash('empty-'),
      blobSize: 0,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(0);
  });

  it('sums blob_size over the distinct blobs a vault references', () => {
    const fixture = makeFixture();
    fixture.insertRevision({
      blobHash: blobHash('one-'),
      blobSize: 100,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: blobHash('two-'),
      blobSize: 23,
      fileId: FILE_A2,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(123);
  });

  it('charges a shared blob once even when several files and revisions reference it', () => {
    const fixture = makeFixture();
    const shared = blobHash('shared-');
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 512,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 512,
      fileId: FILE_A2,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 512,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(512);
  });

  it('keeps charging the blobs of superseded revisions of the same file', () => {
    const fixture = makeFixture();
    fixture.insertRevision({
      blobHash: blobHash('gen-1-'),
      blobSize: 10,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: blobHash('gen-2-'),
      blobSize: 20,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(30);
  });

  it('accounts per vault, charging a cross-vault duplicate to both vaults', () => {
    const fixture = makeFixture();
    const shared = blobHash('cross-vault-');
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 64,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 64,
      fileId: FILE_B1,
      vaultId: VAULT_B,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(64);
    expect(computeVaultStorageBytes(fixture.database, VAULT_B)).toBe(64);
  });

  it('charges one hash twice when it is recorded with two conflicting sizes', () => {
    // Characterisation, not an endorsement: the query de-duplicates the
    // (blob_hash, blob_size) pair, not blob_hash alone. The CAS makes the size
    // a function of the hash, so the honest commit path cannot produce these
    // rows; a corrupted or hand-edited row would be charged twice.
    const fixture = makeFixture();
    const shared = blobHash('conflicting-');
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 100,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });
    fixture.insertRevision({
      blobHash: shared,
      blobSize: 7,
      fileId: FILE_A2,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A)).toBe(107);
  });
});

describe('readVaultQuotaBytes', () => {
  it('returns null when the vault inherits the server-wide default', () => {
    const fixture = makeFixture();

    expect(readVaultQuotaBytes(fixture.database, VAULT_A)).toBeNull();
  });

  it('returns the explicit per-vault quota when one is set', () => {
    const fixture = makeFixture();
    fixture.database
      .prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`)
      .run(4096, VAULT_A);

    expect(readVaultQuotaBytes(fixture.database, VAULT_A)).toBe(4096);
    expect(readVaultQuotaBytes(fixture.database, VAULT_B)).toBeNull();
  });

  it('returns 0 — not null — for a vault pinned to a zero quota', () => {
    const fixture = makeFixture();
    fixture.database
      .prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`)
      .run(0, VAULT_A);

    expect(readVaultQuotaBytes(fixture.database, VAULT_A)).toBe(0);
  });

  it('returns null for an unknown vault id, indistinguishable from inheriting', () => {
    const fixture = makeFixture();

    expect(readVaultQuotaBytes(fixture.database, UNKNOWN_VAULT)).toBeNull();
  });

  it('can never yield a negative quota because the schema rejects one', () => {
    const fixture = makeFixture();

    expect(() =>
      fixture.database
        .prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`)
        .run(-1, VAULT_A),
    ).toThrow(/CHECK constraint failed/);
    expect(readVaultQuotaBytes(fixture.database, VAULT_A)).toBeNull();
  });
});

describe('resolveEffectiveQuotaBytes', () => {
  it('falls back to DEFAULT_VAULT_QUOTA_BYTES when no default is supplied', () => {
    expect(resolveEffectiveQuotaBytes(null)).toBe(DEFAULT_VAULT_QUOTA_BYTES);
  });

  it('falls back to the supplied server default for an inheriting vault', () => {
    expect(resolveEffectiveQuotaBytes(null, 5_000)).toBe(5_000);
  });

  it('prefers an explicit per-vault quota over the server default', () => {
    expect(resolveEffectiveQuotaBytes(1_024, 5_000)).toBe(1_024);
  });

  it('keeps an explicit zero quota instead of treating it as unset', () => {
    expect(resolveEffectiveQuotaBytes(0, 5_000)).toBe(0);
  });

  it('passes a negative raw quota through unchanged without clamping', () => {
    // Not reachable through the schema (see readVaultQuotaBytes); documented so
    // callers know this function validates nothing.
    expect(resolveEffectiveQuotaBytes(-1, 5_000)).toBe(-1);
  });
});

describe('vaultContainsBlob', () => {
  it('is true for a referenced hash and false for one no revision references', () => {
    const fixture = makeFixture();
    const stored = blobHash('stored-');
    fixture.insertRevision({
      blobHash: stored,
      blobSize: 8,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(vaultContainsBlob(fixture.database, VAULT_A, stored)).toBe(true);
    expect(vaultContainsBlob(fixture.database, VAULT_A, blobHash('absent-'))).toBe(
      false,
    );
  });

  it('is true for a zero-byte blob, which is charged nothing but is still present', () => {
    const fixture = makeFixture();
    const empty = blobHash('empty-');
    fixture.insertRevision({
      blobHash: empty,
      blobSize: 0,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(vaultContainsBlob(fixture.database, VAULT_A, empty)).toBe(true);
  });

  it('is false for a hash only another vault references', () => {
    const fixture = makeFixture();
    const foreign = blobHash('foreign-');
    fixture.insertRevision({
      blobHash: foreign,
      blobSize: 32,
      fileId: FILE_B1,
      vaultId: VAULT_B,
    });

    expect(vaultContainsBlob(fixture.database, VAULT_A, foreign)).toBe(false);
    expect(vaultContainsBlob(fixture.database, VAULT_B, foreign)).toBe(true);
  });

  it('is false for an unknown vault id', () => {
    const fixture = makeFixture();
    const stored = blobHash('stored-');
    fixture.insertRevision({
      blobHash: stored,
      blobSize: 8,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    expect(vaultContainsBlob(fixture.database, UNKNOWN_VAULT, stored)).toBe(false);
  });
});

describe('quota boundary', () => {
  it('treats usage exactly at an explicit quota as within it, and one byte more as over', () => {
    const fixture = makeFixture();
    fixture.database
      .prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`)
      .run(1_000, VAULT_A);
    fixture.insertRevision({
      blobHash: blobHash('at-quota-'),
      blobSize: 1_000,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    const quota = resolveEffectiveQuotaBytes(
      readVaultQuotaBytes(fixture.database, VAULT_A),
    );
    const used = computeVaultStorageBytes(fixture.database, VAULT_A);

    expect(used).toBe(1_000);
    expect(used > quota).toBe(false);

    fixture.insertRevision({
      blobHash: blobHash('one-over-'),
      blobSize: 1,
      fileId: FILE_A2,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A) > quota).toBe(true);
  });

  it('applies the same boundary to a vault inheriting the server default', () => {
    const fixture = makeFixture();
    const defaultQuotaBytes = 2_048;
    fixture.insertRevision({
      blobHash: blobHash('inherit-'),
      blobSize: defaultQuotaBytes,
      fileId: FILE_A1,
      vaultId: VAULT_A,
    });

    const quota = resolveEffectiveQuotaBytes(
      readVaultQuotaBytes(fixture.database, VAULT_A),
      defaultQuotaBytes,
    );

    expect(quota).toBe(defaultQuotaBytes);
    expect(computeVaultStorageBytes(fixture.database, VAULT_A) > quota).toBe(false);

    fixture.insertRevision({
      blobHash: blobHash('inherit-over-'),
      blobSize: 1,
      fileId: FILE_A2,
      vaultId: VAULT_A,
    });

    expect(computeVaultStorageBytes(fixture.database, VAULT_A) > quota).toBe(true);
  });
});
