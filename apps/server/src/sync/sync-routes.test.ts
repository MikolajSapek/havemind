import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashBlob,
  PROTOCOL_VERSION,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { SessionRepository } from '../auth/session-repository.js';
import { generateRefreshToken } from '../auth/tokens.js';
import { BlobStore } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './sync-routes.js';
import { VaultWakeRegistry } from './vault-wake-registry.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const START_TIME = '2026-07-16T03:00:00.000Z';
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

const USER_A = '70000000-0000-4000-8000-0000000000a1';
const USER_B = '70000000-0000-4000-8000-0000000000b1';
const DEVICE_A = '70000000-0000-4000-8000-0000000000a2';
const DEVICE_B = '70000000-0000-4000-8000-0000000000b2';
const VAULT_A = '70000000-0000-4000-8000-0000000000a3';
const VAULT_B = '70000000-0000-4000-8000-0000000000b3';
const MEMBERSHIP_A = '70000000-0000-4000-8000-0000000000a4';
const MEMBERSHIP_B = '70000000-0000-4000-8000-0000000000b4';
const FILE_A = '70000000-0000-4000-8000-0000000000a5';
const REVISION_1 = '70000000-0000-4000-8000-000000000001';
const REVISION_2 = '70000000-0000-4000-8000-000000000002';
const REVISION_3 = '70000000-0000-4000-8000-000000000003';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly accessTokenA: string;
  readonly accessTokenB: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function insertUser(database: Database.Database, id: string, name: string): void {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, 0, 'active', ?, NULL)`,
    )
    .run(id, name, START_TIME);
}

function insertDevice(
  database: Database.Database,
  id: string,
  userId: string,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(id, userId, name, Buffer.alloc(32, 0x11), START_TIME, START_TIME);
}

function insertVault(database: Database.Database, id: string, name: string): void {
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, ?, 0, 1, ?, NULL)`,
    )
    .run(id, name, START_TIME);
}

function insertMembership(
  database: Database.Database,
  id: string,
  vaultId: string,
  userId: string,
): void {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
    )
    .run(id, vaultId, userId, START_TIME);
}

function mintAccessToken(
  database: Database.Database,
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): string {
  const issue = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId,
      initialRefreshToken: generateRefreshToken(),
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId,
    }),
  );
  return issue.immediate().accessToken;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-sync-routes-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, { now });
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  insertUser(database, USER_A, 'Alice');
  insertUser(database, USER_B, 'Bob');
  insertDevice(database, DEVICE_A, USER_A, 'Alice Laptop');
  insertDevice(database, DEVICE_B, USER_B, 'Bob Laptop');
  insertVault(database, VAULT_A, 'Vault A');
  insertVault(database, VAULT_B, 'Vault B');
  insertMembership(database, MEMBERSHIP_A, VAULT_A, USER_A);
  insertMembership(database, MEMBERSHIP_B, VAULT_B, USER_B);

  const accessTokenA = mintAccessToken(database, sessions, USER_A, DEVICE_A);
  const accessTokenB = mintAccessToken(database, sessions, USER_B, DEVICE_B);

  return {
    accessTokenA,
    accessTokenB,
    blobStore,
    database,
    revisions,
    sessions,
  };
}

interface SyncBlobStore {
  put: BlobStore['put'];
  read: BlobStore['read'];
}

function createApp(
  fixture: Fixture,
  options?: {
    rateLimit?: { maxRequests: number; windowMs: number };
    /**
     * Test fixtures default to a single fixed rate-limit bucket for
     * simplicity. Pass `false` to exercise the real default `clientKey`
     * (device-keyed for authenticated requests, IP-keyed otherwise), which
     * is what the blob-GET rate-limit exemption is implemented against.
     */
    useFixedClientKey?: boolean;
    maxPayloadBytes?: number;
    wakeRegistry?: VaultWakeRegistry;
    waitTimeoutMs?: number;
    now?: () => Date;
    maxHeldWaitsPerDevice?: number;
    maxHeldWaitsGlobal?: number;
    blobBurstBytes?: number;
    blobRefillBytesPerSecond?: number;
    /**
     * Overrides the blob store used by the sync routes, letting a test
     * inject side effects (e.g. shrinking a vault's quota) at a precise
     * point in the per-revision commit loop.
     */
    blobStore?: SyncBlobStore;
  },
): ReturnType<typeof buildApp> {
  const config = parseServerConfig(TEST_ENV);
  const useFixedClientKey = options?.useFixedClientKey ?? true;
  const app = buildApp({
    auth: {
      ...(useFixedClientKey ? { clientKey: () => 'fixed-test-client' } : {}),
      database: fixture.database,
      ...(options?.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      sessions: fixture.sessions,
      sync: {
        blobStore: options?.blobStore ?? fixture.blobStore,
        database: fixture.database,
        ...(options?.maxPayloadBytes === undefined
          ? {}
          : { maxPayloadBytes: options.maxPayloadBytes }),
        revisions: fixture.revisions,
        ...(options?.wakeRegistry === undefined
          ? {}
          : { wakeRegistry: options.wakeRegistry }),
        ...(options?.waitTimeoutMs === undefined
          ? {}
          : { waitTimeoutMs: options.waitTimeoutMs }),
        ...(options?.now === undefined ? {} : { now: options.now }),
        ...(options?.maxHeldWaitsPerDevice === undefined
          ? {}
          : { maxHeldWaitsPerDevice: options.maxHeldWaitsPerDevice }),
        ...(options?.maxHeldWaitsGlobal === undefined
          ? {}
          : { maxHeldWaitsGlobal: options.maxHeldWaitsGlobal }),
        ...(options?.blobBurstBytes === undefined
          ? {}
          : { blobBurstBytes: options.blobBurstBytes }),
        ...(options?.blobRefillBytesPerSecond === undefined
          ? {}
          : { blobRefillBytesPerSecond: options.blobRefillBytesPerSecond }),
      },
    },
    config,
  });
  applications.push(app);
  return app;
}

function setVaultQuota(database: Database.Database, vaultId: string, quota: number): void {
  database.prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`).run(quota, vaultId);
}

function header(
  revisionId: string,
  parents: readonly string[] = [],
  overrides: Partial<ProtectedRevisionHeader> = {},
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: DEVICE_A,
    expectedMemberId: MEMBERSHIP_A,
    fileId: FILE_A,
    parentRevisionIds: [...parents],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId: VAULT_A,
    ...overrides,
  };
}

function revisionInput(
  revisionId: string,
  parents: readonly string[],
  idempotencyKey: string,
  content: string,
  overrides: Partial<ProtectedRevisionHeader> = {},
): { header: ProtectedRevisionHeader; idempotencyKey: string; payload: string } {
  return {
    header: header(revisionId, parents, overrides),
    idempotencyKey,
    payload: Buffer.from(content, 'utf8').toString('base64'),
  };
}

function push(
  app: ReturnType<typeof buildApp>,
  token: string,
  vaultId: string,
  revisions: ReadonlyArray<ReturnType<typeof revisionInput>>,
) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    payload: { revisions },
    url: `/vaults/${vaultId}/revisions`,
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('sync push/pull routes', () => {
  it('accepts a single revision and exposes it through cursor-based pull', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    expect(pushed.statusCode).toBe(200);
    expect(pushed.headers['cache-control']).toBe('no-store');
    const body = pushed.json() as {
      results: Array<{ revisionId: string; status: string; receipt: { serverSequence: number } }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.revisionId).toBe(REVISION_1);
    expect(body.results[0]?.status).toBe('accepted');
    expect(body.results[0]?.receipt.serverSequence).toBe(1);

    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    expect(pulled.statusCode).toBe(200);
    const pull = pulled.json() as {
      cursor: number;
      events: Array<{ revisionId: string }>;
    };
    expect(pull.cursor).toBe(1);
    expect(pull.events.map((event) => event.revisionId)).toEqual([REVISION_1]);
  });

  it('commits an out-of-order batch by topological order', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // The child is listed before its parent to prove the server reorders.
    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    expect(pushed.statusCode).toBe(200);
    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { events: Array<{ revisionId: string }> };
    expect(pull.events.map((event) => event.revisionId)).toEqual([
      REVISION_1,
      REVISION_2,
    ]);
  });

  it('rejects a whole batch that introduces a cycle with 422', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [REVISION_2], 'k1', 'opaque-1'),
      revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
    ]);

    expect(pushed.statusCode).toBe(422);
    expect(pushed.json()).toEqual({ error: { code: 'INVALID_BATCH' } });

    // No partial acceptance: nothing was committed.
    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { cursor: number; events: unknown[] };
    expect(pull.cursor).toBe(0);
    expect(pull.events).toEqual([]);
  });

  it('rejects a batch with a duplicated revision id with 422', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      revisionInput(REVISION_1, [], 'k1b', 'opaque-1b'),
    ]);

    expect(pushed.statusCode).toBe(422);
    expect(pushed.json()).toEqual({ error: { code: 'INVALID_BATCH' } });
  });

  // F9 binary attachments: base64-inflated payloads (25 MB raw -> ~33.4 MB on
  // the wire) must fit under the raised default, while the ceiling itself
  // must still reject anything larger with the pre-existing error shape.
  it('accepts a payload above the old 512 KB default limit', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const oversizedForOldLimit = 600 * 1024; // > 512 KiB, well under the new default

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'x'.repeat(oversizedForOldLimit)),
    ]);

    expect(pushed.statusCode).toBe(200);
    const body = pushed.json() as { results: Array<{ status: string }> };
    expect(body.results[0]?.status).toBe('accepted');
  });

  it('rejects a payload over the configured maxPayloadBytes limit with 422', async () => {
    const fixture = makeFixture();
    // A small override keeps the base64-inflated wire size well under the
    // Fastify body limit, so this isolates the application-level
    // parseBatch() ceiling check from the transport-level body limit tested
    // separately below.
    const smallMaxPayloadBytes = 1024 * 1024;
    const app = createApp(fixture, { maxPayloadBytes: smallMaxPayloadBytes });

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'x'.repeat(smallMaxPayloadBytes + 1)),
    ]);

    expect(pushed.statusCode).toBe(422);
    expect(pushed.json()).toEqual({ error: { code: 'INVALID_BATCH' } });
  });

  it('rejects a payload above the new default payload limit at the transport layer', async () => {
    // With the real (unoverridden) defaults, a decoded payload at the new
    // DEFAULT_MAX_PAYLOAD_BYTES ceiling base64-inflates to a wire size that
    // exceeds the Fastify body limit first. This is accepted, pre-existing
    // behaviour (see app.test.ts "rejects JSON bodies above the configured
    // limit"), the transport layer's 413 is as valid a rejection as the
    // application layer's 422, per the two limits' documented headroom.
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(
        REVISION_1,
        [],
        'k1',
        'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 1),
      ),
    ]);

    expect(pushed.statusCode).toBe(413);
  });

  it('replays an identical revision id with identical bytes as the original result', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const first = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);
    const second = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1-again', 'opaque-1'),
    ]);

    expect(second.statusCode).toBe(200);
    const firstResult = (first.json() as { results: Array<{ receipt: unknown }> })
      .results[0];
    const secondResult = (second.json() as {
      results: Array<{ receipt: unknown; status: string }>;
    }).results[0];
    expect(secondResult?.status).toBe('replayed');
    expect(secondResult?.receipt).toEqual(firstResult?.receipt);
  });

  it('reports an identical revision id with different bytes as a per-revision rejection', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);
    const conflicting = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1-conflict', 'different-bytes'),
    ]);

    // The batch was processed to completion (200) and the domain failure is
    // reported per revision, so the client can dead-letter this one item instead
    // of retrying the whole batch forever.
    expect(conflicting.statusCode).toBe(200);
    const result = (conflicting.json() as {
      results: Array<{ revisionId: string; status: string; code?: string }>;
    }).results[0];
    expect(result?.status).toBe('rejected');
    expect(result?.code).toBe('REVISION_ID_REUSE');
  });

  it('commits the accepted prefix and rejects only the failing revision in a mixed batch', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Pre-commit REVISION_1 so re-pushing it with different bytes is rejected,
    // while a fresh REVISION_2 in the same batch still commits.
    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    // REVISION_2 parents on the already-committed REVISION_1 (same file), so it
    // is a valid child that commits even though the re-pushed REVISION_1 rejects.
    const mixed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1-conflict', 'different-bytes'),
      revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
    ]);

    expect(mixed.statusCode).toBe(200);
    const results = (mixed.json() as {
      results: Array<{ revisionId: string; status: string; code?: string }>;
    }).results;
    const byId = new Map(results.map((entry) => [entry.revisionId, entry]));
    expect(byId.get(REVISION_1)?.status).toBe('rejected');
    expect(byId.get(REVISION_1)?.code).toBe('REVISION_ID_REUSE');
    expect(byId.get(REVISION_2)?.status).toBe('accepted');

    // The accepted revision was durably committed and is now visible on pull.
    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { events: Array<{ revisionId: string }> };
    expect(pull.events.map((event) => event.revisionId)).toEqual([
      REVISION_1,
      REVISION_2,
    ]);
  });

  it('writes no blob for a revision rejected mid-batch, while keeping blobs accepted revisions reference (audit fix #7)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Pre-commit REVISION_1 so re-pushing it with different bytes is rejected
    // (REVISION_ID_REUSE), while REVISION_2 in the same batch still commits.
    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    const rejectedContent = 'different-bytes-orphan';
    const mixed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1-conflict', rejectedContent),
      revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
    ]);

    expect(mixed.statusCode).toBe(200);
    const results = (mixed.json() as {
      results: Array<{ revisionId: string; status: string; code?: string }>;
    }).results;
    const byId = new Map(results.map((entry) => [entry.revisionId, entry]));
    expect(byId.get(REVISION_1)?.status).toBe('rejected');
    expect(byId.get(REVISION_1)?.code).toBe('REVISION_ID_REUSE');
    expect(byId.get(REVISION_2)?.status).toBe('accepted');

    // Validate-before-write: the rejected revision is caught by the read-only
    // feasibility check BEFORE its payload is persisted, so no orphan bytes
    // reach the content-addressed store (audit fix #7, the disk-fill vector).
    const orphanHash = await hashBlob(Buffer.from(rejectedContent, 'utf8'));
    expect(existsSync(fixture.blobStore.pathForHash(orphanHash))).toBe(false);

    // Blobs referenced by committed revisions (the original REVISION_1
    // content and the accepted REVISION_2) must remain readable regardless.
    const originalHash = await hashBlob(Buffer.from('opaque-1', 'utf8'));
    const acceptedHash = await hashBlob(Buffer.from('opaque-2', 'utf8'));
    expect(existsSync(fixture.blobStore.pathForHash(originalHash))).toBe(true);
    expect(existsSync(fixture.blobStore.pathForHash(acceptedHash))).toBe(true);
    // Only the two referenced blobs exist on disk, nothing orphaned.
    expect(await fixture.blobStore.listHashes()).toHaveLength(2);

    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { events: Array<{ revisionId: string }> };
    expect(pull.events.map((event) => event.revisionId)).toEqual([
      REVISION_1,
      REVISION_2,
    ]);
  });

  it('writes no blob when a revision is rejected for MISSING_PARENT (audit fix #7)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // The core audit vector: a member repeatedly pushes a large payload that
    // names a nonexistent parent. Each push is rejected MISSING_PARENT, and
    // must persist NO blob, or the shared data-root grows without bound.
    const rejected = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_2, [REVISION_1], 'k-missing', 'orphan-payload'),
    ]);

    expect(rejected.statusCode).toBe(200);
    const result = (rejected.json() as {
      results: Array<{ revisionId: string; status: string; code?: string }>;
    }).results[0];
    expect(result?.status).toBe('rejected');
    expect(result?.code).toBe('MISSING_PARENT');

    // No bytes reached the content-addressed store.
    expect(await fixture.blobStore.listHashes()).toHaveLength(0);
  });

  it('persists blob and revision together on an accepted commit', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);
    expect(pushed.statusCode).toBe(200);

    // The accepted commit is atomic from the client's view: the blob is on disk
    // AND the revision is durably pullable.
    const acceptedHash = await hashBlob(Buffer.from('opaque-1', 'utf8'));
    expect(existsSync(fixture.blobStore.pathForHash(acceptedHash))).toBe(true);
    expect(await fixture.blobStore.listHashes()).toHaveLength(1);

    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { events: Array<{ revisionId: string }> };
    expect(pull.events.map((event) => event.revisionId)).toEqual([REVISION_1]);
  });

  it('leaves no orphan when concurrent commits push identical bytes', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Two files sharing identical payload bytes, committed concurrently. The
    // content-addressed store must dedupe to a single blob with no corruption
    // and no delete-in-use, and both revisions must be durably committed.
    const sharedContent = 'shared-identical-bytes';
    const [first, second] = await Promise.all([
      push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', sharedContent),
      ]),
      push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_2, [], 'k2', sharedContent, {
          fileId: '70000000-0000-4000-8000-0000000000c5',
        }),
      ]),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const sharedHash = await hashBlob(Buffer.from(sharedContent, 'utf8'));
    expect(existsSync(fixture.blobStore.pathForHash(sharedHash))).toBe(true);
    // Deduplicated: exactly one blob on disk for the identical bytes.
    expect(await fixture.blobStore.listHashes()).toEqual([sharedHash]);
    // Still readable (no delete-in-use corrupted or removed it).
    await expect(fixture.blobStore.read(sharedHash)).resolves.toEqual(
      Buffer.from(sharedContent, 'utf8'),
    );

    const pulled = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    const pull = pulled.json() as { events: Array<{ revisionId: string }> };
    expect(pull.events.map((event) => event.revisionId).sort()).toEqual(
      [REVISION_1, REVISION_2].sort(),
    );
  });

  it('rejects an over-quota batch before any blob is staged (staged bytes counted)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Budget fits one 8-byte payload but not two: the second distinct blob in
    // the same batch pushes the projected total past quota, so the whole
    // request is rejected before ANY payload is written.
    setVaultQuota(fixture.database, VAULT_A, 12);
    const overBatch = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'aaaaaaaa'),
      revisionInput(REVISION_2, [], 'k2', 'bbbbbbbb', {
        fileId: '70000000-0000-4000-8000-0000000000c6',
      }),
    ]);

    expect(overBatch.statusCode).toBe(413);
    expect(overBatch.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(await fixture.blobStore.listHashes()).toHaveLength(0);
  });

  it('rejects a header whose vault or actor does not match the session with 403', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const mismatch = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1', {
        expectedMemberId: MEMBERSHIP_B,
      }),
    ]);

    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toEqual({ error: { code: 'FORBIDDEN' } });
  });

  it('rejects a push to a vault the caller is not a member of with 403', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenB}` },
      method: 'POST',
      payload: {
        revisions: [revisionInput(REVISION_1, [], 'k1', 'opaque-1')],
      },
      url: `/vaults/${VAULT_A}/revisions`,
    });

    expect(pushed.statusCode).toBe(403);
  });

  it('rejects a malformed batch body with 400', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const empty = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'POST',
      payload: { revisions: [] },
      url: `/vaults/${VAULT_A}/revisions`,
    });

    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects a batch with a structurally invalid header with 422', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'POST',
      payload: {
        revisions: [
          { header: { nonsense: true }, idempotencyKey: 'k1', payload: '' },
        ],
      },
      url: `/vaults/${VAULT_A}/revisions`,
    });

    expect(pushed.statusCode).toBe(422);
    expect(pushed.json()).toEqual({ error: { code: 'INVALID_BATCH' } });
  });

  it('requires authentication for every sync route', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const unauth = await app.inject({
      method: 'POST',
      payload: { revisions: [revisionInput(REVISION_1, [], 'k1', 'x')] },
      url: `/vaults/${VAULT_A}/revisions`,
    });

    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('paginates events with a bounded page and advancing cursor', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_3, [REVISION_2], 'k3', 'opaque-3'),
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
    ]);

    const firstPage = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?after=0&limit=2`,
    });
    const first = firstPage.json() as {
      cursor: number;
      events: Array<{ serverSequence: number }>;
    };
    expect(first.cursor).toBe(3);
    expect(first.events.map((event) => event.serverSequence)).toEqual([1, 2]);

    const secondPage = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?after=2&limit=2`,
    });
    const second = secondPage.json() as {
      events: Array<{ serverSequence: number }>;
    };
    expect(second.events.map((event) => event.serverSequence)).toEqual([3]);
  });

  it('rejects an out-of-range pull cursor or limit with 400', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const badLimit = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?limit=0`,
    });
    const badCursor = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?after=-1`,
    });

    expect(badLimit.statusCode).toBe(400);
    expect(badCursor.statusCode).toBe(400);
  });

  it('rejects a pull cursor beyond the max sequence with CURSOR_INVALID even without an epoch param', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    // A cursor "from the future" (after > highest committed sequence) can arise
    // when restoreInstance rotates server_epoch back to an older backup whose
    // max sequence is lower than the cursor a client still holds. The client
    // pulls WITHOUT the epoch param, so the epoch guard never fires, this must
    // still fail closed rather than silently return an empty page and skip
    // re-issued sequences.
    const future = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?after=99`,
    });

    expect(future.statusCode).toBe(409);
    expect(future.json()).toEqual({ error: { code: 'CURSOR_INVALID' } });
  });

  it('accepts a pull cursor at the max sequence (fully synced) with an empty page', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);

    const atHead = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events?after=1`,
    });

    expect(atHead.statusCode).toBe(200);
    expect((atHead.json() as { events: unknown[] }).events).toEqual([]);
  });

  it('serves a stored blob byte-exactly to a member of its vault', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const content = 'opaque-bytes-🌲-with-emoji';

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', content),
    ]);
    const blobHash = (pushed.json() as {
      results: Array<{ receipt: { blobHash: string } }>;
    }).results[0]?.receipt.blobHash;
    expect(blobHash).toBeDefined();

    const blob = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
    });

    expect(blob.statusCode).toBe(200);
    expect(blob.headers['content-type']).toBe('application/octet-stream');
    expect(blob.rawPayload.equals(Buffer.from(content, 'utf8'))).toBe(true);
  });

  it('hides a blob from members of other vaults with 404', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);
    const blobHash = (pushed.json() as {
      results: Array<{ receipt: { blobHash: string } }>;
    }).results[0]?.receipt.blobHash;

    const crossVault = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenB}` },
      method: 'GET',
      url: `/vaults/${VAULT_B}/blobs/${blobHash}`,
    });

    expect(crossVault.statusCode).toBe(404);
    expect(crossVault.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  describe('AUD-08 blob-GET rate-limit exemption', () => {
    it('does not 429 an authenticated device fetching more blobs than the rate limit allows', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture, {
        rateLimit: { maxRequests: 2, windowMs: 60_000 },
        useFixedClientKey: false,
      });

      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);
      const blobHash = (
        pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
      ).results[0]?.receipt.blobHash;
      expect(blobHash).toBeDefined();

      // Three blob GETs from the same authenticated device, one more than the
      // configured maxRequests of 2, none should be rate limited because a
      // blob GET with a valid session never consumes the bucket.
      const responses = await Promise.all(
        Array.from({ length: 3 }, async () =>
          app.inject({
            headers: { authorization: `Bearer ${fixture.accessTokenA}` },
            method: 'GET',
            url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
          }),
        ),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
    });

    it('still rate limits unauthenticated blob GETs', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture, {
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
        useFixedClientKey: false,
      });

      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);
      const blobHash = (
        pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
      ).results[0]?.receipt.blobHash;

      const first = await app.inject({
        method: 'GET',
        url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
      });
      const second = await app.inject({
        headers: { authorization: 'Bearer not-a-real-token' },
        method: 'GET',
        url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
      });

      expect(first.statusCode).toBe(401);
      expect(second.statusCode).toBe(429);
    });

    it('still rate limits authenticated non-blob traffic at the configured threshold', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture, {
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
        useFixedClientKey: false,
      });

      const first = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/events`,
      });
      const second = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/events`,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
    });
  });

  describe('real-time push wake (GET /vaults/:vaultId/wait)', () => {
    async function waitFor(
      predicate: () => boolean,
      timeoutMs = 1_000,
    ): Promise<void> {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error('waitFor condition timed out');
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    }

    it('requires authentication (no bearer -> 401)', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture, { wakeRegistry: new VaultWakeRegistry() });

      const unauth = await app.inject({
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      expect(unauth.statusCode).toBe(401);
      expect(unauth.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('forbids a non-member polling another vault with 403', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture, { wakeRegistry: new VaultWakeRegistry() });

      const cross = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenB}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      expect(cross.statusCode).toBe(403);
      expect(cross.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    });

    it('returns immediately with the current cursor when the server is already ahead', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, { wakeRegistry: registry });

      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);

      const waited = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      expect(waited.statusCode).toBe(200);
      expect(waited.headers['cache-control']).toBe('no-store');
      expect(waited.json()).toEqual({ cursor: 1 });
      // No waiter is ever registered on the fast path.
      expect(registry.pendingCount(VAULT_A)).toBe(0);
    });

    it('wakes a held request when a peer commits a revision', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, {
        wakeRegistry: registry,
        waitTimeoutMs: 10_000,
      });

      const held = app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      await waitFor(() => registry.pendingCount(VAULT_A) === 1);

      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);

      const waited = await held;
      expect(waited.statusCode).toBe(200);
      expect(waited.json()).toEqual({ cursor: 1 });
      expect(registry.pendingCount(VAULT_A)).toBe(0);
    });

    it('notifies exactly once for a batch with at least one accepted revision', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const notify = vi.spyOn(registry, 'notify');
      const app = createApp(fixture, { wakeRegistry: registry });

      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
        revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
      ]);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(VAULT_A, 2);
    });

    it('does not notify for a pure replay batch', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, { wakeRegistry: registry });

      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);

      const notify = vi.spyOn(registry, 'notify');
      const replay = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1-again', 'opaque-1'),
      ]);

      expect((replay.json() as { results: Array<{ status: string }> }).results[0]?.status).toBe(
        'replayed',
      );
      expect(notify).not.toHaveBeenCalled();
    });

    it('does not notify for an all-rejected batch', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, { wakeRegistry: registry });

      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);

      const notify = vi.spyOn(registry, 'notify');
      const rejected = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1-conflict', 'different-bytes'),
      ]);

      expect((rejected.json() as { results: Array<{ status: string }> }).results[0]?.status).toBe(
        'rejected',
      );
      expect(notify).not.toHaveBeenCalled();
    });

    it('wakes a held /wait peer for the committed prefix when a later revision in the same batch trips QUOTA_EXCEEDED (413)', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      // Large enough that the batch-level pre-check (sum of the 3 new blobs)
      // passes; the quota is shrunk mid-loop below to force the third
      // revision's authoritative in-transaction check to trip, simulating a
      // concurrent push racing the pre-check.
      setVaultQuota(fixture.database, VAULT_A, 1_000);
      let putCalls = 0;
      const blobStore: SyncBlobStore = {
        put: async (input) => {
          putCalls += 1;
          if (putCalls === 3) {
            setVaultQuota(fixture.database, VAULT_A, 100);
          }
          return fixture.blobStore.put(input);
        },
        read: (hash) => fixture.blobStore.read(hash),
      };
      const app = createApp(fixture, {
        blobStore,
        wakeRegistry: registry,
        waitTimeoutMs: 10_000,
      });

      const held = app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      await waitFor(() => registry.pendingCount(VAULT_A) === 1);

      const notify = vi.spyOn(registry, 'notify');
      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'a'.repeat(60)),
        revisionInput(REVISION_2, [REVISION_1], 'k2', 'b'.repeat(60)),
        revisionInput(REVISION_3, [REVISION_2], 'k3', 'c'.repeat(60)),
      ]);

      expect(pushed.statusCode).toBe(413);
      expect(pushed.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(VAULT_A, 2);

      const waited = await held;
      expect(waited.statusCode).toBe(200);
      expect(waited.json()).toEqual({ cursor: 2 });
      expect(registry.pendingCount(VAULT_A)).toBe(0);
    });

    it('does not notify when the first revision in the batch trips QUOTA_EXCEEDED (zero accepted)', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      setVaultQuota(fixture.database, VAULT_A, 1_000);
      let putCalls = 0;
      const blobStore: SyncBlobStore = {
        put: async (input) => {
          putCalls += 1;
          if (putCalls === 1) {
            setVaultQuota(fixture.database, VAULT_A, 10);
          }
          return fixture.blobStore.put(input);
        },
        read: (hash) => fixture.blobStore.read(hash),
      };
      const app = createApp(fixture, { blobStore, wakeRegistry: registry });

      const notify = vi.spyOn(registry, 'notify');
      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'a'.repeat(60)),
      ]);

      expect(pushed.statusCode).toBe(413);
      expect(pushed.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
      expect(notify).not.toHaveBeenCalled();
    });

    it('resolves with the unchanged cursor when the hold times out', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, {
        wakeRegistry: registry,
        waitTimeoutMs: 100,
      });

      const waited = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      expect(waited.statusCode).toBe(200);
      expect(waited.json()).toEqual({ cursor: 0 });
      expect(registry.pendingCount(VAULT_A)).toBe(0);
    });

    it('unregisters the waiter when the client aborts the held request', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, {
        wakeRegistry: registry,
        waitTimeoutMs: 10_000,
      });

      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound TCP address');
      }
      const controller = new AbortController();
      const request = fetch(
        `http://127.0.0.1:${address.port}/vaults/${VAULT_A}/wait?cursor=0`,
        {
          headers: { authorization: `Bearer ${fixture.accessTokenA}` },
          signal: controller.signal,
        },
      ).catch(() => undefined);

      await waitFor(() => registry.pendingCount(VAULT_A) === 1);
      controller.abort();
      await request;

      // The abort teardown must drop the waiter so notify never fires against a
      // dead connection (and the 10 s timer is cleared alongside it).
      await waitFor(() => registry.pendingCount(VAULT_A) === 0);
      expect(registry.pendingCount(VAULT_A)).toBe(0);
    });

    it('rejects a device holding more than the concurrent-/wait cap with 429', async () => {
      const fixture = makeFixture();
      const registry = new VaultWakeRegistry();
      const app = createApp(fixture, {
        wakeRegistry: registry,
        waitTimeoutMs: 10_000,
        maxHeldWaitsPerDevice: 2,
      });

      const heldOne = app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });
      const heldTwo = app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });

      await waitFor(() => registry.pendingCount(VAULT_A) === 2);

      // The device already holds the cap of 2; the third /wait is refused
      // immediately rather than opening another 25 s connection.
      const excess = await app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=0`,
      });
      expect(excess.statusCode).toBe(429);
      expect(excess.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
      // The rejected request never subscribed, so the held count is unchanged.
      expect(registry.pendingCount(VAULT_A)).toBe(2);

      // A committed revision wakes the two held waits, releasing both slots.
      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);
      expect((await heldOne).statusCode).toBe(200);
      expect((await heldTwo).statusCode).toBe(200);
      await waitFor(() => registry.pendingCount(VAULT_A) === 0);

      // With both slots freed, a fresh /wait can acquire a hold again.
      const afterRelease = app.inject({
        headers: { authorization: `Bearer ${fixture.accessTokenA}` },
        method: 'GET',
        url: `/vaults/${VAULT_A}/wait?cursor=1`,
      });
      await waitFor(() => registry.pendingCount(VAULT_A) === 1);
      await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_2, [REVISION_1], 'k2', 'opaque-2'),
      ]);
      expect((await afterRelease).statusCode).toBe(200);
    });
  });

  describe('AUD-08b blob-GET per-device byte throttle', () => {
    it('throttles a device that pulls blobs beyond its byte budget and refills over time', async () => {
      const fixture = makeFixture();
      let clockMs = Date.parse(START_TIME);
      const content = 'opaque-1'; // 8 bytes
      const app = createApp(fixture, {
        // 20-byte burst, no refill under a frozen clock: two 8-byte pulls fit,
        // the third is over budget.
        blobBurstBytes: 20,
        blobRefillBytesPerSecond: 100,
        now: () => new Date(clockMs),
      });

      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', content),
      ]);
      const blobHash = (
        pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
      ).results[0]?.receipt.blobHash;
      expect(blobHash).toBeDefined();

      const get = async () =>
        app.inject({
          headers: { authorization: `Bearer ${fixture.accessTokenA}` },
          method: 'GET',
          url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
        });

      expect((await get()).statusCode).toBe(200);
      expect((await get()).statusCode).toBe(200);
      // Budget exhausted (4 bytes left, 8 needed) -> throttled.
      const throttled = await get();
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json()).toEqual({ error: { code: 'RATE_LIMITED' } });

      // One second later the bucket has refilled to its cap and serves again.
      clockMs += 1_000;
      expect((await get()).statusCode).toBe(200);
    });

    it('leaves a handful of normal blob pulls unaffected under the default budget', async () => {
      const fixture = makeFixture();
      const app = createApp(fixture);

      const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
      ]);
      const blobHash = (
        pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
      ).results[0]?.receipt.blobHash;

      for (let i = 0; i < 8; i += 1) {
        const blob = await app.inject({
          headers: { authorization: `Bearer ${fixture.accessTokenA}` },
          method: 'GET',
          url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
        });
        expect(blob.statusCode).toBe(200);
      }
    });
  });
});
