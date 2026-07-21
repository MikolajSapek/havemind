import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { InvitationService } from './invitations.js';
import { RejoinGrantService } from './rejoin-grants.js';
import { SessionRepository } from './session-repository.js';
import { generateRefreshToken, hashRefreshToken } from './tokens.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const START_TIME = '2026-07-21T03:00:00.000Z';

const OWNER_USER = '91000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '91000000-0000-4000-8000-0000000000a2';
const VAULT = '91000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '91000000-0000-4000-8000-0000000000a4';
const INVITEE_USER = '91000000-0000-4000-8000-0000000000b1';
const INVITEE_DEVICE = '91000000-0000-4000-8000-0000000000b2';
const INVITEE_MEMBERSHIP = '91000000-0000-4000-8000-0000000000b4';

interface Fixture {
  readonly clock: { ms: number };
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly invitations: InvitationService;
  readonly rejoin: RejoinGrantService;
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
  ).run(id, userId, name, Buffer.alloc(32, 0x22), START_TIME, START_TIME);
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-rejoin-routes-'));
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
  const rejoin = new RejoinGrantService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });

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
    clock,
    database,
    invitations,
    inviteeAccessToken,
    ownerAccessToken,
    rejoin,
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
    },
    config,
  });
  applications.push(app);
  return app;
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
    },
    method: 'POST',
    url: '/auth/rejoin',
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

describe('POST /owner/rejoin-grants', () => {
  it('lets an owner issue a grant for a known contact', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'granted',
      membershipId: INVITEE_MEMBERSHIP,
      boundDeviceId: INVITEE_DEVICE,
    });
  });

  it('forbids a non-owner (invitee) from issuing a grant', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await requestGrant(
      app,
      fixture.inviteeAccessToken,
      INVITEE_MEMBERSHIP,
    );
    expect(response.statusCode).toBe(403);
  });

  it('rejects an unauthenticated grant request', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await app.inject({
      body: { membershipId: INVITEE_MEMBERSHIP },
      method: 'POST',
      url: '/owner/rejoin-grants',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /auth/rejoin', () => {
  it('redeems a live grant and reports the resumed identity', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    const response = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'rejoined',
      membershipId: INVITEE_MEMBERSHIP,
      vaultId: VAULT,
      deviceId: INVITEE_DEVICE,
    });
  });

  it('returns a flat 401 on a second (already consumed) redemption', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);
    await redeem(app, hashRefreshToken(generateRefreshToken()));

    const second = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(second.statusCode).toBe(401);
  });

  it('returns a flat 401 when the presented device is not the bound one', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    const response = await app.inject({
      body: {
        deviceId: OWNER_DEVICE,
        initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
        membershipId: INVITEE_MEMBERSHIP,
      },
      method: 'POST',
      url: '/auth/rejoin',
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns a flat 401 when no grant exists', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(response.statusCode).toBe(401);
  });
});
