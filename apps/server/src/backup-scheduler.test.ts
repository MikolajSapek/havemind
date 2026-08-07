import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashBlob } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runScheduledBackup,
  startBackupScheduler,
  type BackupTimer,
} from './backup-scheduler.js';
import { listBackups, verifyBackupStructure } from './backup-restore.js';
import {
  DEFAULT_BACKUP_INTERVAL_HOURS,
  DEFAULT_BACKUP_KEEP,
  parseScheduledBackupConfig,
} from './config.js';
import { DB_FILENAME, openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import {
  createLocalOwnerSetupContext,
  OwnerSetupService,
} from './auth/setup.js';

const START_TIME = '2026-08-07T03:00:00.000Z';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function makeDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-bsched-'));
  temporaryDirectories.push(directory);
  return directory;
}

function openTracked(filename: string): Database.Database {
  const database = openDatabase(filename);
  databases.push(database);
  return database;
}

interface SeededInstance {
  readonly dataDir: string;
  readonly database: Database.Database;
  readonly blobHash: string;
  readonly instanceId: string;
  readonly serverEpoch: string;
}

/**
 * Minimal initialised instance: a migrated database with an `instance_state`
 * row plus one settled, content-addressed blob on disk. That is exactly the
 * surface `createBackup` snapshots, so the scheduler can be exercised without
 * standing up the HTTP app.
 */
async function seedInstance(): Promise<SeededInstance> {
  const dataDir = makeDir();
  const database = openTracked(join(dataDir, DB_FILENAME));
  runMigrations(database);
  const setup = new OwnerSetupService(database, {
    now: () => new Date(START_TIME),
  });
  const init = setup.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Owner',
    vaultDisplayName: 'Vault',
  });

  const bytes = Buffer.from('opaque-blob-bytes', 'utf8');
  const blobHash = await hashBlob(bytes);
  const shard = join(dataDir, 'blobs', blobHash.slice(0, 2));
  await mkdir(shard, { recursive: true });
  await writeFile(join(shard, blobHash), bytes);

  return {
    blobHash,
    database,
    dataDir,
    instanceId: init.instanceId,
    serverEpoch: init.serverEpoch,
  };
}

interface CapturedTimer {
  readonly timer: BackupTimer;
  readonly state: {
    intervalMs: number | null;
    handler: (() => Promise<void>) | null;
    cleared: number;
  };
}

/** A hand-rolled timer seam: the test drives every tick explicitly. */
function captureTimer(): CapturedTimer {
  const state: CapturedTimer['state'] = {
    cleared: 0,
    handler: null,
    intervalMs: null,
  };
  const timer: BackupTimer = {
    clear: () => {
      state.cleared += 1;
    },
    set: (handler, intervalMs) => {
      state.handler = handler;
      state.intervalMs = intervalMs;
      return 'test-handle';
    },
  };
  return { state, timer };
}

afterEach(() => {
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

describe('runScheduledBackup', () => {
  it('publishes one verifiable artifact and leaves no temp directory behind', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');

    const result = await runScheduledBackup({
      backupsRoot,
      backupId: () => 'backup-0001',
      database: seed.database,
      dataDir: seed.dataDir,
      keep: 7,
      now: () => new Date(START_TIME),
    });

    expect(result.backupId).toBe('backup-0001');
    expect(result.backupDir).toBe(join(backupsRoot, 'backup-0001'));
    expect(result.manifest.instanceId).toBe(seed.instanceId);
    expect(result.manifest.blobs.map((entry) => entry.hash)).toEqual([
      seed.blobHash,
    ]);

    // Published atomically: only the final directory remains.
    expect(await readdir(backupsRoot)).toEqual(['backup-0001']);
    await expect(
      verifyBackupStructure(result.backupDir),
    ).resolves.toMatchObject({ instanceId: seed.instanceId });
  });

  it('derives a sortable default id from the injected clock', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');

    const result = await runScheduledBackup({
      backupsRoot,
      database: seed.database,
      dataDir: seed.dataDir,
      keep: 7,
      now: () => new Date(START_TIME),
    });

    expect(result.backupId.startsWith('2026-08-07T03-00-00')).toBe(true);
  });

  it('applies keep-N retention across repeated runs, newest retained', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');

    for (let index = 1; index <= 4; index += 1) {
      await runScheduledBackup({
        backupsRoot,
        backupId: () => `backup-000${index}`,
        database: seed.database,
        dataDir: seed.dataDir,
        keep: 2,
        now: () => new Date(`2026-08-0${index}T03:00:00.000Z`),
      });
    }

    const listed = await listBackups(backupsRoot);
    expect(listed.map((entry) => entry.backupId)).toEqual([
      'backup-0004',
      'backup-0003',
    ]);
  });
});

describe('startBackupScheduler', () => {
  it('registers the configured interval and writes an artifact per tick', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    const captured = captureTimer();
    let counter = 0;

    const scheduler = startBackupScheduler({
      backupsRoot,
      backupId: () => {
        counter += 1;
        return `backup-000${counter}`;
      },
      database: seed.database,
      dataDir: seed.dataDir,
      intervalMs: 86_400_000,
      keep: 7,
      timer: captured.timer,
    });

    expect(captured.state.intervalMs).toBe(86_400_000);
    expect(await readdir(backupsRoot).catch(() => [])).toEqual([]);

    await captured.state.handler?.();
    await captured.state.handler?.();

    const listed = await listBackups(backupsRoot);
    expect(listed.map((entry) => entry.backupId).sort()).toEqual([
      'backup-0001',
      'backup-0002',
    ]);
    scheduler.stop();
  });

  it('clears the timer on stop and refuses any later tick', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    const captured = captureTimer();

    const scheduler = startBackupScheduler({
      backupsRoot,
      database: seed.database,
      dataDir: seed.dataDir,
      intervalMs: 3_600_000,
      keep: 7,
      timer: captured.timer,
    });
    scheduler.stop();
    await captured.state.handler?.();

    expect(captured.state.cleared).toBe(1);
    expect(await listBackups(backupsRoot)).toEqual([]);
  });

  it('logs a failing run instead of throwing out of the timer', async () => {
    const dataDir = makeDir();
    // Migrated but never initialised: createBackup must refuse it.
    const database = openTracked(join(dataDir, DB_FILENAME));
    runMigrations(database);
    const captured = captureTimer();
    const errors: string[] = [];

    const scheduler = startBackupScheduler({
      backupsRoot: join(makeDir(), 'backups'),
      database,
      dataDir,
      intervalMs: 3_600_000,
      keep: 7,
      logger: {
        error: (message) => errors.push(message),
        info: () => undefined,
      },
      timer: captured.timer,
    });

    await expect(captured.state.handler?.()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Scheduled backup failed');
    scheduler.stop();
  });
});

describe('parseScheduledBackupConfig', () => {
  it('is disabled when HAVEMIND_BACKUP_DIR is unset or blank', () => {
    expect(parseScheduledBackupConfig({})).toBeNull();
    expect(parseScheduledBackupConfig({ HAVEMIND_BACKUP_DIR: '   ' })).toBeNull();
  });

  it('defaults to a daily interval and keep-7 retention', () => {
    expect(
      parseScheduledBackupConfig({ HAVEMIND_BACKUP_DIR: '/backups' }),
    ).toEqual({
      backupsRoot: '/backups',
      intervalMs: DEFAULT_BACKUP_INTERVAL_HOURS * 3_600_000,
      keep: DEFAULT_BACKUP_KEEP,
    });
  });

  it('accepts explicit interval and retention overrides', () => {
    expect(
      parseScheduledBackupConfig({
        HAVEMIND_BACKUP_DIR: '/backups',
        HAVEMIND_BACKUP_INTERVAL_HOURS: '6',
        HAVEMIND_BACKUP_KEEP: '3',
      }),
    ).toEqual({
      backupsRoot: '/backups',
      intervalMs: 6 * 3_600_000,
      keep: 3,
    });
  });

  it('rejects a non-integer interval and a zero retention', () => {
    expect(() =>
      parseScheduledBackupConfig({
        HAVEMIND_BACKUP_DIR: '/backups',
        HAVEMIND_BACKUP_INTERVAL_HOURS: '1.5',
      }),
    ).toThrow(/HAVEMIND_BACKUP_INTERVAL_HOURS/u);
    expect(() =>
      parseScheduledBackupConfig({
        HAVEMIND_BACKUP_DIR: '/backups',
        HAVEMIND_BACKUP_KEEP: '0',
      }),
    ).toThrow(/HAVEMIND_BACKUP_KEEP/u);
  });
});
