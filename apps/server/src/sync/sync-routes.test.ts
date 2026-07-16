import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { SessionRepository } from '../auth/session-repository.js';
import { generateRefreshToken } from '../auth/tokens.js';
import { BlobStore } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';

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

function createApp(fixture: Fixture): ReturnType<typeof buildApp> {
  const config = parseServerConfig(TEST_ENV);
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database: fixture.database,
      sessions: fixture.sessions,
      sync: {
        blobStore: fixture.blobStore,
        database: fixture.database,
        revisions: fixture.revisions,
      },
    },
    config,
  });
  applications.push(app);
  return app;
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

  it('rejects an identical revision id with different bytes with 409', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1', 'opaque-1'),
    ]);
    const conflicting = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, [], 'k1-conflict', 'different-bytes'),
    ]);

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toEqual({
      error: { code: 'REVISION_ID_REUSE' },
    });
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
});
