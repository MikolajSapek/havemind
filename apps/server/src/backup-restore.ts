import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { hashBlob } from '@havemind/protocol';
import Database from 'better-sqlite3';

import { DB_FILENAME, openDatabase } from './db.js';

const BLOBS_DIRNAME = 'blobs';
const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * Files SQLite creates beside a WAL-mode database when it opens one. A published
 * artifact holds none of them (`Database.backup` writes a single consolidated
 * file), so verification deletes any it caused to appear.
 */
const SQLITE_SIDE_FILE_SUFFIXES = ['-wal', '-shm'] as const;

/** Keeps an integrity_check report short and single-line for logs. */
const MAX_INTEGRITY_REPORT_CHARS = 200;

export interface BlobManifestEntry {
  readonly hash: string;
  readonly size: number;
}

export interface DatabaseManifestEntry {
  readonly filename: string;
  /**
   * Byte length of the snapshot at creation time. Optional on READ only: an
   * artifact written before the field was verified has no size to compare
   * against, and refusing it would turn an old-but-good backup into a failure.
   * `createBackup` always records it.
   */
  readonly sizeBytes?: number;
}

export interface BackupManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly sourceServerEpoch: string;
  readonly sourceRestoreEpoch: number;
  readonly createdAt: string;
  readonly database: DatabaseManifestEntry;
  readonly blobs: readonly BlobManifestEntry[];
}

export interface InstanceEpoch {
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
}

export type RestoreErrorCode =
  | 'BACKUP_ID_INVALID'
  | 'INSTANCE_STATE_MISSING'
  | 'INTEGRITY_CHECK_FAILED'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_MISMATCH'
  | 'MISSING_BACKUP_ARTIFACT'
  | 'TARGET_NOT_EMPTY'
  | 'VERIFY_FAILED';

/** A secret-free restore error safe to log; carries a machine-readable code. */
export class RestoreError extends Error {
  public readonly code: RestoreErrorCode;

  public constructor(
    code: RestoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RestoreError';
    this.code = code;
  }
}

export interface CreateBackupOptions {
  readonly database: Database.Database;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly now?: () => Date;
}

export interface RestoreInstanceOptions {
  readonly backupDir: string;
  readonly targetDir: string;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
  readonly integrityCheck?: (database: Database.Database) => string;
}

interface InstanceStateRow {
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Reads the singleton instance identity/epoch. Returns null when the instance
 * has migrated its schema but has not yet been initialized by owner setup.
 */
export function readInstanceEpoch(
  database: Database.Database,
): InstanceEpoch | null {
  const row = database
    .prepare(
      `SELECT
         instance_id AS instanceId,
         server_epoch AS serverEpoch,
         restore_epoch AS restoreEpoch
       FROM instance_state
       WHERE singleton = 1`,
    )
    .get() as InstanceStateRow | undefined;

  if (row === undefined) {
    return null;
  }

  return {
    instanceId: row.instanceId,
    restoreEpoch: row.restoreEpoch,
    serverEpoch: row.serverEpoch,
  };
}

function requireInstanceEpoch(database: Database.Database): InstanceEpoch {
  const epoch = readInstanceEpoch(database);
  if (epoch === null) {
    throw new RestoreError(
      'INSTANCE_STATE_MISSING',
      'The instance has no initialized instance_state row.',
    );
  }
  return epoch;
}

function blobRelativePath(hash: string): string {
  return join(BLOBS_DIRNAME, hash.slice(0, 2), hash);
}

/** Recursively lists every regular file under `directory` (absolute paths). */
async function listFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * Snapshots the SQLite database and every content-addressed blob into
 * `backupDir`, writing a manifest that pins each blob's hash and size. The
 * manifest is what a later restore verifies before it starts serving.
 */
export async function createBackup(
  options: CreateBackupOptions,
): Promise<BackupManifest> {
  const now = options.now ?? (() => new Date());
  const epoch = requireInstanceEpoch(options.database);

  await mkdir(options.backupDir, { mode: 0o700, recursive: true });

  const databaseTarget = join(options.backupDir, DB_FILENAME);
  await options.database.backup(databaseTarget);
  const databaseStat = await stat(databaseTarget);

  const sourceBlobsDir = join(options.dataDir, BLOBS_DIRNAME);
  const blobFiles = await listFiles(sourceBlobsDir);
  const blobs: BlobManifestEntry[] = [];
  for (const file of blobFiles) {
    const bytes = await readFile(file);
    const hash = await hashBlob(bytes);
    // Skip anything that is not a settled, content-addressed blob (e.g. a
    // crashed writer's temp file whose name never matched its digest).
    if (!file.endsWith(hash)) {
      continue;
    }
    const destination = join(options.backupDir, blobRelativePath(hash));
    await mkdir(join(options.backupDir, BLOBS_DIRNAME, hash.slice(0, 2)), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(destination, bytes, { mode: 0o600 });
    blobs.push({ hash, size: bytes.byteLength });
  }

  blobs.sort((left, right) => (left.hash < right.hash ? -1 : 1));

  const manifest: BackupManifest = {
    blobs,
    createdAt: now().toISOString(),
    database: { filename: DB_FILENAME, sizeBytes: databaseStat.size },
    instanceId: epoch.instanceId,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceRestoreEpoch: epoch.restoreEpoch,
    sourceServerEpoch: epoch.serverEpoch,
  };

  await writeFile(
    join(options.backupDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  return manifest;
}

async function assertEmptyTarget(targetDir: string): Promise<void> {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new RestoreError(
        'TARGET_NOT_EMPTY',
        'Restore requires an empty target directory.',
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await mkdir(targetDir, { mode: 0o700, recursive: true });
      return;
    }
    throw error;
  }
}

async function readManifest(backupDir: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(join(backupDir, MANIFEST_FILENAME), 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RestoreError(
        'MISSING_BACKUP_ARTIFACT',
        'The backup directory has no manifest.json.',
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RestoreError('MANIFEST_INVALID', 'manifest.json is not valid JSON.', {
      cause: error,
    } as ErrorOptions);
  }

  if (!isManifest(parsed)) {
    throw new RestoreError(
      'MANIFEST_INVALID',
      'manifest.json does not match the expected shape.',
    );
  }
  return parsed;
}

function isDatabaseManifestEntry(
  value: unknown,
): value is DatabaseManifestEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.filename === 'string' &&
    (record.sizeBytes === undefined || typeof record.sizeBytes === 'number')
  );
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    isDatabaseManifestEntry(record.database) &&
    typeof record.instanceId === 'string' &&
    typeof record.sourceServerEpoch === 'string' &&
    typeof record.sourceRestoreEpoch === 'number' &&
    Array.isArray(record.blobs) &&
    record.blobs.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).hash === 'string' &&
        typeof (entry as Record<string, unknown>).size === 'number',
    )
  );
}

async function copyBackupArtifacts(
  backupDir: string,
  targetDir: string,
): Promise<void> {
  const databaseSource = join(backupDir, DB_FILENAME);
  try {
    await cp(databaseSource, join(targetDir, DB_FILENAME));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RestoreError(
        'MISSING_BACKUP_ARTIFACT',
        'The backup directory has no database snapshot.',
      );
    }
    throw error;
  }

  const blobsSource = join(backupDir, BLOBS_DIRNAME);
  const blobsTarget = join(targetDir, BLOBS_DIRNAME);
  try {
    await cp(blobsSource, blobsTarget, { recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      // A backup with zero blobs has no blobs directory; create an empty one.
      await mkdir(blobsTarget, { mode: 0o700, recursive: true });
      return;
    }
    throw error;
  }
}

function defaultIntegrityCheck(database: Database.Database): string {
  const value = database.pragma('integrity_check', { simple: true });
  return typeof value === 'string' ? value : String(value);
}

async function verifyManifestBlobs(
  targetDir: string,
  manifest: BackupManifest,
): Promise<void> {
  for (const entry of manifest.blobs) {
    const path = join(targetDir, blobRelativePath(entry.hash));
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new RestoreError(
          'MANIFEST_MISMATCH',
          `Manifest blob ${entry.hash} is missing from the restore.`,
        );
      }
      throw error;
    }

    const actualHash = await hashBlob(bytes);
    if (actualHash !== entry.hash || bytes.byteLength !== entry.size) {
      throw new RestoreError(
        'MANIFEST_MISMATCH',
        `Manifest blob ${entry.hash} failed byte-exact verification.`,
      );
    }
  }
}

/**
 * Restores a backup into an empty target directory. Before the instance is
 * "started" (its epoch rotated), it runs `PRAGMA integrity_check` on the
 * restored database and verifies every manifest blob byte-for-byte. Only when
 * both pass is a fresh server epoch minted and the restore epoch incremented,
 * so any client holding a cursor from the previous epoch is forced to
 * reconcile instead of silently continuing.
 */
export async function restoreInstance(
  options: RestoreInstanceOptions,
): Promise<InstanceEpoch> {
  const randomUuid = options.randomUuid ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const integrityCheck = options.integrityCheck ?? defaultIntegrityCheck;

  await assertEmptyTarget(options.targetDir);
  const manifest = await readManifest(options.backupDir);
  await copyBackupArtifacts(options.backupDir, options.targetDir);

  const database = openDatabase(join(options.targetDir, DB_FILENAME));
  try {
    const integrity = integrityCheck(database);
    if (integrity !== 'ok') {
      throw new RestoreError(
        'INTEGRITY_CHECK_FAILED',
        `Restored database failed integrity_check: ${integrity}.`,
      );
    }

    await verifyManifestBlobs(options.targetDir, manifest);

    // Both gates passed, start the instance by rotating its epoch.
    return rotateEpoch(database, randomUuid, now);
  } finally {
    database.close();
  }
}

export interface BackupListing {
  readonly backupId: string;
  readonly backupDir: string;
  readonly createdAt: string;
}

/**
 * Lists publishable backup artifacts under `backupsRoot`, newest first by the
 * manifest's `createdAt`. Dot-prefixed directories are ignored: that is how a
 * crashed publication names its staging directory, so a half-written artifact
 * is never listed, never restored from, and never counted by retention.
 */
export async function listBackups(
  backupsRoot: string,
): Promise<readonly BackupListing[]> {
  let entries;
  try {
    entries = await readdir(backupsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const listings: BackupListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const backupDir = join(backupsRoot, entry.name);
    let manifest: BackupManifest;
    try {
      manifest = await readManifest(backupDir);
    } catch {
      continue;
    }
    listings.push({
      backupDir,
      backupId: entry.name,
      createdAt: manifest.createdAt,
    });
  }

  listings.sort((left, right) =>
    left.createdAt < right.createdAt
      ? 1
      : left.createdAt > right.createdAt
        ? -1
        : 0,
  );
  return listings;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Collapses a multi-line integrity_check report into one short log line. */
function summarizeIntegrityReport(report: string): string {
  const collapsed = report.replace(/\s+/gu, ' ').trim();
  return collapsed.length > MAX_INTEGRITY_REPORT_CHARS
    ? `${collapsed.slice(0, MAX_INTEGRITY_REPORT_CHARS)} [truncated]`
    : collapsed;
}

function readIntegrityReport(databasePath: string): string {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const value = database.pragma('integrity_check', { simple: true });
    return typeof value === 'string' ? value : String(value);
  } finally {
    database.close();
  }
}

/**
 * Opens the artifact's snapshot READ-ONLY and requires `PRAGMA integrity_check`
 * to answer exactly `ok`. A snapshot whose pages are garbage is neither empty
 * nor restorable, so "the file exists and is non-empty" is not evidence of a
 * usable backup, this is the check that makes retention's "verify before
 * forget" mean something.
 *
 * SQLite refuses to answer at all for some corruptions (it throws
 * SQLITE_CORRUPT/SQLITE_NOTADB instead); both arms are the same verification
 * failure and no raw driver error escapes. Reading a WAL-mode database makes
 * SQLite create -wal/-shm files beside it, so any side file this check caused is
 * removed again, a verified artifact stays byte-identical to the published one.
 */
async function verifyDatabaseIntegrity(databasePath: string): Promise<void> {
  const preexisting = new Set<string>();
  for (const suffix of SQLITE_SIDE_FILE_SUFFIXES) {
    if (await pathExists(`${databasePath}${suffix}`)) {
      preexisting.add(suffix);
    }
  }

  let report: string;
  try {
    report = readIntegrityReport(databasePath);
  } catch (error) {
    throw new RestoreError(
      'INTEGRITY_CHECK_FAILED',
      'The backup database snapshot could not be read for integrity_check.',
      { cause: error } as ErrorOptions,
    );
  } finally {
    for (const suffix of SQLITE_SIDE_FILE_SUFFIXES) {
      if (preexisting.has(suffix)) {
        continue;
      }
      try {
        await rm(`${databasePath}${suffix}`, { force: true });
      } catch {
        // A stray side file is harmless; never fail a verification over it.
      }
    }
  }

  if (report !== 'ok') {
    throw new RestoreError(
      'INTEGRITY_CHECK_FAILED',
      `The backup database snapshot failed integrity_check: ${summarizeIntegrityReport(
        report,
      )}.`,
    );
  }
}

/**
 * Verifies one artifact WITHOUT restoring it: the manifest parses, the database
 * snapshot exists, is non-empty, matches the size the manifest recorded and
 * passes `PRAGMA integrity_check`, and every manifest blob is present and
 * byte-exact. This is the "verify before forget" gate retention runs against
 * every artifact it is about to retain, and the same check the restore drill
 * runs on what it pulled back from the off-box repository.
 */
export async function verifyBackupStructure(
  backupDir: string,
): Promise<BackupManifest> {
  const manifest = await readManifest(backupDir);
  const databasePath = join(backupDir, DB_FILENAME);

  let databaseStat;
  try {
    databaseStat = await stat(databasePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RestoreError(
        'MISSING_BACKUP_ARTIFACT',
        'The backup directory has no database snapshot.',
      );
    }
    throw error;
  }
  if (databaseStat.size === 0) {
    throw new RestoreError(
      'VERIFY_FAILED',
      'The backup database snapshot is empty.',
    );
  }

  const declaredSize = manifest.database.sizeBytes;
  if (declaredSize !== undefined && declaredSize !== databaseStat.size) {
    throw new RestoreError(
      'VERIFY_FAILED',
      `The backup database snapshot is ${String(
        databaseStat.size,
      )} bytes; the manifest declares ${String(declaredSize)}.`,
    );
  }

  await verifyDatabaseIntegrity(databasePath);
  await verifyManifestBlobs(backupDir, manifest);
  return manifest;
}

export interface PruneBackupsOptions {
  readonly backupsRoot: string;
  /** Number of newest artifacts to keep. */
  readonly keep: number;
}

export interface PruneBackupsResult {
  readonly kept: readonly BackupListing[];
  readonly removed: readonly BackupListing[];
}

/**
 * Keeps the `keep` newest artifacts and removes the rest, but NEVER deletes
 * anything unless EVERY artifact it is about to retain first passes
 * `verifyBackupStructure`, integrity_check included (plan/01 rule 9: no "forget"
 * without a prior successful "verify"). If any retained artifact fails, the
 * error propagates and nothing is removed, so deleting only ever happens from a
 * fully verified retained set: neither a corrupt newest backup nor a corrupt
 * older-but-retained one can eat the last good artifact.
 *
 * Cost: one integrity_check plus one blob re-hash per retained artifact per
 * cycle. That is the price of never trading a good backup for a bad one.
 */
export async function pruneBackups(
  options: PruneBackupsOptions,
): Promise<PruneBackupsResult> {
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new RestoreError(
      'VERIFY_FAILED',
      'pruneBackups requires keep to be an integer >= 1.',
    );
  }

  const all = await listBackups(options.backupsRoot);
  if (all.length <= options.keep) {
    return { kept: all, removed: [] };
  }
  const kept = all.slice(0, options.keep);
  const removed = all.slice(options.keep);

  if (kept.length === 0) {
    throw new RestoreError('VERIFY_FAILED', 'No backup artifact to verify.');
  }
  for (const listing of kept) {
    await verifyBackupStructure(listing.backupDir);
  }

  for (const listing of removed) {
    await rm(listing.backupDir, { force: true, recursive: true });
  }
  return { kept, removed };
}

function rotateEpoch(
  database: Database.Database,
  randomUuid: () => string,
  now: () => Date,
): InstanceEpoch {
  const rotate = database.transaction((): InstanceEpoch => {
    const current = requireInstanceEpoch(database);
    const serverEpoch = randomUuid();
    const restoreEpoch = current.restoreEpoch + 1;
    const changed = database
      .prepare(
        `UPDATE instance_state
         SET server_epoch = ?, restore_epoch = ?, initialized_at = ?
         WHERE singleton = 1`,
      )
      .run(serverEpoch, restoreEpoch, now().toISOString());
    if (changed.changes !== 1) {
      throw new RestoreError(
        'INSTANCE_STATE_MISSING',
        'Failed to rotate the instance epoch.',
      );
    }
    return { instanceId: current.instanceId, restoreEpoch, serverEpoch };
  });
  return rotate.immediate();
}
