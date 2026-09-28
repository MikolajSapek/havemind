import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { buildApp } from '../app.js';
import { BlobStore } from '../blob-store.js';
import { RevisionRepository } from '../revision-repository.js';
import { VaultWakeRegistry } from '../sync/vault-wake-registry.js';
import {
  ACCESS_TTL_SECONDS,
  createTestApp,
  deviceStatus,
  familyStatus,
  liveAccessTokenCount,
  makeTempDir,
  membershipStatus,
  openMigratedDatabase,
  openSession,
  pushRevisions,
  REFRESH_TTL_SECONDS,
  releaseTestResources,
  revisionEntry,
  revisionHeader,
  rowSeeder,
} from '../test/fixtures/server-fixtures.js';
import { InvitationService } from './invitations.js';
import { RejoinGrantService } from './rejoin-grants.js';
import { SessionRepository } from './session-repository.js';
import {
  generateRefreshToken,
  generateRejoinSecret,
  hashRefreshToken,
  hashRejoinSecret,
} from './tokens.js';

/**
 * Cross-vault isolation for a member who legitimately belongs to TWO vaults on
 * one server (roadmap P2 #9d). `sync/vault-isolation.test.ts` proves an outsider
 * of vault B cannot reach into it; this suite proves the harder case, an
 * INSIDER of both vaults must still see two separate vaults, and every
 * per-member operation (bootstrap, revocation, rejoin) must act on exactly the
 * vault it names.
 *
 * The whole suite runs against the real HTTP surface (`buildApp`) wherever the
 * route exists, so a regression in route wiring is caught alongside a
 * regression in the service SQL.
 */

const START_TIME = '2026-07-28T03:00:00.000Z';
/** Vault B is younger than vault A, so `loadFirstActiveVault` resolves A. */
const VAULT_B_TIME = '2026-07-28T04:00:00.000Z';
/**
 * The member's vault-B device is approved AFTER their vault-A device. Any
 * "most recently approved device wins" selection therefore picks the vault-B
 * device, which is exactly the bug the rejoin tests below pin down.
 */
const LATER_APPROVAL_TIME = '2026-07-28T05:00:00.000Z';

const OWNER_A_USER = 'c1000000-0000-4000-8000-0000000000a1';
const OWNER_A_DEVICE = 'c1000000-0000-4000-8000-0000000000a2';
const VAULT_A = 'c1000000-0000-4000-8000-0000000000a3';
const OWNER_A_MEMBERSHIP = 'c1000000-0000-4000-8000-0000000000a4';

const OWNER_B_USER = 'c1000000-0000-4000-8000-0000000000d1';
const OWNER_B_DEVICE = 'c1000000-0000-4000-8000-0000000000d2';
const VAULT_B = 'c1000000-0000-4000-8000-0000000000d3';
const OWNER_B_MEMBERSHIP = 'c1000000-0000-4000-8000-0000000000d4';

// Magda belongs to BOTH vaults, with one device per vault.
const MEMBER_USER = 'c1000000-0000-4000-8000-0000000000b1';
const MEMBER_A_DEVICE = 'c1000000-0000-4000-8000-0000000000b2';
const MEMBER_B_DEVICE = 'c1000000-0000-4000-8000-0000000000b3';
const MEMBER_A_MEMBERSHIP = 'c1000000-0000-4000-8000-0000000000b4';
const MEMBER_B_MEMBERSHIP = 'c1000000-0000-4000-8000-0000000000b5';

// A member of vault B and nothing else, the first-active-vault fallback case.
const SOLO_USER = 'c1000000-0000-4000-8000-0000000000e1';
const SOLO_DEVICE = 'c1000000-0000-4000-8000-0000000000e2';
const SOLO_MEMBERSHIP = 'c1000000-0000-4000-8000-0000000000e4';

/** A device onboarded before migration 007, so its vault cannot be proven. */
const LEGACY_DEVICE = 'c1000000-0000-4000-8000-0000000000f2';

const FILE_A = 'c1000000-0000-4000-8000-00000000f0a1';
const FILE_B = 'c1000000-0000-4000-8000-00000000f0b1';
const REVISION_A1 = 'c1000000-0000-4000-8000-000000000001';
const REVISION_B1 = 'c1000000-0000-4000-8000-000000000002';

const MEMBER_A_REJOIN_SECRET = generateRejoinSecret();
const MEMBER_B_REJOIN_SECRET = generateRejoinSecret();

const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(
  START_TIME,
  Buffer.alloc(32, 0x44),
);

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly familyId: string;
}

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly invitations: InvitationService;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly wakeRegistry: VaultWakeRegistry;
  readonly rejoin: RejoinGrantService;
  readonly ownerA: Actor;
  readonly ownerB: Actor;
  /** The dual-vault member seen through their vault-A device/membership. */
  readonly memberInA: Actor;
  /** The SAME person seen through their vault-B device/membership. */
  readonly memberInB: Actor;
  readonly soloInB: Actor;
}

function makeActor(
  fixture: Pick<Fixture, 'database' | 'sessions'>,
  userId: string,
  deviceId: string,
  membershipId: string,
): Actor {
  const session = openSession(fixture.database, fixture.sessions, userId, deviceId);
  return { ...session, deviceId, membershipId, userId };
}

function makeFixture(): Fixture {
  const directory = makeTempDir('havemind-multi-vault-');
  const database = openMigratedDatabase(directory);

  const now = (): Date => new Date(START_TIME);
  const ttls = {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  };
  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
  });
  const invitations = new InvitationService(database, ttls);
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });
  const rejoin = new RejoinGrantService(database, ttls);

  insertVault(database, VAULT_A, 'Vault A', START_TIME);
  insertVault(database, VAULT_B, 'Vault B', VAULT_B_TIME);

  insertUser(database, OWNER_A_USER, 'Alice (owner A)', 1);
  insertDevice(database, OWNER_A_DEVICE, OWNER_A_USER, 'Alice Laptop', { vaultId: VAULT_A });
  insertMembership(database, OWNER_A_MEMBERSHIP, VAULT_A, OWNER_A_USER, 'owner', {
    createdAt: START_TIME,
  });

  insertUser(database, OWNER_B_USER, 'Bianca (owner B)', 0);
  insertDevice(database, OWNER_B_DEVICE, OWNER_B_USER, 'Bianca Laptop', { vaultId: VAULT_B });
  insertMembership(database, OWNER_B_MEMBERSHIP, VAULT_B, OWNER_B_USER, 'owner', {
    createdAt: VAULT_B_TIME,
  });

  // The dual-vault member: one membership and one device per vault. The vault-B
  // device is approved later than the vault-A one on purpose.
  insertUser(database, MEMBER_USER, 'Magda (member of both)', 0);
  insertDevice(database, MEMBER_A_DEVICE, MEMBER_USER, 'Magda Laptop (vault A)', {
    rejoinSecretHash: hashRejoinSecret(MEMBER_A_REJOIN_SECRET),
    vaultId: VAULT_A,
  });
  insertDevice(database, MEMBER_B_DEVICE, MEMBER_USER, 'Magda Tablet (vault B)', {
    approvedAt: LATER_APPROVAL_TIME,
    rejoinSecretHash: hashRejoinSecret(MEMBER_B_REJOIN_SECRET),
    vaultId: VAULT_B,
  });
  insertMembership(database, MEMBER_A_MEMBERSHIP, VAULT_A, MEMBER_USER, 'editor', {
    createdAt: START_TIME,
  });
  insertMembership(database, MEMBER_B_MEMBERSHIP, VAULT_B, MEMBER_USER, 'editor', {
    createdAt: VAULT_B_TIME,
  });

  // A single-vault member of vault B: their bootstrap must never fall back to
  // vault A just because vault A is the older vault on the instance.
  insertUser(database, SOLO_USER, 'Sonia (vault B only)', 0);
  insertDevice(database, SOLO_DEVICE, SOLO_USER, 'Sonia Laptop', { vaultId: VAULT_B });
  insertMembership(database, SOLO_MEMBERSHIP, VAULT_B, SOLO_USER, 'editor', {
    createdAt: VAULT_B_TIME,
  });

  const base = { database, sessions };
  return {
    blobStore,
    database,
    invitations,
    memberInA: makeActor(base, MEMBER_USER, MEMBER_A_DEVICE, MEMBER_A_MEMBERSHIP),
    memberInB: makeActor(base, MEMBER_USER, MEMBER_B_DEVICE, MEMBER_B_MEMBERSHIP),
    ownerA: makeActor(base, OWNER_A_USER, OWNER_A_DEVICE, OWNER_A_MEMBERSHIP),
    ownerB: makeActor(base, OWNER_B_USER, OWNER_B_DEVICE, OWNER_B_MEMBERSHIP),
    rejoin,
    revisions,
    sessions,
    soloInB: makeActor(base, SOLO_USER, SOLO_DEVICE, SOLO_MEMBERSHIP),
    wakeRegistry: new VaultWakeRegistry(),
  };
}

function createApp(fixture: Fixture): ReturnType<typeof buildApp> {
  return createTestApp({
    database: fixture.database,
    invitations: fixture.invitations,
    now: () => new Date(START_TIME),
    sessions: fixture.sessions,
    sync: {
      blobStore: fixture.blobStore,
      database: fixture.database,
      revisions: fixture.revisions,
      wakeRegistry: fixture.wakeRegistry,
      waitTimeoutMs: 200,
    },
  });
}

function push(
  app: ReturnType<typeof buildApp>,
  actor: Actor,
  vaultId: string,
  revisionId: string,
  fileId: string,
  content: string,
) {
  return pushRevisions(app, actor.accessToken, vaultId, [
    revisionEntry(
      revisionHeader(vaultId, actor, revisionId, fileId),
      `${vaultId}:${revisionId}`,
      content,
    ),
  ]);
}

function getEvents(
  app: ReturnType<typeof buildApp>,
  actor: Actor,
  vaultId: string,
) {
  return app.inject({
    headers: { authorization: `Bearer ${actor.accessToken}` },
    method: 'GET',
    url: `/vaults/${vaultId}/events`,
  });
}

/** `GET /bootstrap` as the client does it: refresh token in a header. */
function bootstrap(
  app: ReturnType<typeof buildApp>,
  actor: Actor,
  vaultId?: string,
) {
  return app.inject({
    headers: { 'x-havemind-refresh-token': actor.refreshToken },
    method: 'GET',
    url: vaultId === undefined ? '/bootstrap' : `/bootstrap?vault=${vaultId}`,
  });
}

function bootstrapFileIds(response: { json: () => unknown }): string[] {
  const body = response.json() as { items: Array<{ fileId: string }> };
  return body.items.map((item) => item.fileId);
}

afterEach(releaseTestResources);

describe('multi-vault isolation: revision visibility', () => {
  it('never surfaces a vault-A revision in vault B events, and keeps it readable in A', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const pushed = await push(
      app,
      fixture.ownerA,
      VAULT_A,
      REVISION_A1,
      FILE_A,
      'only-in-vault-A',
    );
    expect(pushed.statusCode).toBe(200);

    // Vault B's own owner sees an empty, cursor-zero vault.
    const eventsB = await getEvents(app, fixture.ownerB, VAULT_B);
    expect(eventsB.statusCode).toBe(200);
    expect(eventsB.json()).toEqual({ cursor: 0, events: [] });

    // The revision is present in vault A, so the emptiness above is isolation,
    // never loss, and the row is scoped to vault A in storage.
    const eventsA = await getEvents(app, fixture.ownerA, VAULT_A);
    expect(eventsA.statusCode).toBe(200);
    const bodyA = eventsA.json() as { events: Array<{ revisionId: string }> };
    expect(bodyA.events.map((event) => event.revisionId)).toEqual([REVISION_A1]);
    const rows = fixture.database
      .prepare('SELECT COUNT(*) AS count FROM revisions WHERE vault_id = ?')
      .get(VAULT_B) as { count: number };
    expect(rows.count).toBe(0);
  });

  it('serves a dual-vault member only the named vault: B bootstrap omits vault-A work', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // The same person pushes into each of their vaults.
    expect(
      (await push(app, fixture.memberInA, VAULT_A, REVISION_A1, FILE_A, 'work-in-A'))
        .statusCode,
    ).toBe(200);
    expect(
      (await push(app, fixture.memberInB, VAULT_B, REVISION_B1, FILE_B, 'work-in-B'))
        .statusCode,
    ).toBe(200);

    // Being an insider of BOTH vaults must not merge them: naming vault B
    // serves vault B's file and nothing from vault A.
    const inB = await bootstrap(app, fixture.memberInB, VAULT_B);
    expect(inB.statusCode).toBe(200);
    expect(bootstrapFileIds(inB)).toEqual([FILE_B]);

    // ...and symmetrically for vault A, so neither direction leaks.
    const inA = await bootstrap(app, fixture.memberInA, VAULT_A);
    expect(inA.statusCode).toBe(200);
    expect(bootstrapFileIds(inA)).toEqual([FILE_A]);
  });

  it('resolves the single vault a member actually belongs to when no ?vault= is sent', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    expect(
      (await push(app, fixture.ownerA, VAULT_A, REVISION_A1, FILE_A, 'work-in-A'))
        .statusCode,
    ).toBe(200);
    expect(
      (await push(app, fixture.ownerB, VAULT_B, REVISION_B1, FILE_B, 'work-in-B'))
        .statusCode,
    ).toBe(200);

    // Vault A is the OLDER vault on the instance, so a fallback that ignored
    // membership would serve it. The single-vault member must get vault B only.
    const served = await bootstrap(app, fixture.soloInB);
    expect(served.statusCode).toBe(200);
    expect(bootstrapFileIds(served)).toEqual([FILE_B]);

    // Naming vault A explicitly is refused rather than silently downgraded.
    const named = await bootstrap(app, fixture.soloInB, VAULT_A);
    expect(named.statusCode).toBe(403);
    expect(JSON.stringify(named.json())).not.toContain(FILE_A);
  });
});

describe('multi-vault isolation: membership revocation over HTTP', () => {
  it('revoking the vault-A membership leaves the vault-B device and session alive', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const revoked = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'POST',
      url: `/owner/memberships/${MEMBER_A_MEMBERSHIP}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({
      membershipId: MEMBER_A_MEMBERSHIP,
      status: 'revoked',
    });

    // Vault A access is terminally gone: device burned, session dead.
    expect(membershipStatus(fixture, MEMBER_A_MEMBERSHIP)).toBe('revoked');
    expect(deviceStatus(fixture, MEMBER_A_DEVICE)).toBe('revoked');
    expect(familyStatus(fixture, fixture.memberInA.familyId)).toBe('revoked');
    expect(liveAccessTokenCount(fixture, MEMBER_A_DEVICE)).toBe(0);
    const afterInA = await getEvents(app, fixture.memberInA, VAULT_A);
    expect(afterInA.statusCode).toBe(401);

    // Vault B is untouched, the complement of the AUD2-04 service test, proven
    // end to end: the same person still syncs their other vault.
    expect(membershipStatus(fixture, MEMBER_B_MEMBERSHIP)).toBe('active');
    expect(deviceStatus(fixture, MEMBER_B_DEVICE)).toBe('approved');
    expect(familyStatus(fixture, fixture.memberInB.familyId)).toBe('active');
    expect(liveAccessTokenCount(fixture, MEMBER_B_DEVICE)).toBe(1);
    const afterInB = await getEvents(app, fixture.memberInB, VAULT_B);
    expect(afterInB.statusCode).toBe(200);
    const stillBootstraps = await bootstrap(app, fixture.memberInB, VAULT_B);
    expect(stillBootstraps.statusCode).toBe(200);
  });
});

describe('multi-vault isolation: rejoin grants bind within their own vault', () => {
  it('binds a vault-A grant to the vault-A device, never the newer vault-B device', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const granted = await app.inject({
      body: { membershipId: MEMBER_A_MEMBERSHIP },
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'POST',
      url: '/owner/rejoin-grants',
    });

    expect(granted.statusCode).toBe(200);
    const body = granted.json() as { boundDeviceId: string; membershipId: string };
    expect(body.membershipId).toBe(MEMBER_A_MEMBERSHIP);
    // Owner A administers vault A only. Binding the member's vault-B device
    // would let a vault-A grant hand out a session on a device owner A has no
    // authority over, and the vault-B device is the most recently approved, so
    // an unscoped "newest device wins" selection picks exactly the wrong one.
    expect(body.boundDeviceId).toBe(MEMBER_A_DEVICE);
    expect(body.boundDeviceId).not.toBe(MEMBER_B_DEVICE);
    const stored = fixture.database
      .prepare(
        'SELECT device_id AS deviceId FROM rejoin_grants WHERE membership_id = ?',
      )
      .get(MEMBER_A_MEMBERSHIP) as { deviceId: string };
    expect(stored.deviceId).toBe(MEMBER_A_DEVICE);
  });

  it('lets only the vault-A device redeem a vault-A grant, resuming vault A', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const granted = await app.inject({
      body: { membershipId: MEMBER_A_MEMBERSHIP },
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'POST',
      url: '/owner/rejoin-grants',
    });
    expect(granted.statusCode).toBe(200);

    // The member's OTHER vault's device presents its own valid secret. It is
    // not the device this grant belongs to, so it is refused (flat 401).
    const wrongVaultDevice = await app.inject({
      body: {
        deviceId: MEMBER_B_DEVICE,
        initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
        membershipId: MEMBER_A_MEMBERSHIP,
        rejoinSecret: MEMBER_B_REJOIN_SECRET,
      },
      method: 'POST',
      url: '/auth/rejoin',
    });
    expect(wrongVaultDevice.statusCode).toBe(401);

    // The vault-A device redeems and comes back into vault A, not vault B.
    const rightDevice = await app.inject({
      body: {
        deviceId: MEMBER_A_DEVICE,
        initialRefreshTokenHash: hashRefreshToken(generateRefreshToken()),
        membershipId: MEMBER_A_MEMBERSHIP,
        rejoinSecret: MEMBER_A_REJOIN_SECRET,
      },
      method: 'POST',
      url: '/auth/rejoin',
    });
    expect(rightDevice.statusCode).toBe(200);
    expect(rightDevice.json()).toMatchObject({
      deviceId: MEMBER_A_DEVICE,
      membershipId: MEMBER_A_MEMBERSHIP,
      status: 'rejoined',
      vaultId: VAULT_A,
    });
  });

  it('binds a vault-B grant to the vault-B device (scoping, not device ordering)', async () => {
    const fixture = makeFixture();

    const grant = fixture.rejoin.createGrant({
      ownerMembershipId: OWNER_B_MEMBERSHIP,
      targetMembershipId: MEMBER_B_MEMBERSHIP,
    });

    expect(grant.boundDeviceId).toBe(MEMBER_B_DEVICE);
  });

  it('still binds a legacy unscoped device when the member has no scoped one', () => {
    const fixture = makeFixture();
    // Magda's vault-A device predates migration 007, so its vault cannot be
    // proven. Rejoin must keep working for it rather than fail closed, exactly
    // as it did before the scope column existed.
    fixture.database
      .prepare('UPDATE devices SET vault_id = NULL WHERE id = ?')
      .run(MEMBER_A_DEVICE);

    const grant = fixture.rejoin.createGrant({
      ownerMembershipId: OWNER_A_MEMBERSHIP,
      targetMembershipId: MEMBER_A_MEMBERSHIP,
    });

    expect(grant.boundDeviceId).toBe(MEMBER_A_DEVICE);
  });

  it('prefers the vault-scoped device over a legacy unscoped one approved later', () => {
    const fixture = makeFixture();
    // An unscoped device of the same member, approved most recently of all. A
    // device whose vault is proven to be A must still win, so the ambiguous
    // legacy row is only ever a last resort.
    insertDevice(fixture.database, LEGACY_DEVICE, MEMBER_USER, 'Magda Old Laptop (no scope)', {
      approvedAt: LATER_APPROVAL_TIME,
      vaultId: null,
    });

    const grant = fixture.rejoin.createGrant({
      ownerMembershipId: OWNER_A_MEMBERSHIP,
      targetMembershipId: MEMBER_A_MEMBERSHIP,
    });

    expect(grant.boundDeviceId).toBe(MEMBER_A_DEVICE);
  });
});
