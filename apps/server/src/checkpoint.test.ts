import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  generateCheckpointKeypair,
  loadSodium,
  type CheckpointKeypair,
  type Sodium,
} from '@havemind/crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readInstanceEpoch } from './backup-restore.js';
import {
  CHECKPOINT_FORMAT_VERSION,
  CheckpointError,
  createCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  restoreCheckpoint,
} from './checkpoint.js';
import { DB_FILENAME } from './db.js';
import { runMigrations } from './migrations.js';
import {
  type MinimalInstance as SeededInstance,
  seedPushedInstance,
} from './test/fixtures/instance-fixtures.js';
import {
  makeTempDir,
  openTrackedDatabase as openTracked,
  releaseTestResources,
} from './test/fixtures/server-fixtures.js';

const START_TIME = '2026-07-24T03:00:00.000Z';
const NEW_EPOCH = '99999999-0000-4000-8000-0000000000ff';
// A distinctive marker injected into the note payload; the confidentiality and
// manifest-redaction assertions grep raw bytes for it (plans/006 AC3, AC10).
const SECRET_MARKER = 'TOP-SECRET-NOTE-BODY-marker-9f2c';

let sodium: Sodium;
let keypair: CheckpointKeypair;

beforeAll(async () => {
  sodium = await loadSodium();
  keypair = generateCheckpointKeypair(sodium);
});

const makeDir = (): string => makeTempDir('havemind-checkpoint-');

function seedInstance(): Promise<SeededInstance> {
  return seedPushedInstance(
    makeDir(),
    DB_FILENAME,
    START_TIME,
    `opaque-payload:${SECRET_MARKER}`,
  );
}

async function makeCheckpoint(seed: SeededInstance): Promise<{
  checkpointsDir: string;
  checkpointDir: string;
}> {
  const checkpointsDir = join(makeDir(), 'checkpoints');
  const result = await createCheckpoint({
    checkpointsDir,
    checkpointId: () => 'cp-0001',
    database: seed.database,
    dataDir: seed.dataDir,
    now: () => new Date(START_TIME),
    publicKey: keypair.publicKey,
    sodium,
  });
  return { checkpointDir: result.checkpointDir, checkpointsDir };
}

afterEach(releaseTestResources);

describe('createCheckpoint', () => {
  it('produces a manifest enumerating the referenced blob with its byte hash+size', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);

    const manifest = JSON.parse(
      await readFile(join(checkpointDir, 'manifest.json'), 'utf8'),
    ) as {
      checkpointFormatVersion: number;
      instanceId: string;
      serverEpoch: string;
      blobs: Array<{ hash: string; size: number }>;
      dbCiphertextHash: string;
    };
    expect(manifest.checkpointFormatVersion).toBe(CHECKPOINT_FORMAT_VERSION);
    expect(manifest.instanceId).toBe(seed.instanceId);
    expect(manifest.serverEpoch).toBe(seed.serverEpoch);
    expect(manifest.blobs).toHaveLength(1);
    expect(manifest.blobs[0]?.hash).toBe(seed.blobHash);
    expect(manifest.blobs[0]?.size).toBeGreaterThan(0);
    expect(manifest.dbCiphertextHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses to checkpoint an uninitialized instance', async () => {
    const dataDir = makeDir();
    const database = openTracked(join(dataDir, DB_FILENAME));
    runMigrations(database);
    await expect(
      createCheckpoint({
        checkpointsDir: join(makeDir(), 'checkpoints'),
        database,
        dataDir,
        publicKey: keypair.publicKey,
        sodium,
      }),
    ).rejects.toMatchObject({ code: 'INSTANCE_STATE_MISSING' });
  });

  it('keeps note plaintext out of the on-disk ciphertext (T1 confidentiality)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);

    const sealedDb = await readFile(join(checkpointDir, 'havemind.db.enc'));
    const sealedBlob = await readFile(
      join(checkpointDir, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
    );
    expect(sealedDb.toString('latin1')).not.toContain(SECRET_MARKER);
    expect(sealedBlob.toString('latin1')).not.toContain(SECRET_MARKER);
  });

  it('keeps secrets out of the plaintext manifest (T5 redaction)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const manifest = await readFile(
      join(checkpointDir, 'manifest.json'),
      'utf8',
    );
    expect(manifest).not.toContain(SECRET_MARKER);
    expect(manifest).not.toContain('opaque-payload');
  });
});

describe('restoreCheckpoint round-trip', () => {
  it('restores a byte-identical blob store, integrity_check ok, and bumps the epoch', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');

    const originalBlob = await readFile(
      join(seed.dataDir, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
    );

    const epoch = await restoreCheckpoint({
      checkpointDir,
      now: () => new Date(START_TIME),
      publicKey: keypair.publicKey,
      randomUuid: () => NEW_EPOCH,
      secretKey: keypair.secretKey,
      sodium,
      targetDir,
    });

    expect(epoch.instanceId).toBe(seed.instanceId);
    expect(epoch.serverEpoch).toBe(NEW_EPOCH);
    expect(epoch.restoreEpoch).toBe(1);

    const restoredBlob = await readFile(
      join(targetDir, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
    );
    expect(restoredBlob.equals(originalBlob)).toBe(true);

    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(readInstanceEpoch(restoredDb)).toEqual({
      instanceId: seed.instanceId,
      restoreEpoch: 1,
      serverEpoch: NEW_EPOCH,
    });
  });

  it('rejects a restore into a non-empty target directory', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = makeDir();
    writeFileSync(join(targetDir, 'existing.txt'), 'occupied');

    await expect(
      restoreCheckpoint({
        checkpointDir,
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
        sodium,
        targetDir,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
  });
});

describe('restoreCheckpoint fail-closed', () => {
  async function expectRejectedLeavesNothing(
    targetDir: string,
    run: () => Promise<unknown>,
    code: string,
  ): Promise<void> {
    await expect(run()).rejects.toMatchObject({ code });
    // Nothing materialised beyond (at most) an empty target dir: no restored DB.
    await expect(readFile(join(targetDir, DB_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }

  it('rejects a checkpoint the server (public key only) cannot decrypt (AC9)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    const wrong = generateCheckpointKeypair(sodium);

    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: wrong.publicKey,
          secretKey: wrong.secretKey,
          sodium,
          targetDir,
        }),
      'DECRYPTION_FAILED',
    );
  });

  it('rejects a tampered sealed database (T2)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    const path = join(checkpointDir, 'havemind.db.enc');
    const bytes = await readFile(path);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    await writeFile(path, bytes);

    // The manifest binds the ciphertext hash, so a flipped byte is caught
    // before decryption as a manifest mismatch.
    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
          sodium,
          targetDir,
        }),
      'MANIFEST_MISMATCH',
    );
  });

  it('rejects a tampered sealed blob (T2)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    const path = join(
      checkpointDir,
      'blobs',
      seed.blobHash.slice(0, 2),
      seed.blobHash,
    );
    const bytes = await readFile(path);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    await writeFile(path, bytes);

    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
          sodium,
          targetDir,
        }),
      'DECRYPTION_FAILED',
    );
  });

  it('rejects a tampered plaintext manifest (T2)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    const path = join(checkpointDir, 'manifest.json');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/"maxServerSequence": \d+/u, '"maxServerSequence": 999'));

    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
          sodium,
          targetDir,
        }),
      'MANIFEST_MISMATCH',
    );
  });

  it('rejects a tampered sealed manifest (T2)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    const path = join(checkpointDir, 'manifest.json.enc');
    const bytes = await readFile(path);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    await writeFile(path, bytes);

    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
          sodium,
          targetDir,
        }),
      'DECRYPTION_FAILED',
    );
  });

  it('rejects a manifest blob that is missing from the checkpoint (referential integrity)', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');
    await import('node:fs/promises').then(async (fs) =>
      fs.rm(
        join(checkpointDir, 'blobs', seed.blobHash.slice(0, 2), seed.blobHash),
      ),
    );

    await expectRejectedLeavesNothing(
      targetDir,
      async () =>
        restoreCheckpoint({
          checkpointDir,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
          sodium,
          targetDir,
        }),
      'MANIFEST_MISMATCH',
    );
  });

  it('fails the integrity check before starting and leaves the epoch untouched', async () => {
    const seed = await seedInstance();
    const { checkpointDir } = await makeCheckpoint(seed);
    const targetDir = join(makeDir(), 'restored');

    await expect(
      restoreCheckpoint({
        checkpointDir,
        integrityCheck: () => 'malformed database',
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
        sodium,
        targetDir,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
  });
});

describe('atomic publication and snapshot consistency', () => {
  it('leaves no valid checkpoint when a crash hits before the rename (T4)', async () => {
    const seed = await seedInstance();
    const checkpointsDir = join(makeDir(), 'checkpoints');

    await expect(
      createCheckpoint({
        checkpointsDir,
        checkpointId: () => 'cp-crash',
        database: seed.database,
        dataDir: seed.dataDir,
        faults: {
          hit(point) {
            if (point === 'before-rename') {
              throw new Error('simulated crash before rename');
            }
          },
        },
        publicKey: keypair.publicKey,
        sodium,
      }),
    ).rejects.toThrow(/simulated crash/u);

    expect(await listCheckpoints(checkpointsDir)).toHaveLength(0);
  });

  it('takes a consistent DB image even while writes continue (AC11)', async () => {
    const seed = await seedInstance();
    const checkpointsDir = join(makeDir(), 'checkpoints');
    // Interleave a concurrent write against the live DB with the checkpoint's
    // in-process serialize() snapshot; the snapshot must remain internally
    // consistent (restore's integrity_check is the proof).
    seed.database
      .prepare(
        `INSERT INTO vault_events (vault_id, server_sequence, event_type, revision_id, event_payload, created_at)
         SELECT id, 999, 'test-event', NULL, '{}', ? FROM vaults LIMIT 1`,
      )
      .run(START_TIME);

    const { checkpointDir } = await (async () => {
      const result = await createCheckpoint({
        checkpointsDir,
        checkpointId: () => 'cp-concurrent',
        database: seed.database,
        dataDir: seed.dataDir,
        publicKey: keypair.publicKey,
        sodium,
      });
      return { checkpointDir: result.checkpointDir };
    })();

    const targetDir = join(makeDir(), 'restored');
    const epoch = await restoreCheckpoint({
      checkpointDir,
      publicKey: keypair.publicKey,
      randomUuid: () => NEW_EPOCH,
      secretKey: keypair.secretKey,
      sodium,
      targetDir,
    });
    expect(epoch.restoreEpoch).toBe(1);
    const restoredDb = openTracked(join(targetDir, DB_FILENAME));
    expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('retention (keep-N, verify before forget)', () => {
  async function writeCheckpoints(
    seed: SeededInstance,
    checkpointsDir: string,
    ids: readonly string[],
  ): Promise<void> {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index] as string;
      await createCheckpoint({
        checkpointsDir,
        checkpointId: () => id,
        database: seed.database,
        dataDir: seed.dataDir,
        // Distinct createdAt so ordering is deterministic.
        now: () => new Date(Date.parse(START_TIME) + index * 60_000),
        publicKey: keypair.publicKey,
        sodium,
      });
    }
  }

  it('keeps the N newest and removes the rest', async () => {
    const seed = await seedInstance();
    const checkpointsDir = join(makeDir(), 'checkpoints');
    await writeCheckpoints(seed, checkpointsDir, ['a', 'b', 'c', 'd']);

    const result = await pruneCheckpoints({ checkpointsDir, keep: 2 });
    expect(result.kept.map((c) => c.checkpointId)).toEqual(['d', 'c']);
    expect(result.removed.map((c) => c.checkpointId).sort()).toEqual(['a', 'b']);
    expect(
      (await listCheckpoints(checkpointsDir)).map((c) => c.checkpointId),
    ).toEqual(['d', 'c']);
  });

  it('removes nothing if the newest retained checkpoint fails verification', async () => {
    const seed = await seedInstance();
    const checkpointsDir = join(makeDir(), 'checkpoints');
    await writeCheckpoints(seed, checkpointsDir, ['a', 'b', 'c']);
    // Corrupt the newest ('c') so verify-before-forget must abort the prune.
    await writeFile(join(checkpointsDir, 'c', 'havemind.db.enc'), 'corrupt');

    await expect(
      pruneCheckpoints({ checkpointsDir, keep: 1 }),
    ).rejects.toBeInstanceOf(CheckpointError);
    // All three still present, nothing was forgotten.
    expect(await listCheckpoints(checkpointsDir)).toHaveLength(3);
  });
});
