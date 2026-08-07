import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashBlob } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runBackupCli } from './backup-cli.js';
import { listBackups, readInstanceEpoch } from './backup-restore.js';
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-bcli-'));
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
  readonly blobHash: string;
  readonly instanceId: string;
  readonly serverEpoch: string;
}

/**
 * Seeds an initialised instance and CLOSES the database, because the CLI opens
 * the data directory itself — exactly as the operator invocation does.
 */
async function seedInstance(): Promise<SeededInstance> {
  const dataDir = makeDir();
  const database = openDatabase(join(dataDir, DB_FILENAME));
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
  database.close();

  return {
    blobHash,
    dataDir,
    instanceId: init.instanceId,
    serverEpoch: init.serverEpoch,
  };
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

describe('havemind backup', () => {
  it('writes one artifact into --to and reports the manifest', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');

    const result = await runBackupCli(['--to', backupsRoot], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Backup created.');
    expect(result.stdout).toContain('Blobs:');
    const listed = await listBackups(backupsRoot);
    expect(listed).toHaveLength(1);
  });

  it('falls back to HAVEMIND_BACKUP_DIR when --to is omitted', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');

    const result = await runBackupCli([], {
      env: {
        HAVEMIND_BACKUP_DIR: backupsRoot,
        HAVEMIND_DATA_DIR: seed.dataDir,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(await listBackups(backupsRoot)).toHaveLength(1);
  });

  it('applies --keep retention', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    const env = { HAVEMIND_DATA_DIR: seed.dataDir };

    for (let index = 1; index <= 3; index += 1) {
      const result = await runBackupCli(['--to', backupsRoot, '--keep', '1'], {
        backupId: () => `backup-000${index}`,
        env,
        now: () => new Date(`2026-08-0${index}T03:00:00.000Z`),
      });
      expect(result.exitCode).toBe(0);
    }

    const listed = await listBackups(backupsRoot);
    expect(listed.map((entry) => entry.backupId)).toEqual(['backup-0003']);
  });

  it('fails without HAVEMIND_DATA_DIR', async () => {
    const result = await runBackupCli(['--to', makeDir()], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('fails without a destination directory', async () => {
    const seed = await seedInstance();
    const result = await runBackupCli([], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--to');
  });

  it('rejects a non-integer --keep', async () => {
    const seed = await seedInstance();
    const result = await runBackupCli(
      ['--to', join(makeDir(), 'backups'), '--keep', 'many'],
      { env: { HAVEMIND_DATA_DIR: seed.dataDir } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--keep');
  });

  it('reports a secret-free failure for an uninitialised instance', async () => {
    const dataDir = makeDir();
    const database = openDatabase(join(dataDir, DB_FILENAME));
    runMigrations(database);
    database.close();

    const result = await runBackupCli(['--to', join(makeDir(), 'backups')], {
      env: { HAVEMIND_DATA_DIR: dataDir },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INSTANCE_STATE_MISSING');
  });
});

describe('havemind backup verify', () => {
  it('passes on a freshly written artifact', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    await runBackupCli(['--to', backupsRoot, '--id', 'backup-0001'], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });

    const result = await runBackupCli(
      ['verify', '--from', join(backupsRoot, 'backup-0001')],
      { env: {} },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('fails on a tampered blob', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    await runBackupCli(['--to', backupsRoot, '--id', 'backup-0001'], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });
    await writeFile(
      join(
        backupsRoot,
        'backup-0001',
        'blobs',
        seed.blobHash.slice(0, 2),
        seed.blobHash,
      ),
      'corrupted-bytes',
    );

    const result = await runBackupCli(
      ['verify', '--from', join(backupsRoot, 'backup-0001')],
      { env: {} },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MANIFEST_MISMATCH');
  });
});

describe('havemind backup restore', () => {
  it('rebuilds a scratch data directory and rotates the epoch', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    await runBackupCli(['--to', backupsRoot, '--id', 'backup-0001'], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });
    const targetDir = join(makeDir(), 'restored');

    const result = await runBackupCli(
      [
        'restore',
        '--from',
        join(backupsRoot, 'backup-0001'),
        '--to',
        targetDir,
      ],
      { env: {} },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
    const restored = openTracked(join(targetDir, DB_FILENAME));
    const epoch = readInstanceEpoch(restored);
    expect(epoch?.instanceId).toBe(seed.instanceId);
    expect(epoch?.restoreEpoch).toBe(1);
    expect(epoch?.serverEpoch).not.toBe(seed.serverEpoch);
  });

  it('requires --from and --to', async () => {
    const result = await runBackupCli(['restore', '--from', makeDir()], {
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--to');
  });

  it('refuses a non-empty target and reports the code', async () => {
    const seed = await seedInstance();
    const backupsRoot = join(makeDir(), 'backups');
    await runBackupCli(['--to', backupsRoot, '--id', 'backup-0001'], {
      env: { HAVEMIND_DATA_DIR: seed.dataDir },
    });
    const targetDir = makeDir();
    await writeFile(join(targetDir, 'occupied.txt'), 'x');

    const result = await runBackupCli(
      ['restore', '--from', join(backupsRoot, 'backup-0001'), '--to', targetDir],
      { env: {} },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TARGET_NOT_EMPTY');
  });
});

describe('havemind backup help', () => {
  it('prints usage for help and for an unknown subcommand', async () => {
    const help = await runBackupCli(['help'], { env: {} });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: havemind backup');

    const unknown = await runBackupCli(['frobnicate'], { env: {} });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('Unknown backup subcommand');
  });
});
