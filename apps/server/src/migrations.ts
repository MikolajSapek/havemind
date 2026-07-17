import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

export interface MigrationDefinition {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

export interface MigrationResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

interface AppliedMigrationRow {
  readonly appliedAt: string;
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
}

interface PreparedMigration extends MigrationDefinition {
  readonly checksum: string;
}

const CREATE_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    checksum TEXT NOT NULL CHECK (
      length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
    ),
    applied_at TEXT NOT NULL CHECK (length(applied_at) > 0)
  ) STRICT;
`;

const READ_APPLIED_MIGRATIONS_SQL = `
  SELECT
    version,
    name,
    checksum,
    applied_at AS appliedAt
  FROM schema_migrations
  ORDER BY version
`;

const INSERT_APPLIED_MIGRATION_SQL = `
  INSERT INTO schema_migrations (version, name, checksum, applied_at)
  VALUES (?, ?, ?, ?)
`;

export class MigrationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export class MigrationCatalogError extends MigrationError {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationCatalogError';
  }
}

export class MigrationChecksumError extends MigrationError {
  public constructor(version: number) {
    super(
      `Migration ${version} does not match the checksum recorded by this database.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

export class MigrationMetadataError extends MigrationError {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationMetadataError';
  }
}

export class MigrationLockError extends MigrationError {
  public constructor(options: ErrorOptions) {
    super('Another SQLite writer is active; migration lock was not acquired.', options);
    this.name = 'MigrationLockError';
  }
}

export class NewerSchemaVersionError extends MigrationError {
  public constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than supported version ${supportedVersion}.`,
    );
    this.name = 'NewerSchemaVersionError';
  }
}

function canonicalizeSql(sql: string): string {
  return sql.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

export function migrationChecksum(sql: string): string {
  return createHash('sha256')
    .update(canonicalizeSql(sql), 'utf8')
    .digest('hex');
}

const initialMigration: MigrationDefinition = Object.freeze({
  name: 'initial',
  sql: readFileSync(
    new URL('./migrations/001-initial.sql', import.meta.url),
    'utf8',
  ),
  version: 1,
});

const onboardingMigration: MigrationDefinition = Object.freeze({
  name: 'onboarding',
  sql: readFileSync(
    new URL('./migrations/002-onboarding.sql', import.meta.url),
    'utf8',
  ),
  version: 2,
});

const approvalAttemptsMigration: MigrationDefinition = Object.freeze({
  name: 'approval-attempts',
  sql: readFileSync(
    new URL('./migrations/003-approval-attempts.sql', import.meta.url),
    'utf8',
  ),
  version: 3,
});

export const DEFAULT_MIGRATIONS: readonly MigrationDefinition[] = Object.freeze([
  initialMigration,
  onboardingMigration,
  approvalAttemptsMigration,
]);

export const CURRENT_SCHEMA_VERSION =
  DEFAULT_MIGRATIONS[DEFAULT_MIGRATIONS.length - 1]?.version ?? 0;

function prepareMigrationCatalog(
  migrations: readonly MigrationDefinition[],
): readonly PreparedMigration[] {
  return migrations.map((migration, index) => {
    const expectedVersion = index + 1;

    if (migration.version !== expectedVersion) {
      throw new MigrationCatalogError(
        `Migration versions must be contiguous from 1; expected ${expectedVersion}, received ${migration.version}.`,
      );
    }

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.name)) {
      throw new MigrationCatalogError(
        `Migration ${migration.version} has an invalid name.`,
      );
    }

    const sql = canonicalizeSql(migration.sql);
    if (sql.trim().length === 0) {
      throw new MigrationCatalogError(
        `Migration ${migration.version} cannot contain empty SQL.`,
      );
    }

    return Object.freeze({
      checksum: migrationChecksum(sql),
      name: migration.name,
      sql,
      version: migration.version,
    });
  });
}

function getUserVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true });

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MigrationMetadataError('PRAGMA user_version is not a safe integer.');
  }

  return value;
}

function verifyAppliedMigrations(
  database: Database.Database,
  migrations: readonly PreparedMigration[],
  appliedRows: readonly AppliedMigrationRow[],
): number {
  const supportedVersion = migrations[migrations.length - 1]?.version ?? 0;
  const userVersion = getUserVersion(database);
  const recordedVersion = appliedRows[appliedRows.length - 1]?.version ?? 0;
  const databaseVersion = Math.max(userVersion, recordedVersion);

  if (databaseVersion > supportedVersion) {
    throw new NewerSchemaVersionError(databaseVersion, supportedVersion);
  }

  for (const [index, applied] of appliedRows.entries()) {
    const expectedVersion = index + 1;
    if (applied.version !== expectedVersion) {
      throw new MigrationMetadataError(
        `Applied migrations are not contiguous at version ${expectedVersion}.`,
      );
    }

    const expected = migrations[index];
    if (expected === undefined) {
      throw new NewerSchemaVersionError(applied.version, supportedVersion);
    }

    if (applied.name !== expected.name) {
      throw new MigrationMetadataError(
        `Migration ${applied.version} name does not match the recorded catalog.`,
      );
    }

    if (applied.checksum !== expected.checksum) {
      throw new MigrationChecksumError(applied.version);
    }
  }

  if (userVersion !== recordedVersion) {
    throw new MigrationMetadataError(
      `PRAGMA user_version ${userVersion} does not match recorded version ${recordedVersion}.`,
    );
  }

  return recordedVersion;
}

function isSqliteWriterContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const { code } = error as { readonly code?: unknown };
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly MigrationDefinition[] = DEFAULT_MIGRATIONS,
): MigrationResult {
  const preparedMigrations = prepareMigrationCatalog(migrations);
  const supportedVersion =
    preparedMigrations[preparedMigrations.length - 1]?.version ?? 0;

  const migrate = database.transaction((): MigrationResult => {
    database.exec(CREATE_MIGRATION_TABLE_SQL);

    const appliedRows = database
      .prepare(READ_APPLIED_MIGRATIONS_SQL)
      .all() as AppliedMigrationRow[];
    const recordedVersion = verifyAppliedMigrations(
      database,
      preparedMigrations,
      appliedRows,
    );
    const appliedVersions: number[] = [];
    const insertAppliedMigration = database.prepare(
      INSERT_APPLIED_MIGRATION_SQL,
    );

    for (const migration of preparedMigrations.slice(recordedVersion)) {
      database.exec(migration.sql);
      insertAppliedMigration.run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      database.pragma(`user_version = ${migration.version}`);
      appliedVersions.push(migration.version);
    }

    return {
      appliedVersions,
      currentVersion: supportedVersion,
    };
  });

  try {
    return migrate.immediate();
  } catch (error) {
    if (isSqliteWriterContention(error)) {
      throw new MigrationLockError({ cause: error });
    }

    throw error;
  }
}
