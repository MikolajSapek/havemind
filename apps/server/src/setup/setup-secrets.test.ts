import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from '../auth/setup.js';
import { parsePairingToken } from '../auth/tokens.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];

function openTempDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-setup-secrets-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.db'));
  runMigrations(database);
  databases.push(database);
  return database;
}

function dumpAllTables(database: Database.Database): string {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const rows: unknown[] = [];
  for (const table of tables) {
    rows.push(database.prepare(`SELECT * FROM "${table.name}"`).all());
  }
  return JSON.stringify(rows);
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe('owner setup secret storage (AC: >=256-bit, hash-only)', () => {
  it('issues a pairing token with at least 256 bits of entropy', () => {
    const database = openTempDatabase();
    const service = new OwnerSetupService(database);
    const result = service.initializeOwner(createLocalOwnerSetupContext(), {
      ownerDisplayName: 'Alice',
      vaultDisplayName: 'Notes',
    });
    // The opaque payload decodes to 32 bytes = 256 bits.
    const payload = parsePairingToken(result.pairingToken).slice('hm_pt_'.length);
    expect(Buffer.from(payload, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('persists only the hash of the pairing token, never the raw token', () => {
    const database = openTempDatabase();
    const service = new OwnerSetupService(database);
    const result = service.initializeOwner(createLocalOwnerSetupContext(), {
      ownerDisplayName: 'Alice',
      vaultDisplayName: 'Notes',
    });

    const dump = dumpAllTables(database);
    // The raw token appears nowhere in persisted state.
    expect(dump).not.toContain(result.pairingToken);
    // Its hash does — that is the only server-side representation.
    const expectedHash = createHash('sha256')
      .update(result.pairingToken, 'utf8')
      .digest('hex');
    expect(dump).toContain(expectedHash);
  });
});
