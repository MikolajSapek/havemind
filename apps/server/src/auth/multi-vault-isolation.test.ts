import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type ProtectedRevisionHeader } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { BlobStore } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';
import { VaultWakeRegistry } from '../sync/vault-wake-registry.js';
import { InvitationService } from './invitations.js';
import { RejoinGrantService } from './rejoin-grants.js';
import { SessionRepository } from './session-repository.js';
import {
  generateRefreshToken,
  generateRejoinSecret,
  hashRefreshToken,
  hashRejoinSecret,
  type RejoinSecret,
} from './tokens.js';

/**
 * Cross-vault isolation for a member who legitimately belongs to TWO vaults on
 * one server (roadmap P2 #9d). `sync/vault-isolation.test.ts` proves an outsider
 * of vault B cannot reach into it; this suite proves the harder case — an
 * INSIDER of both vaults must still see two separate vaults, and every
 * per-member operation (bootstrap, revocation, rejoin) must act on exactly the
 * vault it names.
 *
 * The whole suite runs against the real HTTP surface (`buildApp`) wherever the
 * route exists, so a regression in route wiring is caught alongside a
 * regression in the service SQL.
 */

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const START_TIME = '2026-07-28T03:00:00.000Z';
/** Vault B is younger than vault A, so `loadFirstActiveVault` resolves A. */
const VAULT_B_TIME = '2026-07-28T04:00:00.000Z';
/**
 * The member's vault-B device is approved AFTER their vault-A device. Any
 * "most recently approved device wins" selection therefore picks the vault-B
 * device — which is exactly the bug the rejoin tests below pin down.
 */
const LATER_APPROVAL_TIME = '2026-07-28T05:00:00.000Z';
const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

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

// A member of vault B and nothing else — the first-active-vault fallback case.
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

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

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

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function insertUser(
  database: Database.Database,
  id: string,
  name: string,
  isInstanceOwner: 0 | 1,
): void {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, NULL)`,
    )
    .run(id, name, isInstanceOwner, START_TIME);
}

function insertVault(
  database: Database.Database,
  id: string,
  name: string,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, ?, 0, 1, ?, NULL)`,
    )
    .run(id, name, createdAt);
}

function insertMembership(
  database: Database.Database,
  id: string,
  vaultId: string,
  userId: string,
  role: 'owner' | 'editor',
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
    )
    .run(id, vaultId, userId, role, createdAt);
}

/**
 * Inserts an approved device. `vaultId` is the migration-007 scope: `null`
 * models a device onboarded before the column existed, whose vault cannot be
 * proven. `approvedAt` is explicit because the rejoin binding orders on it.
 */
function insertDevice(
  database: Database.Database,
  options: {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly vaultId: string | null;
    readonly approvedAt?: string;
    readonly rejoinSecret?: RejoinSecret;
  },
): void {
  database
    .prepare(
      `INSERT INTO devices (
         id, user_id, display_name, public_key, status,
         created_at, approved_at, revoked_at, rejoin_secret_hash, vault_id
       ) VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL, ?, ?)`,
    )
    .run(
      options.id,
      options.userId,
      options.name,
      Buffer.alloc(32, 0x44),
      START_TIME,
      options.approvedAt ?? START_TIME,
      options.rejoinSecret === undefined
        ? null
        : hashRejoinSecret(options.rejoinSecret),
      options.vaultId,
    );
}

/** Opens a live session, keeping the raw refresh token the client would hold. */
function openSession(
  database: Database.Database,
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): { accessToken: string; refreshToken: string; familyId: string } {
  const refreshToken = generateRefreshToken();
  const issued = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId,
      initialRefreshToken: refreshToken,
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId,
    }),
  );
  const result = issued.immediate();
  return {
    accessToken: result.accessToken,
    familyId: result.familyId,
    refreshToken,
  };
}

function makeActor(
  fixture: Pick<Fixture, 'database' | 'sessions'>,
  userId: string,
  deviceId: string,
  membershipId: string,
): Actor {
  const session = openSession(
    fixture.database,
    fixture.sessions,
    userId,
    deviceId,
  );
  return { ...session, deviceId, membershipId, userId };
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-multi-vault-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
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
  const rejoin = new RejoinGrantService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });

  insertVault(database, VAULT_A, 'Vault A', START_TIME);
  insertVault(database, VAULT_B, 'Vault B', VAULT_B_TIME);

  insertUser(database, OWNER_A_USER, 'Alice (owner A)', 1);
  insertDevice(database, {
    id: OWNER_A_DEVICE,
    name: 'Alice Laptop',
    userId: OWNER_A_USER,
    vaultId: VAULT_A,
  });
  insertMembership(
    database,
    OWNER_A_MEMBERSHIP,
    VAULT_A,
    OWNER_A_USER,
    'owner',
    START_TIME,
  );

  insertUser(database, OWNER_B_USER, 'Bianca (owner B)', 0);
  insertDevice(database, {
    id: OWNER_B_DEVICE,
    name: 'Bianca Laptop',
    userId: OWNER_B_USER,
    vaultId: VAULT_B,
  });
  insertMembership(
    database,
    OWNER_B_MEMBERSHIP,
    VAULT_B,
    OWNER_B_USER,
    'owner',
    VAULT_B_TIME,
  );

  // The dual-vault member: one membership and one device per vault. The vault-B
  // device is approved later than the vault-A one on purpose.
  insertUser(database, MEMBER_USER, 'Magda (member of both)', 0);
  insertDevice(database, {
    id: MEMBER_A_DEVICE,
    name: 'Magda Laptop (vault A)',
    rejoinSecret: MEMBER_A_REJOIN_SECRET,
    userId: MEMBER_USER,
    vaultId: VAULT_A,
  });
  insertDevice(database, {
    approvedAt: LATER_APPROVAL_TIME,
    id: MEMBER_B_DEVICE,
    name: 'Magda Tablet (vault B)',
    rejoinSecret: MEMBER_B_REJOIN_SECRET,
    userId: MEMBER_USER,
    vaultId: VAULT_B,
  });
  insertMembership(
    database,
    MEMBER_A_MEMBERSHIP,
    VAULT_A,
    MEMBER_USER,
    'editor',
    START_TIME,
  );
  insertMembership(
    database,
    MEMBER_B_MEMBERSHIP,
    VAULT_B,
    MEMBER_USER,
    'editor',
    VAULT_B_TIME,
  );

  // A single-vault member of vault B: their bootstrap must never fall back to
  // vault A just because vault A is the older vault on the instance.
  insertUser(database, SOLO_USER, 'Sonia (vault B only)', 0);
  insertDevice(database, {
    id: SOLO_DEVICE,
    name: 'Sonia Laptop',
    userId: SOLO_USER,
    vaultId: VAULT_B,
  });
  insertMembership(
    database,
    SOLO_MEMBERSHIP,
    VAULT_B,
    SOLO_USER,
    'editor',
    VAULT_B_TIME,
  );

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
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
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
    },
    config: parseServerConfig(TEST_ENV),
  });
  applications.push(app);
  return app;
}

function header(
  vaultId: string,
  actor: Actor,
  revisionId: string,
  fileId: string,
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: actor.deviceId,
    expectedMemberId: actor.membershipId,
    fileId,
    parentRevisionIds: [],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId,
  };
}

function push(
  app: ReturnType<typeof buildApp>,
  actor: Actor,
  vaultId: string,
  revisionId: string,
  fileId: string,
  content: string,
) {
  return app.inject({
    headers: { authorization: `Bearer ${actor.accessToken}` },
    method: 'POST',
    payload: {
      revisions: [
        {
          header: header(vaultId, actor, revisionId, fileId),
          idempotencyKey: `${vaultId}:${revisionId}`,
          payload: Buffer.from(content, 'utf8').toString('base64'),
        },
      ],
    },
    url: `/vaults/${vaultId}/revisions`,
  });
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

function deviceStatus(fixture: Fixture, deviceId: string): string {
  return (
    fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(deviceId) as { status: string }
  ).status;
}

function familyStatus(fixture: Fixture, familyId: string): string {
  return (
    fixture.database
      .prepare('SELECT status FROM refresh_token_families WHERE id = ?')
      .get(familyId) as { status: string }
  ).status;
}

function membershipStatus(fixture: Fixture, membershipId: string): string {
  return (
    fixture.database
      .prepare('SELECT status FROM memberships WHERE id = ?')
      .get(membershipId) as { status: string }
  ).status;
}

function liveAccessTokenCount(fixture: Fixture, deviceId: string): number {
  return (
    fixture.database
      .prepare(
        `SELECT COUNT(*) AS live FROM access_tokens
         WHERE device_id = ? AND revoked_at IS NULL`,
      )
      .get(deviceId) as { live: number }
  ).live;
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

    // Vault B is untouched — the complement of the AUD2-04 service test, proven
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
    // authority over — and the vault-B device is the most recently approved, so
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
    insertDevice(fixture.database, {
      approvedAt: LATER_APPROVAL_TIME,
      id: LEGACY_DEVICE,
      name: 'Magda Old Laptop (no scope)',
      userId: MEMBER_USER,
      vaultId: null,
    });

    const grant = fixture.rejoin.createGrant({
      ownerMembershipId: OWNER_A_MEMBERSHIP,
      targetMembershipId: MEMBER_A_MEMBERSHIP,
    });

    expect(grant.boundDeviceId).toBe(MEMBER_A_DEVICE);
  });
});
