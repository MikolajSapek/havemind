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
import type Database from 'better-sqlite3';

import { DB_FILENAME, openDatabase } from './db.js';

const BLOBS_DIRNAME = 'blobs';
const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface BlobManifestEntry {
  readonly hash: string;
  readonly size: number;
}

export interface BackupManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly sourceServerEpoch: string;
  readonly sourceRestoreEpoch: number;
  readonly createdAt: string;
  readonly database: { readonly filename: string; readonly sizeBytes: number };
  readonly blobs: readonly BlobManifestEntry[];
}

export interface InstanceEpoch {
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
}

export type RestoreErrorCode =
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

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === MANIFEST_SCHEMA_VERSION &&
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
 * both pass is a fresh server epoch minted and the restore epoch incremented —
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

    // Both gates passed — start the instance by rotating its epoch.
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

/**
 * Verifies one artifact WITHOUT restoring it: the manifest parses, the database
 * snapshot exists and is non-empty, and every manifest blob is present and
 * byte-exact. This is the "verify before forget" gate retention runs against the
 * newest retained artifact, and the same check the restore drill runs on what it
 * pulled back from the off-box repository.
 */
export async function verifyBackupStructure(
  backupDir: string,
): Promise<BackupManifest> {
  const manifest = await readManifest(backupDir);

  let databaseStat;
  try {
    databaseStat = await stat(join(backupDir, DB_FILENAME));
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
 * Keeps the `keep` newest artifacts and removes the rest — but NEVER deletes
 * anything unless the newest retained artifact first passes
 * `verifyBackupStructure` (plan/01 rule 9: no "forget" without a prior
 * successful "verify"). If verification fails the error propagates and nothing
 * is removed, so a corrupt latest backup can never eat the last good one.
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

  const newest = kept[0];
  if (newest === undefined) {
    throw new RestoreError('VERIFY_FAILED', 'No backup artifact to verify.');
  }
  await verifyBackupStructure(newest.backupDir);

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
