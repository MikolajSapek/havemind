import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { SessionRepository } from './session-repository.js';
import { generateRefreshToken } from './tokens.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const START_TIME = '2026-07-16T03:00:00.000Z';

const USER_A = '70000000-0000-4000-8000-0000000000a1';
const USER_B = '70000000-0000-4000-8000-0000000000b1';
const DEVICE_A = '70000000-0000-4000-8000-0000000000a2';
const DEVICE_B = '70000000-0000-4000-8000-0000000000b2';
const VAULT_A = '70000000-0000-4000-8000-0000000000a3';
const VAULT_B = '70000000-0000-4000-8000-0000000000b3';
const MEMBERSHIP_A = '70000000-0000-4000-8000-0000000000a4';
const MEMBERSHIP_B = '70000000-0000-4000-8000-0000000000b4';

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-auth-routes-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
  });

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

  return { accessTokenA, accessTokenB, database, sessions };
}

function collectLogs(): { writer: Writable; read: () => string } {
  const chunks: string[] = [];
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { read: () => chunks.join(''), writer };
}

function createApp(
  fixture: Fixture,
  options?: {
    loggerStream?: Writable;
    rateLimit?: { maxRequests: number; windowMs: number };
    now?: () => Date;
    /**
     * Test fixtures default to a single fixed rate-limit bucket for
     * simplicity. Pass `false` to exercise the real default `clientKey`
     * (device-keyed for authenticated requests, IP-keyed otherwise).
     */
    useFixedClientKey?: boolean;
  },
): ReturnType<typeof buildApp> {
  const config = parseServerConfig(TEST_ENV);
  const useFixedClientKey = options?.useFixedClientKey ?? true;
  const app = buildApp({
    auth: {
      ...(useFixedClientKey ? { clientKey: () => 'fixed-test-client' } : {}),
      database: fixture.database,
      sessions: fixture.sessions,
      ...(options?.now === undefined ? {} : { now: options.now }),
      ...(options?.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    },
    config,
    ...(options?.loggerStream === undefined
      ? {}
      : { loggerStream: options.loggerStream }),
  });
  applications.push(app);
  return app;
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

describe('deny-by-default auth-routes', () => {
  it('lists members for an authenticated member of the vault', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      members: [{ displayName: 'Alice', role: 'owner' }],
      role: 'owner',
      vaultId: VAULT_A,
    });
  });

  it('rejects a cross-vault IDOR attempt with 403 and no resource disclosure', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_B}/members`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain('Bob');
    expect(response.body).not.toContain(VAULT_B);
  });

  it('returns an identical response for a missing vault and a forbidden vault', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const missingVault = randomUUID();

    const forbidden = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_B}/members`,
    });
    const missing = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${missingVault}/members`,
    });

    expect(missing.statusCode).toBe(forbidden.statusCode);
    expect(missing.body).toBe(forbidden.body);
    expect(missing.headers['cache-control']).toBe(
      forbidden.headers['cache-control'],
    );
    expect(missing.headers['content-type']).toBe(
      forbidden.headers['content-type'],
    );
  });

  it('rejects a spoofed actor-id header with 403 and never logs its value', async () => {
    const fixture = makeFixture();
    const stream = collectLogs();
    const app = createApp(fixture, { loggerStream: stream.writer });

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${fixture.accessTokenA}`,
        'x-havemind-actor-id': USER_B,
      },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    expect(stream.read()).not.toContain(USER_B);
  });

  it('allows a redundant actor-id header that matches the session actor', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${fixture.accessTokenA}`,
        'x-havemind-actor-id': USER_A,
      },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects a malformed or invalid access token with 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const malformed = await app.inject({
      headers: { authorization: 'Bearer not-a-real-token' },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const wrongScheme = await app.inject({
      headers: { authorization: fixture.accessTokenA },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(malformed.statusCode).toBe(401);
    expect(wrongScheme.statusCode).toBe(401);
  });

  it('rejects a valid token for a revoked session with 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    fixture.sessions.revokeDevice(DEVICE_A);

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('enforces the rate limit before authentication and hides account existence', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, {
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
    });

    const first = await app.inject({
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const third = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    expect(third.headers['cache-control']).toBe('no-store');
    expect(third.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(third.body).not.toContain('Alice');
    expect(third.body).not.toContain('UNAUTHENTICATED');
  });

  it('resets the rate-limit window after it elapses', async () => {
    const fixture = makeFixture();
    let current = Date.parse(START_TIME);
    const app = createApp(fixture, {
      now: () => new Date(current),
      rateLimit: { maxRequests: 1, windowMs: 1_000 },
    });

    const first = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const limited = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    current += 2_000;
    const afterWindow = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(afterWindow.statusCode).toBe(200);
  });

  it('keys the rate-limit bucket per authenticated device, not the shared IP', async () => {
    // Behind Tailscale serve (trustProxy: false), every request in this test
    // arrives from the same loopback IP, mirroring production. Device A
    // exhausting its own bucket must not 429 device B on the same tunnel.
    const fixture = makeFixture();
    const app = createApp(fixture, {
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
      useFixedClientKey: false,
    });

    const deviceAFirst = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const deviceAExhausted = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const deviceBFirst = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenB}` },
      method: 'GET',
      url: `/vaults/${VAULT_B}/members`,
    });

    expect(deviceAFirst.statusCode).toBe(200);
    expect(deviceAExhausted.statusCode).toBe(429);
    expect(deviceBFirst.statusCode).toBe(200);
  });

  it('still shares a single IP-keyed bucket for unauthenticated requests', async () => {
    // Brute-force protection on pairing/approval-style endpoints depends on
    // IP-keying holding for requests with no valid session.
    const fixture = makeFixture();
    const app = createApp(fixture, {
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
      useFixedClientKey: false,
    });

    const first = await app.inject({
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });
    const second = await app.inject({
      headers: { authorization: 'Bearer not-a-real-token' },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(429);
  });
});
