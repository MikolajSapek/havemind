import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { DEFAULT_VAULT_QUOTA_BYTES, parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { createRateLimiter, defaultClientKey } from './auth-routes.js';
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
      quotaBytes: DEFAULT_VAULT_QUOTA_BYTES,
      role: 'owner',
      storageBytes: 0,
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

  it('resolves the session at most once per authenticated request through the limited scope', async () => {
    const fixture = makeFixture();
    const lookupAccess = vi.spyOn(fixture.sessions, 'lookupAccess');
    const app = createApp(fixture, { useFixedClientKey: false });

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(200);
    // The onRequest rate limiter and the preHandler auth guard both sit in
    // front of this route; without the shared stash each would repeat the
    // 4-table `lookupAccess` join for the same token.
    expect(lookupAccess).toHaveBeenCalledTimes(1);
  });

  it('does not call lookupAccess for an unauthenticated request', async () => {
    const fixture = makeFixture();
    const lookupAccess = vi.spyOn(fixture.sessions, 'lookupAccess');
    const app = createApp(fixture, { useFixedClientKey: false });

    const response = await app.inject({
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(401);
    expect(lookupAccess).not.toHaveBeenCalled();
  });

  it('still authenticates correctly on a route outside the rate limiter scope', async () => {
    // A custom `clientKey` (as used by most fixtures here) never populates
    // the stash, so the preHandler must fall back to its own lookup, this
    // is the same fallback a route registered outside the limited scope
    // would hit. Exactly one lookup still happens, just from the preHandler.
    const fixture = makeFixture();
    const lookupAccess = vi.spyOn(fixture.sessions, 'lookupAccess');
    const app = createApp(fixture);

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/members`,
    });

    expect(response.statusCode).toBe(200);
    expect(lookupAccess).toHaveBeenCalledTimes(1);
  });
});

/**
 * GAP-4: the long-poll wake endpoint `GET /vaults/:vaultId/wait` reconnects
 * roughly every 25s and is not a mutation, so it must be exempt from the
 * per-device rate-limit bucket the same way blob GET already is (AUD-08),
 * otherwise a reconnect storm (`/auth/refresh` + `/wait` + pull on every
 * iteration) can momentarily exhaust the 120-req/60s bucket and 429 the
 * held long-poll. There is no real Fastify route registered at this pattern
 * in this build (buildApp's test fixture never wires `deps.sync`, and the
 * route itself lives outside this module's scope), so, unlike the blob-GET
 * exemption test in `sync-routes.test.ts`, which drives a real registered
 * route through `app.inject`, these tests drive `defaultClientKey` and
 * `createRateLimiter` directly. `request.routeOptions?.url` reflects the
 * Fastify route *pattern* regardless of whether the handler exists, so this
 * exercises the exact production code path the real route would hit.
 */
describe('GAP-4 long-poll wait rate-limit exemption', () => {
  const WAIT_ROUTE = '/vaults/:vaultId/wait';
  const MEMBERS_ROUTE = '/vaults/:vaultId/members';
  const REVISIONS_ROUTE = '/vaults/:vaultId/revisions';

  function fakeRequest(options: {
    readonly authorization?: string;
    readonly method: string;
    readonly routeUrl: string;
  }): FastifyRequest {
    return {
      headers:
        options.authorization === undefined
          ? {}
          : { authorization: options.authorization },
      ip: '127.0.0.1',
      method: options.method,
      routeOptions: { url: options.routeUrl },
    } as unknown as FastifyRequest;
  }

  function fakeReply(): FastifyReply & { statusCode: number | null } {
    const reply = {
      code(status: number) {
        reply.statusCode = status;
        return reply;
      },
      header() {
        return reply;
      },
      send() {
        return reply;
      },
      statusCode: null as number | null,
    };
    return reply as unknown as FastifyReply & { statusCode: number | null };
  }

  it('exempts GET /vaults/:vaultId/wait from the per-device bucket', () => {
    const fixture = makeFixture();
    const clientKey = defaultClientKey(fixture.sessions);

    const key = clientKey(
      fakeRequest({
        authorization: `Bearer ${fixture.accessTokenA}`,
        method: 'GET',
        routeUrl: WAIT_ROUTE,
      }),
    );

    expect(key).toBeNull();
  });

  it('still keys a non-exempt authenticated GET route to the device bucket', () => {
    const fixture = makeFixture();
    const clientKey = defaultClientKey(fixture.sessions);

    const key = clientKey(
      fakeRequest({
        authorization: `Bearer ${fixture.accessTokenA}`,
        method: 'GET',
        routeUrl: MEMBERS_ROUTE,
      }),
    );

    expect(key).toBe(`device:${DEVICE_A}`);
  });

  it('does not exempt POST /vaults/:vaultId/revisions (mutations stay in-bucket)', () => {
    const fixture = makeFixture();
    const clientKey = defaultClientKey(fixture.sessions);

    const key = clientKey(
      fakeRequest({
        authorization: `Bearer ${fixture.accessTokenA}`,
        method: 'POST',
        routeUrl: REVISIONS_ROUTE,
      }),
    );

    expect(key).toBe(`device:${DEVICE_A}`);
  });

  it('does not exempt a POST to the /wait route pattern (GET-only exemption)', () => {
    const fixture = makeFixture();
    const clientKey = defaultClientKey(fixture.sessions);

    const key = clientKey(
      fakeRequest({
        authorization: `Bearer ${fixture.accessTokenA}`,
        method: 'POST',
        routeUrl: WAIT_ROUTE,
      }),
    );

    expect(key).toBe(`device:${DEVICE_A}`);
  });

  it('a burst of GET /wait requests beyond the bucket limit is never rate limited', () => {
    const fixture = makeFixture();
    const limiter = createRateLimiter(
      { maxRequests: 2, windowMs: 60_000 },
      () => new Date(START_TIME),
      defaultClientKey(fixture.sessions),
    );
    const request = fakeRequest({
      authorization: `Bearer ${fixture.accessTokenA}`,
      method: 'GET',
      routeUrl: WAIT_ROUTE,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reply = fakeReply();
      limiter(request, reply);
      expect(reply.statusCode).toBeNull();
    }
  });

  it('a burst of a non-exempt GET route beyond the bucket limit still 429s (exemption stays narrow)', () => {
    const fixture = makeFixture();
    const limiter = createRateLimiter(
      { maxRequests: 2, windowMs: 60_000 },
      () => new Date(START_TIME),
      defaultClientKey(fixture.sessions),
    );
    const request = fakeRequest({
      authorization: `Bearer ${fixture.accessTokenA}`,
      method: 'GET',
      routeUrl: MEMBERS_ROUTE,
    });

    const statusCodes: Array<number | null> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const reply = fakeReply();
      limiter(request, reply);
      statusCodes.push(reply.statusCode);
    }

    expect(statusCodes).toEqual([null, null, 429, 429]);
  });
});

/**
 * AUD2-01: the limiter's `windows` map kept one entry per key forever, so a
 * long-lived process accumulated one dead bucket per distinct IP/device that
 * ever hit it. The fix is a lazy sweep on access (no timer, nothing that can
 * outlive the limiter's owner, matching the plugin's `scheduler-hooks.ts`
 * discipline). `trackedKeys` exposes the map's size so the eviction is
 * observable without reaching into the closure.
 */
describe('AUD2-01 rate-limiter window eviction', () => {
  function fakeRequest(ip: string): FastifyRequest {
    return {
      headers: {},
      ip,
      method: 'GET',
      routeOptions: { url: '/vaults/:vaultId/members' },
    } as unknown as FastifyRequest;
  }

  function fakeReply(): FastifyReply {
    const reply = {
      code() {
        return reply;
      },
      header() {
        return reply;
      },
      send() {
        return reply;
      },
    };
    return reply as unknown as FastifyReply;
  }

  function makeLimiter(clock: { ms: number }): ReturnType<typeof createRateLimiter> {
    return createRateLimiter(
      { maxRequests: 120, windowMs: 60_000 },
      () => new Date(clock.ms),
      (request) => request.ip,
    );
  }

  it('drops windows that expired before the current request', () => {
    const clock = { ms: 0 };
    const limiter = makeLimiter(clock);

    for (let index = 0; index < 50; index += 1) {
      limiter(fakeRequest(`10.0.0.${index}`), fakeReply());
    }
    expect(limiter.trackedKeys()).toBe(50);

    // One request a full window later: every earlier bucket is dead.
    clock.ms = 60_001;
    limiter(fakeRequest('10.0.1.1'), fakeReply());

    expect(limiter.trackedKeys()).toBe(1);
  });

  it('keeps windows that are still live', () => {
    const clock = { ms: 0 };
    const limiter = makeLimiter(clock);

    limiter(fakeRequest('10.0.0.1'), fakeReply());
    clock.ms = 30_000;
    limiter(fakeRequest('10.0.0.2'), fakeReply());

    expect(limiter.trackedKeys()).toBe(2);
  });

  it('still counts a live window across the sweep', () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter(
      { maxRequests: 2, windowMs: 60_000 },
      () => new Date(clock.ms),
      (request) => request.ip,
    );

    limiter(fakeRequest('10.0.0.1'), fakeReply());
    clock.ms = 10_000;
    limiter(fakeRequest('10.0.0.9'), fakeReply());
    clock.ms = 20_000;
    limiter(fakeRequest('10.0.0.1'), fakeReply());

    let limited = false;
    const reply = {
      code(status: number) {
        limited = status === 429;
        return reply;
      },
      header() {
        return reply;
      },
      send() {
        return reply;
      },
    } as unknown as FastifyReply;
    limiter(fakeRequest('10.0.0.1'), reply);

    expect(limited).toBe(true);
  });
});
