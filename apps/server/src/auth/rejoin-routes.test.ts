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
import {
  generateRefreshToken,
  generateRejoinSecret,
  hashRefreshToken,
  hashRejoinSecret,
} from './tokens.js';

/** The invitee device's per-device rejoin secret (provisioned hash in fixture). */
const INVITEE_REJOIN_SECRET = generateRejoinSecret();

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
    .prepare('UPDATE devices SET rejoin_secret_hash = ? WHERE id = ?')
    .run(hashRejoinSecret(INVITEE_REJOIN_SECRET), INVITEE_DEVICE);
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

function createApp(
  fixture: Fixture,
  rateLimit?: { maxRequests: number; windowMs: number },
) {
  const config = parseServerConfig(TEST_ENV);
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database: fixture.database,
      invitations: fixture.invitations,
      now: () => new Date(fixture.clock.ms),
      ...(rateLimit === undefined ? {} : { rateLimit }),
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

function redeem(
  app: ReturnType<typeof buildApp>,
  refreshTokenHash: string,
  rejoinSecret: string = INVITEE_REJOIN_SECRET,
) {
  return app.inject({
    body: {
      deviceId: INVITEE_DEVICE,
      initialRefreshTokenHash: refreshTokenHash,
      membershipId: INVITEE_MEMBERSHIP,
      rejoinSecret,
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
        rejoinSecret: INVITEE_REJOIN_SECRET,
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

  it('returns a flat 401 for the impersonation: correct binding but wrong secret (audit #1)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    // The attacker knows the victim's membershipId + deviceId (both leak via
    // event/receipt metadata) but presents a secret they generated themselves.
    const response = await redeem(
      app,
      hashRefreshToken(generateRefreshToken()),
      generateRejoinSecret(),
    );
    expect(response.statusCode).toBe(401);

    // The grant was not consumed: the legitimate device can still redeem it.
    const legitimate = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(legitimate.statusCode).toBe(200);
  });

  it('rejects a body missing the rejoin secret with 400', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);
    const response = await app.inject({
      body: {
        deviceId: INVITEE_DEVICE,
        initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
        membershipId: INVITEE_MEMBERSHIP,
      },
      method: 'POST',
      url: '/auth/rejoin',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('rate limiting on POST /owner/rejoin-grants', () => {
  it('429s once one client exceeds the owner grant threshold', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, { maxRequests: 2, windowMs: 60_000 });

    // Even a rejected attempt costs a session lookup plus two membership
    // queries, so the limiter has to run before the handler.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await requestGrant(app, 'not-a-live-token', INVITEE_MEMBERSHIP);
      expect(response.statusCode).toBe(401);
    }

    const limited = await requestGrant(app, 'not-a-live-token', INVITEE_MEMBERSHIP);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('leaves under-threshold grant traffic unaffected', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, { maxRequests: 5, windowMs: 60_000 });

    const response = await requestGrant(
      app,
      fixture.ownerAccessToken,
      INVITEE_MEMBERSHIP,
    );
    expect(response.statusCode).toBe(200);
  });

  it('keeps the owner grant budget independent of a pre-auth rejoin flood', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, { maxRequests: 2, windowMs: 60_000 });

    // Exhaust the pre-auth /auth/rejoin bucket from the same IP …
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await redeem(app, hashRefreshToken(generateRefreshToken()));
    }
    const flooded = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(flooded.statusCode).toBe(429);

    // … and the owner's administrative path still works: a stranger's flood
    // must not lock the owner out of re-admitting a member.
    const response = await requestGrant(
      app,
      fixture.ownerAccessToken,
      INVITEE_MEMBERSHIP,
    );
    expect(response.statusCode).toBe(200);
  });
});

describe('rate limiting on POST /auth/rejoin', () => {
  it('429s once one IP exceeds the pre-auth rejoin threshold', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, { maxRequests: 3, windowMs: 60_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await redeem(app, hashRefreshToken(generateRefreshToken()));
      expect(response.statusCode).toBe(401);
    }

    const limited = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(limited.statusCode).toBe(429);
  });

  it('leaves under-threshold rejoin traffic unaffected', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, { maxRequests: 5, windowMs: 60_000 });
    await requestGrant(app, fixture.ownerAccessToken, INVITEE_MEMBERSHIP);

    const response = await redeem(app, hashRefreshToken(generateRefreshToken()));
    expect(response.statusCode).toBe(200);
  });
});
