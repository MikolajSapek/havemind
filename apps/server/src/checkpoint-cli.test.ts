import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSodium, type Sodium } from '@havemind/crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { BlobStore } from './blob-store.js';
import { runCheckpointCli } from './checkpoint-cli.js';
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
import {
  PROTOCOL_VERSION,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;
const START_TIME = '2026-07-24T03:00:00.000Z';
const FILE_ID = '70000000-0000-4000-8000-0000000000f5';
const REVISION_ID = '70000000-0000-4000-8000-000000000f01';
const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

let sodium: Sodium;

beforeAll(async () => {
  sodium = await loadSodium();
});

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function makeDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-cpcli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function deps(env: Record<string, string | undefined>) {
  return {
    env,
    loadSodium: async (): Promise<Sodium> => sodium,
    now: (): Date => new Date(START_TIME),
  };
}

async function seedDataDir(): Promise<string> {
  const dataDir = makeDir();
  const database = openDatabase(join(dataDir, DB_FILENAME));
  databases.push(database);
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
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database,
      sessions,
      sync: { blobStore, database, revisions },
    },
    config: parseServerConfig(TEST_ENV),
  });
  applications.push(app);
  const headerValue: ProtectedRevisionHeader = {
    expectedDeviceId: deviceId,
    expectedMemberId: init.membershipId,
    fileId: FILE_ID,
    parentRevisionIds: [],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId: REVISION_ID,
    semantics: SEMANTICS,
    vaultId: vaultRow.id,
  };
  const pushed = await app.inject({
    headers: { authorization: `Bearer ${pair.accessToken}` },
    method: 'POST',
    payload: {
      revisions: [
        {
          header: headerValue,
          idempotencyKey: 'k1',
          payload: Buffer.from('opaque-payload', 'utf8').toString('base64'),
        },
      ],
    },
    url: `/vaults/${vaultRow.id}/revisions`,
  });
  expect(pushed.statusCode).toBe(200);
  return dataDir;
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

    const restoredDb = openDatabase(join(targetDir, DB_FILENAME));
    databases.push(restoredDb);
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
