import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadSodium, type Sodium } from '@havemind/crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runCheckpointCli } from './checkpoint-cli.js';
import { DB_FILENAME } from './db.js';
import { seedPushedInstance } from './test/fixtures/instance-fixtures.js';
import {
  makeTempDir,
  openTrackedDatabase,
  releaseTestResources,
  TEST_ENV,
} from './test/fixtures/server-fixtures.js';

const START_TIME = '2026-07-24T03:00:00.000Z';

let sodium: Sodium;

beforeAll(async () => {
  sodium = await loadSodium();
});

const makeDir = (): string => makeTempDir('havemind-cpcli-');

function deps(env: Record<string, string | undefined>) {
  return {
    env,
    loadSodium: async (): Promise<Sodium> => sodium,
    now: (): Date => new Date(START_TIME),
  };
}

async function seedDataDir(): Promise<string> {
  return (await seedPushedInstance(makeDir(), DB_FILENAME, START_TIME, 'opaque-payload'))
    .dataDir;
}

afterEach(releaseTestResources);

const HEX32 = /^[0-9a-f]{64}$/u;

describe('havemind checkpoint CLI', () => {
  it('prints usage with no subcommand', async () => {
    const result = await runCheckpointCli([], deps(TEST_ENV));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: havemind checkpoint');
  });

  it('generate-keypair prints a public and secret key', async () => {
    const result = await runCheckpointCli(['generate-keypair'], deps(TEST_ENV));
    expect(result.exitCode).toBe(0);
    const hexes = result.stdout.match(/[0-9a-f]{64}/gu) ?? [];
    expect(hexes).toHaveLength(2);
    expect(hexes[0]).toMatch(HEX32);
    expect(hexes[1]).toMatch(HEX32);
    expect(hexes[0]).not.toBe(hexes[1]);
  });

  it('create then restore round-trips through the CLI', async () => {
    const dataDir = await seedDataDir();
    const kp = await runCheckpointCli(['generate-keypair'], deps(TEST_ENV));
    const [publicKey, secretKey] = (kp.stdout.match(/[0-9a-f]{64}/gu) ??
      []) as [string, string];

    const checkpointsDir = join(makeDir(), 'checkpoints');
    const createEnv = {
      ...TEST_ENV,
      HAVEMIND_CHECKPOINT_DIR: checkpointsDir,
      HAVEMIND_CHECKPOINT_PUBLIC_KEY: publicKey,
      HAVEMIND_DATA_DIR: dataDir,
    };
    const created = await runCheckpointCli(['create'], deps(createEnv));
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('Checkpoint created.');

    const checkpointId = (await readdir(checkpointsDir)).find(
      (name) => !name.startsWith('.'),
    ) as string;
    const checkpointDir = join(checkpointsDir, checkpointId);
    const targetDir = join(makeDir(), 'restored');

    const restored = await runCheckpointCli(
      [
        'restore',
        '--from',
        checkpointDir,
        '--to',
        targetDir,
        '--secret-key',
        secretKey,
        '--public-key',
        publicKey,
      ],
      deps(TEST_ENV),
    );
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain('Checkpoint restored and verified.');

    const restoredDb = openTrackedDatabase(join(targetDir, DB_FILENAME));
    expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('create fails without a public key', async () => {
    const dataDir = await seedDataDir();
    const result = await runCheckpointCli(
      ['create'],
      deps({ ...TEST_ENV, HAVEMIND_DATA_DIR: dataDir }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('public key');
  });

  it('restore fails without the owner secret key', async () => {
    const result = await runCheckpointCli(
      ['restore', '--from', '/x', '--to', '/y', '--public-key', 'a'.repeat(64)],
      deps(TEST_ENV),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('secret key');
  });
});
