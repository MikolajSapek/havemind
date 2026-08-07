import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { hashBlob } from '@havemind/protocol';
import {
  openSealed,
  sealTo,
  type Sodium,
} from '@havemind/crypto';
import type Database from 'better-sqlite3';

import { DB_FILENAME, openDatabase } from './db.js';

/**
 * Encrypted checkpoints (plans/006).
 *
 * A checkpoint is a self-contained, at-rest-encrypted snapshot of one Havemind
 * deployment from which the owner can restore a clean instance WITHOUT any
 * third party. It composes only I/O + library crypto over bytes the server
 * already holds, so the server stays opaque (plans/001 §3): it computes no diff,
 * provenance or merge and never inspects payload contents.
 *
 * Trust model (plans/006 "Key management"): the server holds ONLY the
 * recipient PUBLIC key. It seals every checkpoint part with libsodium's
 * `crypto_box_seal` (anonymous public-key encryption), so it can CREATE a new
 * checkpoint but can NEVER open any — a stolen `sapserver` reveals nothing. The
 * owner's SECRET key (kept off-server in a recovery kit) is the only way to
 * restore. Losing it is unrecoverable by design (T3).
 */

const BLOBS_DIRNAME = 'blobs';
const DB_CIPHERTEXT_FILENAME = 'havemind.db.enc';
const MANIFEST_FILENAME = 'manifest.json';
const SEALED_MANIFEST_FILENAME = 'manifest.json.enc';

/** Format version of the checkpoint container/manifest (plans/006). */
export const CHECKPOINT_FORMAT_VERSION = 1 as const;

/** Identifier of the at-rest cipher suite recorded in every manifest. */
export const CHECKPOINT_CIPHER_SUITE = 'libsodium-crypto_box_seal-x25519';

export interface CheckpointBlobEntry {
  readonly hash: string;
  /** Plaintext byte length of the blob (before sealing). */
  readonly size: number;
}

export interface CheckpointManifest {
  readonly checkpointFormatVersion: typeof CHECKPOINT_FORMAT_VERSION;
  readonly createdAt: string;
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
  readonly schemaVersion: number;
  readonly maxServerSequence: number;
  readonly cipherSuite: string;
  /** SHA-256 hex of the sealed `havemind.db.enc` bytes (tamper binding). */
  readonly dbCiphertextHash: string;
  readonly blobs: readonly CheckpointBlobEntry[];
}

export type CheckpointErrorCode =
  | 'INSTANCE_STATE_MISSING'
  | 'INTEGRITY_CHECK_FAILED'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_MISMATCH'
  | 'MISSING_CHECKPOINT_ARTIFACT'
  | 'DECRYPTION_FAILED'
  | 'UNSUPPORTED_FORMAT_VERSION'
  | 'TARGET_NOT_EMPTY'
  | 'VERIFY_FAILED';

/**
 * A secret-free checkpoint error safe to log. It carries a machine-readable
 * code and NEVER embeds note contents, paths, keys or tokens (plans/006 T5).
 */
export class CheckpointError extends Error {
  public readonly code: CheckpointErrorCode;

  public constructor(
    code: CheckpointErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

/** Fault points used only by tests to prove atomic publication (plans/006 T4). */
export type CheckpointFaultPoint = 'after-temp-write' | 'before-rename';

export interface CheckpointFaultInjector {
  hit(point: CheckpointFaultPoint): void | Promise<void>;
}

const NO_FAULTS: CheckpointFaultInjector = {
  hit(): void {},
};

export interface CreateCheckpointOptions {
  readonly database: Database.Database;
  readonly dataDir: string;
  readonly checkpointsDir: string;
  readonly publicKey: Uint8Array;
  readonly sodium: Sodium;
  readonly now?: () => Date;
  readonly checkpointId?: () => string;
  readonly faults?: CheckpointFaultInjector;
}

export interface CreateCheckpointResult {
  readonly checkpointId: string;
  readonly checkpointDir: string;
  readonly manifest: CheckpointManifest;
}

export interface RestoreCheckpointOptions {
  readonly checkpointDir: string;
  readonly targetDir: string;
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
  readonly sodium: Sodium;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
  readonly integrityCheck?: (database: Database.Database) => string;
}

export interface CheckpointEpoch {
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
}

interface InstanceStateRow {
  readonly instanceId: string;
  readonly serverEpoch: string;
  readonly restoreEpoch: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobRelativePath(hash: string): string {
  return join(BLOBS_DIRNAME, hash.slice(0, 2), hash);
}

function requireInstanceState(database: Database.Database): InstanceStateRow {
  const row = database
    .prepare(
      `SELECT instance_id AS instanceId,
              server_epoch AS serverEpoch,
              restore_epoch AS restoreEpoch
       FROM instance_state
       WHERE singleton = 1`,
    )
    .get() as InstanceStateRow | undefined;
  if (row === undefined) {
    throw new CheckpointError(
      'INSTANCE_STATE_MISSING',
      'The instance has no initialized instance_state row.',
    );
  }
  return row;
}

function readMaxServerSequence(database: Database.Database): number {
  const row = database
    .prepare('SELECT MAX(server_sequence) AS maxSeq FROM revisions')
    .get() as { maxSeq: number | null };
  return row.maxSeq ?? 0;
}

function readSchemaVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : Number(value);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSealedFile(
  path: string,
  sealed: Uint8Array,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(Buffer.from(sealed));
    await handle.sync();
  } finally {
    await handle.close();
  }
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
 * Assembles a self-contained, at-rest-encrypted checkpoint under
 * `checkpointsDir`. The database image is taken with `better-sqlite3`'s
 * consistent in-process `serialize()` (never a raw copy of a live file mid-WAL,
 * plans/001 §8) and every part — the DB image, each content-addressed blob and
 * the manifest — is sealed to the recipient public key so nothing readable ever
 * lands on disk. Publication is atomic: the checkpoint is built in a dot-prefixed
 * temp directory, fsynced, then renamed into place, so a crash never leaves a
 * half-written checkpoint that looks valid (plans/006 T4).
 */
export async function createCheckpoint(
  options: CreateCheckpointOptions,
): Promise<CreateCheckpointResult> {
  const now = options.now ?? (() => new Date());
  const faults = options.faults ?? NO_FAULTS;
  const checkpointId =
    options.checkpointId?.() ?? `${now().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const state = requireInstanceState(options.database);

  await mkdir(options.checkpointsDir, { mode: 0o700, recursive: true });
  const finalDir = join(options.checkpointsDir, checkpointId);
  const tempDir = join(options.checkpointsDir, `.${checkpointId}.tmp`);
  // A leftover temp dir from a prior crashed attempt is never a valid
  // checkpoint (listCheckpoints ignores dot-prefixed dirs); clear it so this
  // attempt starts clean.
  await rm(tempDir, { force: true, recursive: true });
  await mkdir(tempDir, { mode: 0o700, recursive: true });

  // Consistent metadata-DB image (Online Backup API equivalent) sealed at rest.
  const dbImage = options.database.serialize();
  const sealedDb = sealTo(options.sodium, options.publicKey, dbImage);
  await writeSealedFile(join(tempDir, DB_CIPHERTEXT_FILENAME), sealedDb);
  const dbCiphertextHash = sha256Hex(sealedDb);

  // Seal every content-addressed blob under its plaintext hash-named path.
  const sourceBlobsDir = join(options.dataDir, BLOBS_DIRNAME);
  const blobFiles = await listFiles(sourceBlobsDir);
  const blobs: CheckpointBlobEntry[] = [];
  for (const file of blobFiles) {
    const bytes = await readFile(file);
    const hash = await hashBlob(bytes);
    // Skip anything that is not a settled, content-addressed blob (e.g. a
    // crashed writer's temp file whose name never matched its digest).
    if (!file.endsWith(hash)) {
      continue;
    }
    const destination = join(tempDir, blobRelativePath(hash));
    await mkdir(join(tempDir, BLOBS_DIRNAME, hash.slice(0, 2)), {
      mode: 0o700,
      recursive: true,
    });
    const sealedBlob = sealTo(options.sodium, options.publicKey, bytes);
    await writeSealedFile(destination, sealedBlob);
    blobs.push({ hash, size: bytes.byteLength });
  }
  blobs.sort((left, right) => (left.hash < right.hash ? -1 : 1));

  const manifest: CheckpointManifest = {
    blobs,
    checkpointFormatVersion: CHECKPOINT_FORMAT_VERSION,
    cipherSuite: CHECKPOINT_CIPHER_SUITE,
    createdAt: now().toISOString(),
    dbCiphertextHash,
    instanceId: state.instanceId,
    maxServerSequence: readMaxServerSequence(options.database),
    restoreEpoch: state.restoreEpoch,
    schemaVersion: readSchemaVersion(options.database),
    serverEpoch: state.serverEpoch,
  };

  // The plaintext manifest is advisory (retention tooling can list checkpoints
  // without the secret key). Its authenticity is anchored by a SEALED copy of
  // the exact same bytes: restore requires the two to be byte-identical, so any
  // tamper of either is caught fail-closed (plans/006 T2).
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(tempDir, MANIFEST_FILENAME), manifestBytes, {
    mode: 0o600,
  });
  const sealedManifest = sealTo(options.sodium, options.publicKey, manifestBytes);
  await writeSealedFile(join(tempDir, SEALED_MANIFEST_FILENAME), sealedManifest);

  await faults.hit('after-temp-write');
  await syncDirectory(tempDir);
  await faults.hit('before-rename');
  await rename(tempDir, finalDir);
  await syncDirectory(options.checkpointsDir);

  return { checkpointDir: finalDir, checkpointId, manifest };
}

function parseManifest(bytes: Uint8Array): CheckpointManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new CheckpointError(
      'MANIFEST_INVALID',
      'manifest.json is not valid JSON.',
      { cause: error } as ErrorOptions,
    );
  }
  if (!isManifest(parsed)) {
    throw new CheckpointError(
      'MANIFEST_INVALID',
      'manifest.json does not match the expected shape.',
    );
  }
  return parsed;
}

function isManifest(value: unknown): value is CheckpointManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.checkpointFormatVersion === CHECKPOINT_FORMAT_VERSION &&
    typeof record.instanceId === 'string' &&
    typeof record.serverEpoch === 'string' &&
    typeof record.restoreEpoch === 'number' &&
    typeof record.dbCiphertextHash === 'string' &&
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

async function readCheckpointFile(
  checkpointDir: string,
  filename: string,
): Promise<Buffer> {
  try {
    return await readFile(join(checkpointDir, filename));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CheckpointError(
        'MISSING_CHECKPOINT_ARTIFACT',
        `The checkpoint is missing ${filename}.`,
      );
    }
    throw error;
  }
}

/**
 * Validates (but does not create) the restore target: it must be either absent
 * or an existing empty directory. Restore then stages all work in a temp dir and
 * only promotes it here on full success, so a failure never leaves a partially
 * materialised target (plans/006 fail-closed, AC4).
 */
async function assertEmptyTarget(targetDir: string): Promise<void> {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new CheckpointError(
        'TARGET_NOT_EMPTY',
        'Restore requires an empty target directory.',
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

/**
 * Atomically moves the fully-verified staging directory into the target. The
 * target has already been asserted absent-or-empty, so an empty target dir is
 * removed and replaced by a rename (same filesystem), and the parent is fsynced.
 */
async function promoteStagingToTarget(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  const parent = dirname(targetDir);
  await mkdir(parent, { mode: 0o700, recursive: true });
  try {
    await rmdir(targetDir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  await rename(stagingDir, targetDir);
  await syncDirectory(parent);
}

function defaultIntegrityCheck(database: Database.Database): string {
  const value = database.pragma('integrity_check', { simple: true });
  return typeof value === 'string' ? value : String(value);
}

/**
 * Restores a checkpoint into an EMPTY, isolated target directory, verifying
 * everything fail-closed BEFORE the instance is "started" (its epoch rotated).
 *
 * Order (plans/006 restore steps 1–5): (1) open the sealed manifest with the
 * owner secret key — a tamper or the wrong key throws; (2) require the advisory
 * plaintext manifest to be byte-identical to the sealed one; (3) verify the
 * sealed DB ciphertext hash matches the manifest, decrypt it, run
 * `PRAGMA integrity_check`; (4) decrypt every blob and verify its plaintext
 * SHA-256 + size against the manifest, plus referential completeness. Only when
 * all pass is a fresh `server_epoch` minted so stale-cursor clients must
 * reconcile. Any failure leaves the epoch untouched and no data served.
 */
export async function restoreCheckpoint(
  options: RestoreCheckpointOptions,
): Promise<CheckpointEpoch> {
  const randomUuid = options.randomUuid ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const integrityCheck = options.integrityCheck ?? defaultIntegrityCheck;

  await assertEmptyTarget(options.targetDir);

  // Everything is materialised into a dot-prefixed staging directory next to the
  // target and only promoted on FULL success, so any verification failure leaves
  // the target untouched (fail-closed, plans/006 AC4: "zero materialised
  // files").
  const parent = dirname(options.targetDir);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const stagingDir = join(
    parent,
    `.${basename(options.targetDir)}.restore-${randomUUID()}.tmp`,
  );
  await rm(stagingDir, { force: true, recursive: true });
  await mkdir(stagingDir, { mode: 0o700, recursive: true });

  try {
    const epoch = await stageRestore(options, stagingDir, {
      integrityCheck,
      now,
      randomUuid,
    });
    await promoteStagingToTarget(stagingDir, options.targetDir);
    return epoch;
  } catch (error) {
    await rm(stagingDir, { force: true, recursive: true });
    throw error;
  }
}

interface StageRestoreDeps {
  readonly randomUuid: () => string;
  readonly now: () => Date;
  readonly integrityCheck: (database: Database.Database) => string;
}

/**
 * Verifies and materialises a checkpoint into `stagingDir` (never the caller's
 * target). Any thrown error leaves only the staging dir, which the caller
 * removes — the target is never touched.
 */
async function stageRestore(
  options: RestoreCheckpointOptions,
  stagingDir: string,
  deps: StageRestoreDeps,
): Promise<CheckpointEpoch> {
  // (1) Authenticated manifest: seal_open throws on tamper / wrong key.
  const sealedManifest = await readCheckpointFile(
    options.checkpointDir,
    SEALED_MANIFEST_FILENAME,
  );
  let authoritativeManifestBytes: Uint8Array;
  try {
    authoritativeManifestBytes = openSealed(
      options.sodium,
      options.publicKey,
      options.secretKey,
      sealedManifest,
    );
  } catch (error) {
    throw new CheckpointError(
      'DECRYPTION_FAILED',
      'The sealed manifest could not be authenticated (tampered or wrong key).',
      { cause: error } as ErrorOptions,
    );
  }
  const manifest = parseManifest(authoritativeManifestBytes);
  if (manifest.checkpointFormatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new CheckpointError(
      'UNSUPPORTED_FORMAT_VERSION',
      `Unsupported checkpoint format version ${String(manifest.checkpointFormatVersion)}.`,
    );
  }

  // (2) Advisory plaintext manifest must match the authenticated bytes exactly.
  const plaintextManifest = await readCheckpointFile(
    options.checkpointDir,
    MANIFEST_FILENAME,
  );
  if (!plaintextManifest.equals(Buffer.from(authoritativeManifestBytes))) {
    throw new CheckpointError(
      'MANIFEST_MISMATCH',
      'The plaintext manifest does not match the authenticated manifest.',
    );
  }

  // (3) DB: bind ciphertext hash, decrypt.
  const sealedDb = await readCheckpointFile(
    options.checkpointDir,
    DB_CIPHERTEXT_FILENAME,
  );
  if (sha256Hex(sealedDb) !== manifest.dbCiphertextHash) {
    throw new CheckpointError(
      'MANIFEST_MISMATCH',
      'The sealed database ciphertext hash does not match the manifest.',
    );
  }
  let dbImage: Uint8Array;
  try {
    dbImage = openSealed(
      options.sodium,
      options.publicKey,
      options.secretKey,
      sealedDb,
    );
  } catch (error) {
    throw new CheckpointError(
      'DECRYPTION_FAILED',
      'The sealed database could not be authenticated (tampered or wrong key).',
      { cause: error } as ErrorOptions,
    );
  }
  const databasePath = join(stagingDir, DB_FILENAME);
  await writeFile(databasePath, Buffer.from(dbImage), { mode: 0o600 });

  // (4) Blobs: decrypt + verify byte-hash and size against the manifest.
  const blobsTarget = join(stagingDir, BLOBS_DIRNAME);
  await mkdir(blobsTarget, { mode: 0o700, recursive: true });
  for (const entry of manifest.blobs) {
    const sealedBlob = await readSealedBlob(options.checkpointDir, entry.hash);
    let bytes: Uint8Array;
    try {
      bytes = openSealed(
        options.sodium,
        options.publicKey,
        options.secretKey,
        sealedBlob,
      );
    } catch (error) {
      throw new CheckpointError(
        'DECRYPTION_FAILED',
        `Sealed blob ${entry.hash} could not be authenticated (tampered or wrong key).`,
        { cause: error } as ErrorOptions,
      );
    }
    const actualHash = await hashBlob(bytes);
    if (actualHash !== entry.hash || bytes.byteLength !== entry.size) {
      throw new CheckpointError(
        'MANIFEST_MISMATCH',
        `Blob ${entry.hash} failed byte-exact verification.`,
      );
    }
    await mkdir(join(blobsTarget, entry.hash.slice(0, 2)), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(
      join(stagingDir, blobRelativePath(entry.hash)),
      Buffer.from(bytes),
      { mode: 0o600 },
    );
  }

  // (5) integrity_check + epoch rotation on the staged DB, before promotion.
  const database = openDatabase(databasePath);
  try {
    const integrity = deps.integrityCheck(database);
    if (integrity !== 'ok') {
      throw new CheckpointError(
        'INTEGRITY_CHECK_FAILED',
        `Restored database failed integrity_check: ${integrity}.`,
      );
    }
    return rotateEpoch(database, deps.randomUuid, deps.now);
  } finally {
    database.close();
  }
}

async function readSealedBlob(
  checkpointDir: string,
  hash: string,
): Promise<Buffer> {
  try {
    return await readFile(join(checkpointDir, blobRelativePath(hash)));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CheckpointError(
        'MANIFEST_MISMATCH',
        `Manifest blob ${hash} is missing from the checkpoint.`,
      );
    }
    throw error;
  }
}

function rotateEpoch(
  database: Database.Database,
  randomUuid: () => string,
  now: () => Date,
): CheckpointEpoch {
  const rotate = database.transaction((): CheckpointEpoch => {
    const current = requireInstanceState(database);
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
      throw new CheckpointError(
        'INSTANCE_STATE_MISSING',
        'Failed to rotate the instance epoch.',
      );
    }
    return { instanceId: current.instanceId, restoreEpoch, serverEpoch };
  });
  return rotate.immediate();
}

export interface CheckpointListing {
  readonly checkpointId: string;
  readonly checkpointDir: string;
  readonly createdAt: string;
}

/**
 * Lists valid checkpoints (directories carrying a plaintext manifest), newest
 * first by `createdAt`. Dot-prefixed temp directories from a crashed
 * publication are ignored, so a partial checkpoint is never listed (T4).
 */
export async function listCheckpoints(
  checkpointsDir: string,
): Promise<readonly CheckpointListing[]> {
  let entries;
  try {
    entries = await readdir(checkpointsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const listings: CheckpointListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const checkpointDir = join(checkpointsDir, entry.name);
    let manifestBytes: Buffer;
    try {
      manifestBytes = await readFile(join(checkpointDir, MANIFEST_FILENAME));
    } catch {
      continue;
    }
    try {
      const manifest = parseManifest(manifestBytes);
      listings.push({
        checkpointDir,
        checkpointId: entry.name,
        createdAt: manifest.createdAt,
      });
    } catch {
      continue;
    }
  }
  listings.sort((left, right) =>
    left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
  );
  return listings;
}

/**
 * Structural verification that needs NO secret key: manifest present and valid,
 * sealed manifest/DB/blob files present, and the sealed DB ciphertext hash
 * matches the manifest. This is what "verify before forget" checks on a newer
 * checkpoint before any older one is pruned (plans/006 retention; plan/01 rule
 * 9 — never `forget` without a prior `verify`).
 */
export async function verifyCheckpointStructure(
  checkpointDir: string,
): Promise<CheckpointManifest> {
  const manifestBytes = await readCheckpointFile(
    checkpointDir,
    MANIFEST_FILENAME,
  );
  const manifest = parseManifest(manifestBytes);
  await readCheckpointFile(checkpointDir, SEALED_MANIFEST_FILENAME);
  const sealedDb = await readCheckpointFile(
    checkpointDir,
    DB_CIPHERTEXT_FILENAME,
  );
  if (sha256Hex(sealedDb) !== manifest.dbCiphertextHash) {
    throw new CheckpointError(
      'VERIFY_FAILED',
      'The sealed database ciphertext hash does not match the manifest.',
    );
  }
  for (const entry of manifest.blobs) {
    await readSealedBlob(checkpointDir, entry.hash);
  }
  return manifest;
}

export interface PruneCheckpointsOptions {
  readonly checkpointsDir: string;
  /** Number of newest checkpoints to keep. */
  readonly keep: number;
}

export interface PruneCheckpointsResult {
  readonly kept: readonly CheckpointListing[];
  readonly removed: readonly CheckpointListing[];
}

/**
 * Keeps the `keep` newest checkpoints and removes the rest — but NEVER deletes
 * anything unless the newest retained checkpoint first passes structural
 * verification (plans/006 retention: "forget" only after a successful "verify"
 * of a newer checkpoint). If verification fails, nothing is removed.
 *
 * This is the simple keep-N retention the pilot needs; the documented 7/4/6
 * daily/weekly/monthly policy is deferred to the transport layer (Restic,
 * SRV-03/04/05) that will later wrap these already-encrypted checkpoints.
 */
export async function pruneCheckpoints(
  options: PruneCheckpointsOptions,
): Promise<PruneCheckpointsResult> {
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new CheckpointError(
      'VERIFY_FAILED',
      'pruneCheckpoints requires keep to be an integer >= 1.',
    );
  }
  const all = await listCheckpoints(options.checkpointsDir);
  if (all.length <= options.keep) {
    return { kept: all, removed: [] };
  }
  const kept = all.slice(0, options.keep);
  const removed = all.slice(options.keep);

  // Verify the newest retained checkpoint before forgetting any older one.
  const newest = kept[0];
  if (newest === undefined) {
    throw new CheckpointError('VERIFY_FAILED', 'No checkpoint to verify.');
  }
  await verifyCheckpointStructure(newest.checkpointDir);

  for (const listing of removed) {
    await rm(listing.checkpointDir, { force: true, recursive: true });
  }
  return { kept, removed };
}
