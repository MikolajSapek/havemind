import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DatabaseConfigurationError,
  openDatabase,
} from './db.js';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  MigrationCatalogError,
  MigrationChecksumError,
  MigrationLockError,
  MigrationMetadataError,
  NewerSchemaVersionError,
  runMigrations,
} from './migrations.js';

const REQUIRED_TABLES = [
  'access_tokens',
  'devices',
  'file_heads',
  'files',
  'idempotency_records',
  'instance_state',
  'invitations',
  'memberships',
  'owner_pairings',
  'refresh_token_families',
  'refresh_tokens',
  'revision_parents',
  'revisions',
  'schema_migrations',
  'users',
  'vault_events',
  'vaults',
] as const;

const temporaryDirectories: string[] = [];
const openDatabases: Array<ReturnType<typeof openDatabase>> = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-migrations-'));
  temporaryDirectories.push(directory);
  return join(directory, 'havemind.sqlite');
}

function trackDatabase(
  database: ReturnType<typeof openDatabase>,
): ReturnType<typeof openDatabase> {
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SQLite database configuration', () => {
  it('enforces WAL, FULL synchronization, foreign keys, and bounded waiting', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));

    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.pragma('synchronous', { simple: true })).toBe(2);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
  });

  it.each(['', '   ', ':memory:', 'file::memory:?cache=shared'])(
    'rejects non-file database path %j because it cannot provide WAL durability',
    (filename) => {
      expect(() => openDatabase(filename)).toThrow(DatabaseConfigurationError);
    },
  );

  it.each([0, 30_001, 1.5])(
    'rejects an out-of-range busy timeout: %s',
    (busyTimeoutMs) => {
      expect(() =>
        openDatabase(temporaryDatabasePath(), { busyTimeoutMs }),
      ).toThrow(DatabaseConfigurationError);
    },
  );
});

describe('controlled migrations', () => {
  it('creates a new schema, records its checksum, and is idempotent', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));

    expect(runMigrations(database)).toEqual({
      appliedVersions: Array.from(
        { length: CURRENT_SCHEMA_VERSION },
        (_, index) => index + 1,
      ),
      currentVersion: CURRENT_SCHEMA_VERSION,
    });

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([...REQUIRED_TABLES]),
    );

    const migrationRows = database
      .prepare(
        `SELECT version, name, checksum, applied_at AS appliedAt
         FROM schema_migrations
         ORDER BY version`,
      )
      .all() as Array<{
      appliedAt: string;
      checksum: string;
      name: string;
      version: number;
    }>;

    expect(migrationRows).toHaveLength(CURRENT_SCHEMA_VERSION);
    expect(migrationRows[0]).toMatchObject({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      name: 'initial',
      version: 1,
    });
    expect(migrationRows[1]).toMatchObject({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      name: 'onboarding',
      version: 2,
    });
    expect(migrationRows[2]).toMatchObject({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      name: 'approval-attempts',
      version: 3,
    });
    expect(Date.parse(migrationRows[0]?.appliedAt ?? '')).not.toBeNaN();
    expect(database.pragma('user_version', { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');

    const refreshTokenColumns = database
      .prepare('PRAGMA table_info(refresh_tokens)')
      .all() as Array<{ name: string }>;
    expect(refreshTokenColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['rotation_id', 'successor_token_hash']),
    );

    expect(runMigrations(database)).toEqual({
      appliedVersions: [],
      currentVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: CURRENT_SCHEMA_VERSION });
  });

  it('uses BEGIN IMMEDIATE so only one migrator can run at a time', () => {
    const databasePath = temporaryDatabasePath();
    const first = trackDatabase(
      openDatabase(databasePath, { busyTimeoutMs: 1 }),
    );
    const second = trackDatabase(
      openDatabase(databasePath, { busyTimeoutMs: 1 }),
    );

    first.exec('BEGIN IMMEDIATE');
    try {
      expect(() => runMigrations(second)).toThrow(MigrationLockError);
    } finally {
      first.exec('ROLLBACK');
    }

    expect(runMigrations(second).currentVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a database created by a newer server', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);

    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        CURRENT_SCHEMA_VERSION + 1,
        'future',
        'f'.repeat(64),
        new Date().toISOString(),
      );
    database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);

    expect(() => runMigrations(database)).toThrow(NewerSchemaVersionError);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: CURRENT_SCHEMA_VERSION + 1 });
  });

  it('refuses an applied migration whose SQL changed after deployment', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);

    const initialMigration = DEFAULT_MIGRATIONS[0];
    if (initialMigration === undefined) {
      throw new Error('The test requires the full migration catalog.');
    }

    // Change the first migration's SQL but keep the rest of the catalog intact,
    // so verification reaches the checksum comparison for version 1.
    const changedMigrations = [
      {
        ...initialMigration,
        sql: `${initialMigration.sql}\n-- changed after it was applied`,
      },
      ...DEFAULT_MIGRATIONS.slice(1),
    ];

    expect(() => runMigrations(database, changedMigrations)).toThrow(
      MigrationChecksumError,
    );
  });

  it('rejects malformed migration catalogs before changing the database', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));

    expect(() =>
      runMigrations(database, [
        { name: 'starts-at-two', sql: 'SELECT 1;', version: 2 },
      ]),
    ).toThrow(MigrationCatalogError);
    expect(() =>
      runMigrations(database, [
        { name: 'Invalid Name', sql: 'SELECT 1;', version: 1 },
      ]),
    ).toThrow(MigrationCatalogError);
    expect(() =>
      runMigrations(database, [
        { name: 'empty', sql: '  \r\n ', version: 1 },
      ]),
    ).toThrow(MigrationCatalogError);

    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'table' AND name = 'schema_migrations'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('refuses a gap in applied migration metadata', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);
    database.prepare('DELETE FROM schema_migrations WHERE version = 1').run();

    expect(() => runMigrations(database)).toThrow(MigrationMetadataError);
  });

  it('refuses a changed migration name even when the version is unchanged', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);
    database
      .prepare('UPDATE schema_migrations SET name = ? WHERE version = 1')
      .run('renamed');

    expect(() => runMigrations(database)).toThrow(MigrationMetadataError);
  });

  it('refuses migration metadata that does not match user_version', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);
    database.pragma('user_version = 0');

    expect(() => runMigrations(database)).toThrow(MigrationMetadataError);
  });

  it('rolls back every statement and record when a migration fails', () => {
    const database = trackDatabase(openDatabase(temporaryDatabasePath()));
    runMigrations(database);

    const migrationsWithFailure = [
      ...DEFAULT_MIGRATIONS,
      {
        name: 'deliberate-failure',
        sql: `
          CREATE TABLE should_be_rolled_back (id TEXT PRIMARY KEY) STRICT;
          THIS IS NOT VALID SQL;
        `,
        version: CURRENT_SCHEMA_VERSION + 1,
      },
    ];

    expect(() => runMigrations(database, migrationsWithFailure)).toThrow();
    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'table' AND name = 'should_be_rolled_back'`,
        )
        .get(),
    ).toBeUndefined();
    expect(database.pragma('user_version', { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: CURRENT_SCHEMA_VERSION });
  });
});
