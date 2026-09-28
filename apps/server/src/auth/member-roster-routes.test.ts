/**
 * GET /members, the vault roster served from the server.
 *
 * The roster used to be assembled client-side from what a device happened to
 * witness: the owner recorded a member at the moment they approved it, and a
 * guest recorded only itself. Two people in one vault therefore saw different
 * rosters, and a guest saw a list of one. The server already holds the truth
 * in `memberships` joined to `users`; this route hands it back.
 */

import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeTempDir,
  openMigratedDatabase,
  openSession,
  releaseTestResources,
  rowSeeder,
} from '../test/fixtures/server-fixtures.js';
import { registerMemberRosterRoutes } from './member-roster-routes.js';
import { SessionRepository } from './session-repository.js';

const START = '2026-09-10T05:00:00.000Z';
const LATER = '2026-09-10T06:00:00.000Z';

const VAULT = '90000000-0000-4000-8000-0000000000a0';
const OTHER_VAULT = '90000000-0000-4000-8000-0000000000b0';

const OWNER = '90000000-0000-4000-8000-0000000000a1';
const GUEST = '90000000-0000-4000-8000-0000000000a2';
const THIRD = '90000000-0000-4000-8000-0000000000a3';
const OUTSIDER = '90000000-0000-4000-8000-0000000000a4';
const REVOKED = '90000000-0000-4000-8000-0000000000a5';

const DEVICE_OWNER = '90000000-0000-4000-8000-0000000000d1';
const DEVICE_GUEST = '90000000-0000-4000-8000-0000000000d2';
const DEVICE_THIRD = '90000000-0000-4000-8000-0000000000d3';
const DEVICE_OUTSIDER = '90000000-0000-4000-8000-0000000000d4';

afterEach(releaseTestResources);

const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(
  START,
  Buffer.from([0x01]),
);

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly refreshTokens: Record<string, string>;
}

function makeFixture(): Fixture {
  const database = openMigratedDatabase(makeTempDir('havemind-roster-'));

  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: 600,
    now: () => new Date(Date.parse(START)),
  });

  insertVault(database, VAULT, 'Shared Vault');
  insertVault(database, OTHER_VAULT, 'Someone Else');

  insertUser(database, OWNER, 'Mikolaj');
  insertUser(database, GUEST, 'Hubert');
  insertUser(database, THIRD, 'Miki telfon');
  insertUser(database, OUTSIDER, 'Nobody');
  insertUser(database, REVOKED, 'Removed Person');

  insertMembership(database, 'm-owner', VAULT, OWNER, 'owner');
  insertMembership(database, 'm-guest', VAULT, GUEST, 'editor');
  insertMembership(database, 'm-third', VAULT, THIRD, 'editor', { createdAt: LATER });
  insertMembership(database, 'm-revoked', VAULT, REVOKED, 'editor', { revokedAt: LATER });
  insertMembership(database, 'm-outsider', OTHER_VAULT, OUTSIDER, 'owner');

  // Sessions are issued through the repository, never by hand: refresh tokens
  // live in a family table with rotation state that a raw INSERT would skip.
  const refreshTokens: Record<string, string> = {};
  for (const [userId, deviceId] of [
    [OWNER, DEVICE_OWNER],
    [GUEST, DEVICE_GUEST],
    [THIRD, DEVICE_THIRD],
    [OUTSIDER, DEVICE_OUTSIDER],
  ] as const) {
    insertDevice(database, deviceId, userId, 'Device');
    refreshTokens[userId] = openSession(database, sessions, userId, deviceId).refreshToken;
  }

  return { database, refreshTokens, sessions };
}

function createApp(fixture: Fixture) {
  const app = Fastify();
  registerMemberRosterRoutes(app, {
    database: fixture.database,
    sessions: fixture.sessions,
  });
  return app;
}

async function getMembers(fixture: Fixture, userId: string, vault?: string) {
  const app = createApp(fixture);
  return app.inject({
    headers: { 'x-havemind-refresh-token': fixture.refreshTokens[userId] as string },
    method: 'GET',
    url: vault === undefined ? '/members' : `/members?vault=${vault}`,
  });
}

describe('GET /members', () => {
  it('gives a guest the same roster the owner sees', async () => {
    const fixture = makeFixture();

    const asOwner = await getMembers(fixture, OWNER);
    const asGuest = await getMembers(fixture, GUEST);

    expect(asOwner.statusCode).toBe(200);
    expect(asGuest.statusCode).toBe(200);
    // The bug this route exists for: a guest used to see only itself.
    expect(asGuest.json()).toEqual(asOwner.json());
  });

  it('names every active member, with role and membership id', async () => {
    const fixture = makeFixture();
    const response = await getMembers(fixture, GUEST);

    expect(response.json()).toEqual({
      members: [
        { displayName: 'Mikolaj', membershipId: 'm-owner', role: 'owner' },
        { displayName: 'Hubert', membershipId: 'm-guest', role: 'editor' },
        { displayName: 'Miki telfon', membershipId: 'm-third', role: 'editor' },
      ],
      version: 1,
    });
  });

  it('omits a revoked membership', async () => {
    const fixture = makeFixture();
    const response = await getMembers(fixture, OWNER);
    const names = (response.json() as { members: { displayName: string }[] }).members.map(
      (m) => m.displayName,
    );
    expect(names).not.toContain('Removed Person');
  });

  it('refuses a caller with no membership in the named vault', async () => {
    const fixture = makeFixture();
    const response = await getMembers(fixture, OUTSIDER, VAULT);
    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const response = await app.inject({ method: 'GET', url: '/members' });
    expect(response.statusCode).toBe(400);
  });

  it('never caches a roster', async () => {
    const fixture = makeFixture();
    const response = await getMembers(fixture, OWNER);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
