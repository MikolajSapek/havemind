/**
 * Initialised instances on disk, for the backup and checkpoint suites.
 *
 * Both shapes open their database through `openTrackedDatabase`, so
 * `releaseTestResources` closes whatever a suite leaves open.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashBlob } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { expect } from 'vitest';

import { SessionRepository } from '../../auth/session-repository.js';
import { createLocalOwnerSetupContext, OwnerSetupService } from '../../auth/setup.js';
import { generateRefreshToken } from '../../auth/tokens.js';
import { BlobStore } from '../../blob-store.js';
import { runMigrations } from '../../migrations.js';
import { RevisionRepository } from '../../revision-repository.js';
import {
  createTestApp,
  openTrackedDatabase,
  pushRevisions,
  revisionEntry,
  revisionHeader,
} from './server-fixtures.js';

/** The one file and revision a pushed instance holds. */
export const SEEDED_FILE_ID = '70000000-0000-4000-8000-0000000000f5';
export const SEEDED_REVISION_ID = '70000000-0000-4000-8000-000000000f01';

export interface MinimalInstance {
  readonly dataDir: string;
  readonly database: Database.Database;
  readonly blobHash: string;
  readonly instanceId: string;
  readonly serverEpoch: string;
}

/**
 * A migrated database with an `instance_state` row plus one settled,
 * content-addressed blob on disk: exactly the surface `createBackup`
 * snapshots, without standing up the HTTP app.
 */
export async function seedMinimalInstance(
  dataDir: string,
  databaseFilename: string,
  at: string,
): Promise<MinimalInstance> {
  const database = openTrackedDatabase(join(dataDir, databaseFilename));
  runMigrations(database);
  const setup = new OwnerSetupService(database, { now: () => new Date(at) });
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

export interface PushedInstance extends MinimalInstance {
  readonly blobStore: BlobStore;
  readonly revisions: RevisionRepository;
  readonly sessions: SessionRepository;
  readonly accessToken: string;
  readonly vaultId: string;
  readonly membershipId: string;
  readonly deviceId: string;
}

/**
 * An initialised instance whose paired owner device pushed one revision
 * (`SEEDED_FILE_ID` / `SEEDED_REVISION_ID`, idempotency key `k1`) carrying
 * `content`, through the real HTTP app.
 */
export async function seedPushedInstance(
  dataDir: string,
  databaseFilename: string,
  at: string,
  content: string,
): Promise<PushedInstance> {
  const database = openTrackedDatabase(join(dataDir, databaseFilename));
  runMigrations(database);

  const now = (): Date => new Date(at);
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

  const app = createTestApp({
    database,
    sessions,
    sync: { blobStore, database, revisions },
  });
  const author = { deviceId, membershipId: init.membershipId };
  const pushed = await pushRevisions(app, pair.accessToken, vaultRow.id, [
    revisionEntry(
      revisionHeader(vaultRow.id, author, SEEDED_REVISION_ID, SEEDED_FILE_ID),
      'k1',
      content,
    ),
  ]);
  expect(pushed.statusCode).toBe(200);
  const blobHash = (
    pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
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
