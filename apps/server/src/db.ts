import Database from 'better-sqlite3';

// Single source of truth for the on-disk database filename. The setup CLI
// creates the file under this name, the live server opens it under this
// name, and backup/restore must round-trip it under this same name — a
// mismatch here means `restoreInstance` silently writes to a filename the
// server never opens, so a restore looks successful while the server starts
// an empty database from scratch (apparent total data loss).
export const DB_FILENAME = 'havemind.db';

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const MIN_BUSY_TIMEOUT_MS = 1;
export const MAX_BUSY_TIMEOUT_MS = 30_000;

export interface OpenDatabaseOptions {
  readonly busyTimeoutMs?: number;
}

export class DatabaseConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseConfigurationError';
  }
}

function assertFileBackedDatabase(filename: string): void {
  if (filename.trim().length === 0) {
    throw new DatabaseConfigurationError('Database filename cannot be empty.');
  }

  if (filename === ':memory:' || filename.startsWith('file::memory:')) {
    throw new DatabaseConfigurationError(
      'Havemind requires a file-backed SQLite database so WAL durability is available.',
    );
  }
}

function validateBusyTimeout(busyTimeoutMs: number): number {
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < MIN_BUSY_TIMEOUT_MS ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new DatabaseConfigurationError(
      `busyTimeoutMs must be an integer between ${MIN_BUSY_TIMEOUT_MS} and ${MAX_BUSY_TIMEOUT_MS}.`,
    );
  }

  return busyTimeoutMs;
}

function requirePragmaValue(
  actual: unknown,
  expected: number | string,
  pragmaName: string,
): void {
  if (actual !== expected) {
    throw new DatabaseConfigurationError(
      `SQLite refused required PRAGMA ${pragmaName}; expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

export function configureDatabase(
  database: Database.Database,
  options: OpenDatabaseOptions = {},
): void {
  const busyTimeoutMs = validateBusyTimeout(
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  );

  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);

  requirePragmaValue(
    database.pragma('journal_mode', { simple: true }),
    'wal',
    'journal_mode',
  );
  requirePragmaValue(
    database.pragma('synchronous', { simple: true }),
    2,
    'synchronous',
  );
  requirePragmaValue(
    database.pragma('foreign_keys', { simple: true }),
    1,
    'foreign_keys',
  );
  requirePragmaValue(
    database.pragma('busy_timeout', { simple: true }),
    busyTimeoutMs,
    'busy_timeout',
  );
}

export function openDatabase(
  filename: string,
  options: OpenDatabaseOptions = {},
): Database.Database {
  assertFileBackedDatabase(filename);
  const database = new Database(filename);

  try {
    configureDatabase(database, options);
    return database;
  } catch (error) {
    database.close();

    if (error instanceof DatabaseConfigurationError) {
      throw error;
    }

    throw new DatabaseConfigurationError(
      'Failed to configure the SQLite database safely.',
      { cause: error },
    );
  }
}
