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
import { BlobStore } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';
import { InvitationService } from './invitations.js';
import { SessionRepository } from './session-repository.js';
import { generateRefreshToken, hashRefreshToken } from './tokens.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const START_TIME = '2026-07-21T03:00:00.000Z';

const OWNER_USER = '93000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '93000000-0000-4000-8000-0000000000a2';
const VAULT = '93000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '93000000-0000-4000-8000-0000000000a4';
const INVITEE_USER = '93000000-0000-4000-8000-0000000000b1';
const INVITEE_DEVICE = '93000000-0000-4000-8000-0000000000b2';
const INVITEE_MEMBERSHIP = '93000000-0000-4000-8000-0000000000b4';
const FILE_ID = '93000000-0000-4000-8000-0000000000c5';
const REVISION_ID = '93000000-0000-4000-8000-000000000001';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface Fixture {
  readonly clock: { ms: number };
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly invitations: InvitationService;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly ownerAccessToken: string;
  readonly inviteeAccessToken: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function insertUser(db: Database.Database, id: string, name: string, owner: 0 | 1): void {
  db.prepare(
    `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
     VALUES (?, ?, ?, 'active', ?, NULL)`,
  ).run(id, name, owner, START_TIME);
}

function insertDevice(db: Database.Database, id: string, userId: string, name: string): void {
  db.prepare(
    `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
  ).run(id, userId, name, Buffer.alloc(32, 0x44), START_TIME, START_TIME);
}

function insertMembership(
  db: Database.Database,
  id: string,
  userId: string,
  role: 'owner' | 'editor',
): void {
  db.prepare(
    `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
  ).run(id, VAULT, userId, role, START_TIME);
}

function mintAccessToken(
  db: Database.Database,
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): string {
  const issue = db.transaction(() =>
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-revoke-routes-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const clock = { ms: Date.parse(START_TIME) };
  const now = (): Date => new Date(clock.ms);
  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
  });
  const invitations = new InvitationService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  insertUser(database, OWNER_USER, 'Alice', 1);
  insertUser(database, INVITEE_USER, 'Magda', 0);
  insertDevice(database, OWNER_DEVICE, OWNER_USER, 'Alice Laptop');
  insertDevice(database, INVITEE_DEVICE, INVITEE_USER, 'Magda Laptop');
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, ?, 0, 1, ?, NULL)`,
    )
    .run(VAULT, 'Shared Vault', START_TIME);
  insertMembership(database, OWNER_MEMBERSHIP, OWNER_USER, 'owner');
  insertMembership(database, INVITEE_MEMBERSHIP, INVITEE_USER, 'editor');

  const ownerAccessToken = mintAccessToken(database, sessions, OWNER_USER, OWNER_DEVICE);
  const inviteeAccessToken = mintAccessToken(
    database,
    sessions,
    INVITEE_USER,
    INVITEE_DEVICE,
  );

  return {
    blobStore,
    clock,
    database,
    invitations,
    inviteeAccessToken,
    ownerAccessToken,
    revisions,
    sessions,
  };
}

function createApp(fixture: Fixture) {
  const config = parseServerConfig(TEST_ENV);
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database: fixture.database,
      invitations: fixture.invitations,
      now: () => new Date(fixture.clock.ms),
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

function revoke(
  app: ReturnType<typeof buildApp>,
  token: string,
  membershipId: string,
) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    url: `/owner/memberships/${membershipId}/revoke`,
  });
}

function requestGrant(
  app: ReturnType<typeof buildApp>,
  token: string,
  membershipId: string,
) {
  return app.inject({
    body: { membershipId },
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    url: '/owner/rejoin-grants',
  });
}

function redeem(app: ReturnType<typeof buildApp>, refreshTokenHash: string) {
  return app.inject({
    body: {
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: refreshTokenHash,
      membershipId: INVITEE_MEMBERSHIP,
      // A syntactically valid rejoin secret so the request passes body validation
      // and reaches the revoked-membership check (which fails before the secret
      // is ever compared). This suite exercises revocation, not the secret gate.
      rejoinSecret: `hm_rj_${'A'.repeat(43)}`,
    },
    method: 'POST',
    url: '/auth/rejoin',
  });
}

function inviteeHeader(): ProtectedRevisionHeader {
  return {
    expectedDeviceId: INVITEE_DEVICE,
    expectedMemberId: INVITEE_MEMBERSHIP,
    fileId: FILE_ID,
    parentRevisionIds: [],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId: REVISION_ID,
    semantics: SEMANTICS,
    vaultId: VAULT,
  };
}

async function pushInviteeRevision(
  app: ReturnType<typeof buildApp>,
  token: string,
) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    payload: {
      revisions: [
        {
          header: inviteeHeader(),
          idempotencyKey: 'k1',
          payload: Buffer.from('opaque-invitee-1', 'utf8').toString('base64'),
        },
      ],
    },
    url: `/vaults/${VAULT}/revisions`,
  });
}

function pullEvents(app: ReturnType<typeof buildApp>, token: string) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'GET',
    url: `/vaults/${VAULT}/events`,
  });
}

afterEach(async () => {
  while (applications.length > 0) {
    await applications.pop()?.close();
  }
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe('POST /owner/memberships/:membershipId/revoke', () => {
  it('lets an owner revoke a member and flips membership + device to revoked', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await revoke(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      membershipId: INVITEE_MEMBERSHIP,
      status: 'revoked',
    });

    const membership = fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(INVITEE_MEMBERSHIP) as { status: string };
    expect(membership.status).toBe('revoked');
    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(INVITEE_DEVICE) as { status: string };
    expect(device.status).toBe('revoked');
  });

  it("kills the revoked member's sessions — their next authenticated request 401s", async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Before revocation the invitee can pull the shared vault's events.
    const before = await pullEvents(app, fixture.inviteeAccessToken);
    expect(before.statusCode).toBe(200);

    await revoke(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    // After revocation the same access token is terminally dead (401).
    const after = await pullEvents(app, fixture.inviteeAccessToken);
    expect(after.statusCode).toBe(401);
  });

  it("preserves the revoked member's past revisions, still pullable by remaining members", async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await pushInviteeRevision(app, fixture.inviteeAccessToken);
    expect(pushed.statusCode).toBe(200);

    await revoke(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    // The remaining member (the owner) still sees the revoked member's revision:
    // revocation is a status change, never a delete of past history/attribution.
    const events = await pullEvents(app, fixture.ownerAccessToken);
    expect(events.statusCode).toBe(200);
    const body = events.json() as {
      events: Array<{ revisionId?: string }>;
    };
    const revisionIds = body.events
      .map((event) => event.revisionId)
      .filter((id): id is string => typeof id === 'string');
    expect(revisionIds).toContain(REVISION_ID);

    // The attribution row survives intact (append-only): the revision still
    // points at the now-revoked membership.
    const revision = fixture.database
      .prepare('SELECT membership_id AS membershipId FROM revisions WHERE id = ?')
      .get(REVISION_ID) as { membershipId: string };
    expect(revision.membershipId).toBe(INVITEE_MEMBERSHIP);
  });

  it('forbids a non-owner (invitee) from revoking anyone', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await revoke(
      app,
      fixture.inviteeAccessToken,
      OWNER_MEMBERSHIP,
    );
    expect(response.statusCode).toBe(403);
    // The owner's membership is untouched.
    const owner = fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(OWNER_MEMBERSHIP) as { status: string };
    expect(owner.status).toBe('active');
  });

  it('refuses to let the owner revoke their own membership', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await revoke(app, fixture.ownerAccessToken, OWNER_MEMBERSHIP);
    expect(response.statusCode).toBe(403);
    const owner = fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(OWNER_MEMBERSHIP) as { status: string };
    expect(owner.status).toBe('active');
  });

  it('rejects an unauthenticated revoke request', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await app.inject({
      method: 'POST',
      url: `/owner/memberships/${INVITEE_MEMBERSHIP}/revoke`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('a revoked membership is terminally locked out of rejoin', () => {
  it('refuses to mint a rejoin grant for a revoked member', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await revoke(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    const response = await requestGrant(
      app,
      fixture.ownerAccessToken,
      INVITEE_MEMBERSHIP,
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses to redeem a grant once the member is revoked', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    // Mint a live grant while the member is still active …
    const grant = await requestGrant(
      app,
      fixture.ownerAccessToken,
      INVITEE_MEMBERSHIP,
    );
    expect(grant.statusCode).toBe(200);

    // … then revoke the member, so the grant can no longer be redeemed.
    await revoke(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    const response = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(response.statusCode).toBe(401);
  });
});

describe('resolveRevokeError (MINOR 10)', () => {
  it('maps a domain revocation error to its own status and code', async () => {
    const { resolveRevokeError } = await import('./revoke-routes.js');
    const { MembershipRevocationError } = await import(
      './membership-revocation.js'
    );
    const error = new MembershipRevocationError('MEMBERSHIP_NOT_FOUND');
    expect(resolveRevokeError(error)).toEqual({
      status: error.httpStatus,
      code: 'NOT_FOUND',
    });
  });

  it('maps an unexpected error to a 500 INTERNAL, not a 4xx INVALID_REQUEST', async () => {
    const { resolveRevokeError } = await import('./revoke-routes.js');
    expect(resolveRevokeError(new Error('boom'))).toEqual({
      status: 500,
      code: 'INTERNAL',
    });
  });
});
