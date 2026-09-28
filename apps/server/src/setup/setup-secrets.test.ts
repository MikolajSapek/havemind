import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from '../auth/setup.js';
import { parsePairingToken } from '../auth/tokens.js';
import { runMigrations } from '../migrations.js';
import {
  makeTempDir,
  openTrackedDatabase,
  releaseTestResources,
} from '../test/fixtures/server-fixtures.js';

function openTempDatabase(): Database.Database {
  const directory = makeTempDir('havemind-setup-secrets-');
  const database = openTrackedDatabase(join(directory, 'havemind.db'));
  runMigrations(database);
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

afterEach(releaseTestResources);

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
    // Its hash does, that is the only server-side representation.
    const expectedHash = createHash('sha256')
      .update(result.pairingToken, 'utf8')
      .digest('hex');
    expect(dump).toContain(expectedHash);
  });
});
