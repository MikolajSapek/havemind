import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import {
  createBackup,
  listBackups,
  pruneBackups,
  readInstanceEpoch,
  restoreInstance,
  RestoreError,
  verifyBackupStructure,
} from './backup-restore.js';
import { BlobStore } from './blob-store.js';
import { parseServerConfig } from './config.js';
import { DB_FILENAME, openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import { RevisionRepository } from './revision-repository.js';
import { SessionRepository } from './auth/session-repository.js';
import {
  createLocalOwnerSetupContext,
  OwnerSetupService,
} from './auth/setup.js';
import { generateRefreshToken } from './auth/tokens.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const START_TIME = '2026-07-16T03:00:00.000Z';
const NEW_EPOCH = '99999999-0000-4000-8000-0000000000ff';
const FILE_ID = '70000000-0000-4000-8000-0000000000f5';
const REVISION_ID = '70000000-0000-4000-8000-000000000f01';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface SeededInstance {
  readonly dataDir: string;
  readonly database: Database.Database;
  readonly blobStore: BlobStore;
  readonly revisions: RevisionRepository;
  readonly sessions: SessionRepository;
  readonly accessToken: string;
  readonly serverEpoch: string;
  readonly instanceId: string;
  readonly vaultId: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly blobHash: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function makeDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}

function openTracked(filename: string): Database.Database {
  const database = openDatabase(filename);
  databases.push(database);
  return database;
}

function buildAppFor(
  database: Database.Database,
  blobStore: BlobStore,
  revisions: RevisionRepository,
  sessions: SessionRepository,
) {
  const config = parseServerConfig(TEST_ENV);
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database,
      sessions,
      sync: { blobStore, database, revisions },
    },
    config,
  });
  applications.push(app);
  return app;
}

function pull(
  app: ReturnType<typeof buildApp>,
  token: string,
  vaultId: string,
  epoch: string | undefined,
) {
  const suffix = epoch === undefined ? '' : `?epoch=${epoch}`;
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'GET',
    url: `/vaults/${vaultId}/events${suffix}`,
  });
}

function header(
  vaultId: string,
  membershipId: string,
  deviceId: string,
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: deviceId,
    expectedMemberId: membershipId,
    fileId: FILE_ID,
    parentRevisionIds: [],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId: REVISION_ID,
    semantics: SEMANTICS,
    vaultId,
  };
}

async function seedInstance(): Promise<SeededInstance> {
  const dataDir = makeDataDir();
  const database = openTracked(join(dataDir, 'havemind.sqlite'));
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const setup = new OwnerSetupService(database, { now });
  const init = setup.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Owner',
    vaultDisplayName: 'Vault',
  });

  const deviceId = randomUUID();
  const pair = setup.pairOwnerDevice({
    deviceDisplayName: 'Owner Laptop',
    deviceId,
    initialRefreshToken: generateRefreshToken(),
    pairingToken: init.pairingToken,
    publicKey: Buffer.alloc(32, 0x11),
  });

  const vaultRow = database
    .prepare('SELECT id AS id FROM vaults LIMIT 1')
    .get() as { id: string };

  const sessions = new SessionRepository(database, { now });
  const blobStore = new BlobStore(join(dataDir, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  const app = buildAppFor(database, blobStore, revisions, sessions);
  const pushed = await app.inject({
    headers: { authorization: `Bearer ${pair.accessToken}` },
    method: 'POST',
    payload: {
      revisions: [
        {
          header: header(vaultRow.id, init.membershipId, deviceId),
          idempotencyKey: 'k1',
          payload: Buffer.from('opaque-payload', 'utf8').toString('base64'),
        },
      ],
    },
    url: `/vaults/${vaultRow.id}/revisions`,
  });
  expect(pushed.statusCode).toBe(200);
  const blobHash = (
    pushed.json() as {
      results: Array<{ receipt: { blobHash: string } }>;
    }
  ).results[0]?.receipt.blobHash as string;

  return {
    accessToken: pair.accessToken,
    blobHash,
    blobStore,
    database,
    dataDir,
    deviceId,
    instanceId: init.instanceId,
    membershipId: init.membershipId,
    revisions,
    serverEpoch: init.serverEpoch,
    sessions,
    vaultId: vaultRow.id,
  };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('readInstanceEpoch', () => {
  it('returns null for a migrated but uninitialized instance', () => {
    const dataDir = makeDataDir();
    const database = openTracked(join(dataDir, 'havemind.sqlite'));
    runMigrations(database);
    expect(readInstanceEpoch(database)).toBeNull();
  });

  it('reads the epoch of an initialized instance', async () => {
    const seed = await seedInstance();
    const epoch = readInstanceEpoch(seed.database);
    expect(epoch).toEqual({
      instanceId: seed.instanceId,
      restoreEpoch: 0,
      serverEpoch: seed.serverEpoch,
    });
  });
});

describe('createBackup', () => {
  it('produces a manifest that enumerates the stored blob', async () => {
    const seed = await seedInstance();
    const backupDir = join(makeDataDir(), 'backup');

    const manifest = await createBackup({
      backupDir,
      database: seed.database,
      dataDir: seed.dataDir,
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.instanceId).toBe(seed.instanceId);
    expect(manifest.sourceServerEpoch).toBe(seed.serverEpoch);
    expect(manifest.sourceRestoreEpoch).toBe(0);
    expect(manifest.blobs).toHaveLength(1);
    expect(manifest.blobs[0]?.hash).toBe(seed.blobHash);
    expect(manifest.database.sizeBytes).toBeGreaterThan(0);

    const persisted = JSON.parse(
      await readFile(join(backupDir, 'manifest.json'), 'utf8'),
    ) as { blobs: unknown[] };
    expect(persisted.blobs).toHaveLength(1);
  });

  it('refuses to back up an uninitialized instance', async () => {
    const dataDir = makeDataDir();
    const database = openTracked(join(dataDir, 'havemind.sqlite'));
    runMigrations(database);

    await expect(
      createBackup({
        backupDir: join(makeDataDir(), 'backup'),
        database,
        dataDir,
      }),
    ).rejects.toMatchObject({ code: 'INSTANCE_STATE_MISSING' });
  });
});

describe('restoreInstance', () => {
  async function backupOf(seed: SeededInstance): Promise<string> {
    const backupDir = join(makeDataDir(), 'backup');
    await createBackup({
      backupDir,
      database: seed.database,
      dataDir: seed.dataDir,
    });
    return backupDir;
  }

  it('writes the restored database under the same filename the live server opens', async () => {
    // Regression test: backup-restore previously hardcoded its own
    // 'havemind.sqlite' constant while index.ts/setup/cli.ts open
    // 'havemind.db'. Pointing the server at a restored data directory found
    // no 'havemind.db', silently created a fresh empty file, migrated an
    // empty schema, and served an empty instance -- apparent total data
    // loss. Asserting against the exported DB_FILENAME (rather than a
    // string literal) fails if any of the three call sites ever diverges
    // from the shared constant again.
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = join(makeDataDir(), 'restored');

    await restoreInstance({
      backupDir,
      randomUuid: () => NEW_EPOCH,
      targetDir,
    });

    // The exact filename the server's open path (index.ts) and the setup
    // CLI (setup/cli.ts) use -- opening it directly (no fallback name,
    // no glob) proves restoreInstance wrote to the filename the server will
    // actually look for.
    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(readInstanceEpoch(restoredDb)).toEqual({
      instanceId: seed.instanceId,
      restoreEpoch: 1,
      serverEpoch: NEW_EPOCH,
    });
  });

  it('verifies integrity and manifest, then bumps the epoch', async () => {
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = join(makeDataDir(), 'restored');

    const result = await restoreInstance({
      backupDir,
      randomUuid: () => NEW_EPOCH,
      targetDir,
    });

    expect(result.instanceId).toBe(seed.instanceId);
    expect(result.serverEpoch).toBe(NEW_EPOCH);
    expect(result.restoreEpoch).toBe(1);

    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(readInstanceEpoch(restoredDb)).toEqual({
      instanceId: seed.instanceId,
      restoreEpoch: 1,
      serverEpoch: NEW_EPOCH,
    });
  });

  it('forces reconciliation: a stale-epoch pull is rejected 409, a new-epoch pull succeeds', async () => {
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = join(makeDataDir(), 'restored');
    await restoreInstance({
      backupDir,
      randomUuid: () => NEW_EPOCH,
      targetDir,
    });

    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    const blobStore = new BlobStore(join(targetDir, 'blobs'));
    const now = (): Date => new Date(START_TIME);
    const sessions = new SessionRepository(restoredDb, { now });
    const revisions = new RevisionRepository(restoredDb, blobStore, { now });
    const app = buildAppFor(restoredDb, blobStore, revisions, sessions);

    const stale = await pull(app, seed.accessToken, seed.vaultId, seed.serverEpoch);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'CURSOR_INVALID' } });

    const fresh = await pull(app, seed.accessToken, seed.vaultId, NEW_EPOCH);
    expect(fresh.statusCode).toBe(200);
    const body = fresh.json() as {
      cursor: number;
      epoch: string;
      events: Array<{ revisionId: string }>;
    };
    expect(body.epoch).toBe(NEW_EPOCH);
    expect(body.cursor).toBe(1);
    expect(body.events.map((event) => event.revisionId)).toEqual([REVISION_ID]);

    // A pull that omits the epoch is still served (initial sync) and echoes it.
    const initial = await pull(app, seed.accessToken, seed.vaultId, undefined);
    expect(initial.statusCode).toBe(200);
    expect((initial.json() as { epoch: string }).epoch).toBe(NEW_EPOCH);
  });

  it('rejects a restore into a non-empty target directory', async () => {
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = makeDataDir();
    writeFileSync(join(targetDir, 'existing.txt'), 'occupied');

    await expect(
      restoreInstance({ backupDir, targetDir }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
  });

  it('fails the integrity check before starting and leaves the epoch unbumped', async () => {
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = join(makeDataDir(), 'restored');

    await expect(
      restoreInstance({
        backupDir,
        integrityCheck: () => 'malformed database',
        randomUuid: () => NEW_EPOCH,
        targetDir,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });

    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(readInstanceEpoch(restoredDb)).toEqual({
      instanceId: seed.instanceId,
      restoreEpoch: 0,
      serverEpoch: seed.serverEpoch,
    });
  });

  it('detects a tampered blob against the manifest and leaves the epoch unbumped', async () => {
    const seed = await seedInstance();
    const backupDir = await backupOf(seed);
    const targetDir = join(makeDataDir(), 'restored');

    const tamperedPath = join(
      backupDir,
      'blobs',
      seed.blobHash.slice(0, 2),
      seed.blobHash,
    );
    await writeFile(tamperedPath, 'corrupted-bytes');

    await expect(
      restoreInstance({
        backupDir,
        randomUuid: () => NEW_EPOCH,
        targetDir,
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });

    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(readInstanceEpoch(restoredDb)?.restoreEpoch).toBe(0);
  });

  it('rejects a backup directory without a manifest', async () => {
    const emptyBackup = makeDataDir();
    await expect(
      restoreInstance({
        backupDir: emptyBackup,
        targetDir: join(makeDataDir(), 'restored'),
      }),
    ).rejects.toBeInstanceOf(RestoreError);
  });
});

describe('backup retention', () => {
  async function writeBackup(
    seed: SeededInstance,
    root: string,
    backupId: string,
    createdAt: string,
  ): Promise<string> {
    const backupDir = join(root, backupId);
    await createBackup({
      backupDir,
      database: seed.database,
      dataDir: seed.dataDir,
      now: () => new Date(createdAt),
    });
    return backupDir;
  }

  /** Reads an artifact's manifest as raw JSON so a test can age or tamper it. */
  async function readManifestJson(
    backupDir: string,
  ): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(join(backupDir, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
  }

  async function writeManifestJson(
    backupDir: string,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    await writeFile(
      join(backupDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  /**
   * Rewrites the artifact's database snapshot so it keeps a valid SQLite header
   * and the EXACT byte length the manifest recorded, while every page after the
   * header is garbage. The old structural check — "the file exists and is
   * non-empty" — passes on this file; `PRAGMA integrity_check` does not.
   */
  async function corruptDatabaseAfterHeader(backupDir: string): Promise<void> {
    const path = join(backupDir, DB_FILENAME);
    const bytes = await readFile(path);
    expect(bytes.byteLength).toBeGreaterThan(100);
    const corrupted = Buffer.from(bytes);
    corrupted.fill(0xff, 100);
    await writeFile(path, corrupted);
    expect((await readFile(path)).byteLength).toBe(bytes.byteLength);
  }

  /**
   * Same size, valid header AND valid page 1 — only interior pages are garbage.
   * This is the variant where `PRAGMA integrity_check` returns a non-`ok`
   * report instead of throwing, so it pins the "result is not exactly ok" arm.
   */
  async function corruptDatabaseInteriorPages(
    backupDir: string,
  ): Promise<void> {
    const path = join(backupDir, DB_FILENAME);
    const bytes = await readFile(path);
    const declared = bytes.readUInt16BE(16);
    const pageSize = declared === 1 ? 65_536 : declared;
    expect(bytes.byteLength).toBeGreaterThan(pageSize * 4);
    const corrupted = Buffer.from(bytes);
    corrupted.fill(0x5a, pageSize * 2, pageSize * 4);
    await writeFile(path, corrupted);
  }

  it('lists artifacts newest first and ignores dot-prefixed temp dirs', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'older', '2026-08-01T03:00:00.000Z');
    await writeBackup(seed, root, 'newer', '2026-08-05T03:00:00.000Z');
    // A crashed publication leaves a dot-prefixed temp dir; it is never a backup.
    await writeBackup(seed, root, '.crashed.tmp', '2026-08-09T03:00:00.000Z');

    const listed = await listBackups(root);
    expect(listed.map((entry) => entry.backupId)).toEqual(['newer', 'older']);
    expect(listed[0]?.createdAt).toBe('2026-08-05T03:00:00.000Z');
  });

  it('returns no listings for a directory that does not exist', async () => {
    expect(await listBackups(join(makeDataDir(), 'absent'))).toEqual([]);
  });

  it('verifies a freshly written artifact structurally', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );

    const manifest = await verifyBackupStructure(backupDir);
    expect(manifest.instanceId).toBe(seed.instanceId);
    expect(manifest.blobs).toHaveLength(1);
  });

  it('fails verification when a blob was tampered with', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    await writeFile(
      join(backupDir, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
      'corrupted-bytes',
    );

    await expect(verifyBackupStructure(backupDir)).rejects.toMatchObject({
      code: 'MANIFEST_MISMATCH',
    });
  });

  it('fails verification for a corrupt-but-non-empty database snapshot', async () => {
    // Regression test (audit #3, finding 3): verification used to be satisfied
    // by "the snapshot file exists and is non-empty". A snapshot whose pages
    // are garbage is neither empty nor restorable, and passing it let retention
    // delete older GOOD artifacts. The file below keeps a valid SQLite header
    // and the exact byte length the manifest recorded, so ONLY an
    // integrity_check can tell it apart from a good snapshot.
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    await corruptDatabaseAfterHeader(backupDir);

    await expect(verifyBackupStructure(backupDir)).rejects.toMatchObject({
      code: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('fails verification when integrity_check reports corrupt interior pages', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    await corruptDatabaseInteriorPages(backupDir);

    await expect(verifyBackupStructure(backupDir)).rejects.toMatchObject({
      code: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('leaves the artifact directory unchanged after a successful verification', async () => {
    // The integrity check opens the snapshot read-only; SQLite would otherwise
    // leave -wal/-shm sidecars behind inside a published artifact.
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    const before = (await readdir(backupDir)).sort();

    await verifyBackupStructure(backupDir);

    expect((await readdir(backupDir)).sort()).toEqual(before);
    expect(before).toEqual(['blobs', DB_FILENAME, 'manifest.json'].sort());
  });

  it('fails verification when the snapshot size disagrees with the manifest', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    const path = join(backupDir, DB_FILENAME);
    const full = (await readFile(path)).byteLength;
    await truncate(path, full - 512);

    await expect(verifyBackupStructure(backupDir)).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
    });
  });

  it('skips the size check for an older artifact whose manifest omits it', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    const manifest = await readManifestJson(backupDir);
    manifest.database = { filename: DB_FILENAME };
    await writeManifestJson(backupDir, manifest);

    await expect(verifyBackupStructure(backupDir)).resolves.toMatchObject({
      instanceId: seed.instanceId,
    });
  });

  it('fails verification when the database snapshot is missing', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    const backupDir = await writeBackup(
      seed,
      root,
      'one',
      '2026-08-01T03:00:00.000Z',
    );
    rmSync(join(backupDir, DB_FILENAME));

    await expect(verifyBackupStructure(backupDir)).rejects.toMatchObject({
      code: 'MISSING_BACKUP_ARTIFACT',
    });
  });

  it('keeps the newest N artifacts and removes the rest', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');
    await writeBackup(seed, root, 'b', '2026-08-02T03:00:00.000Z');
    await writeBackup(seed, root, 'c', '2026-08-03T03:00:00.000Z');

    const pruned = await pruneBackups({ backupsRoot: root, keep: 2 });
    expect(pruned.kept.map((entry) => entry.backupId)).toEqual(['c', 'b']);
    expect(pruned.removed.map((entry) => entry.backupId)).toEqual(['a']);
    expect((await listBackups(root)).map((entry) => entry.backupId)).toEqual([
      'c',
      'b',
    ]);
  });

  it('removes nothing when the newest retained artifact fails verification', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');
    const newest = await writeBackup(
      seed,
      root,
      'b',
      '2026-08-02T03:00:00.000Z',
    );
    await writeFile(
      join(newest, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
      'corrupted-bytes',
    );

    await expect(
      pruneBackups({ backupsRoot: root, keep: 1 }),
    ).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    expect((await listBackups(root)).map((entry) => entry.backupId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('removes nothing when the newest retained artifact has a corrupt database', async () => {
    // Audit #3, finding 3: the corrupt snapshot is non-empty and the manifest's
    // blobs are all byte-exact, so the old gate waved it through and the last
    // GOOD artifact ('a') was deleted. Retention must refuse instead.
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');
    const newest = await writeBackup(
      seed,
      root,
      'b',
      '2026-08-02T03:00:00.000Z',
    );
    await corruptDatabaseAfterHeader(newest);

    await expect(
      pruneBackups({ backupsRoot: root, keep: 1 }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    expect((await listBackups(root)).map((entry) => entry.backupId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('removes nothing when an older RETAINED artifact fails verification', async () => {
    // keep: 2 over three artifacts means the retained set is [c, b]. 'b' is
    // corrupt, so deleting 'a' would shrink the good set to one. Deleting only
    // ever happens from a fully verified retained set.
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');
    const middle = await writeBackup(
      seed,
      root,
      'b',
      '2026-08-02T03:00:00.000Z',
    );
    await writeBackup(seed, root, 'c', '2026-08-03T03:00:00.000Z');
    await corruptDatabaseAfterHeader(middle);

    await expect(
      pruneBackups({ backupsRoot: root, keep: 2 }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    expect((await listBackups(root)).map((entry) => entry.backupId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('removes nothing when a retained artifact has a tampered blob', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');
    const middle = await writeBackup(
      seed,
      root,
      'b',
      '2026-08-02T03:00:00.000Z',
    );
    await writeBackup(seed, root, 'c', '2026-08-03T03:00:00.000Z');
    await writeFile(
      join(middle, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
      'corrupted-bytes',
    );

    await expect(
      pruneBackups({ backupsRoot: root, keep: 2 }),
    ).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    expect((await listBackups(root)).map((entry) => entry.backupId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('keeps everything when there are no more artifacts than keep', async () => {
    const seed = await seedInstance();
    const root = join(makeDataDir(), 'backups');
    await writeBackup(seed, root, 'a', '2026-08-01T03:00:00.000Z');

    const pruned = await pruneBackups({ backupsRoot: root, keep: 3 });
    expect(pruned.removed).toEqual([]);
    expect(pruned.kept).toHaveLength(1);
  });

  it('rejects a keep value below one', async () => {
    await expect(
      pruneBackups({ backupsRoot: makeDataDir(), keep: 0 }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });
});
