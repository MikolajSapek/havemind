import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashBlob,
  PROTOCOL_VERSION,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { InvitationService } from '../auth/invitations.js';
import { SessionRepository } from '../auth/session-repository.js';
import { OwnerSetupService } from '../auth/setup.js';
import { generateRefreshToken } from '../auth/tokens.js';
import { BlobStore } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';
import { VaultWakeRegistry } from './vault-wake-registry.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const START_TIME = '2026-07-26T03:00:00.000Z';
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 600;

// Vault A is the instance-owner vault, built via direct SQL. Vault B is built
// through OwnerSetupService.createVault (Phase 1) so the isolation guarantees
// are proven against a genuinely independent second vault + owner, not a
// hand-forged clone.
const OWNER_A_USER = 'a0000000-0000-4000-8000-0000000000a1';
const OWNER_A_DEVICE = 'a0000000-0000-4000-8000-0000000000a2';
const VAULT_A = 'a0000000-0000-4000-8000-0000000000a3';
const OWNER_A_MEMBERSHIP = 'a0000000-0000-4000-8000-0000000000a4';
const MEMBER_A_USER = 'a0000000-0000-4000-8000-0000000000b1';
const MEMBER_A_DEVICE = 'a0000000-0000-4000-8000-0000000000b2';
const MEMBER_A_MEMBERSHIP = 'a0000000-0000-4000-8000-0000000000b4';

// Owner B's device is inserted after createVault (which mints only the user +
// membership + pairing). Member B is inserted directly into vault B.
const OWNER_B_DEVICE = 'b0000000-0000-4000-8000-0000000000a2';
const MEMBER_B_USER = 'b0000000-0000-4000-8000-0000000000b1';
const MEMBER_B_DEVICE = 'b0000000-0000-4000-8000-0000000000b2';
const MEMBER_B_MEMBERSHIP = 'b0000000-0000-4000-8000-0000000000b4';

const FILE_A = 'a0000000-0000-4000-8000-0000000000f1';
const FILE_B = 'b0000000-0000-4000-8000-0000000000f1';
const REVISION_A1 = 'a0000000-0000-4000-8000-000000000001';
const REVISION_B1 = 'b0000000-0000-4000-8000-000000000001';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface VaultActor {
  readonly userId: string;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly accessToken: string;
}

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly invitations: InvitationService;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly wakeRegistry: VaultWakeRegistry;
  readonly vaultB: string;
  readonly ownerA: VaultActor;
  readonly memberA: VaultActor;
  readonly ownerB: VaultActor;
  readonly memberB: VaultActor;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];
const wakeRegistries: Array<{
  readonly registry: VaultWakeRegistry;
  readonly vaultIds: readonly string[];
}> = [];

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
  role: 'owner' | 'editor',
): void {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
    )
    .run(id, vaultId, userId, role, START_TIME);
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-vault-isolation-'));
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
  const setup = new OwnerSetupService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });
  const wakeRegistry = new VaultWakeRegistry();

  // Vault A: instance owner + an editor member, built directly.
  insertUser(database, OWNER_A_USER, 'Alice (owner A)', 1);
  insertDevice(database, OWNER_A_DEVICE, OWNER_A_USER, 'Alice Laptop');
  insertVault(database, VAULT_A, 'Vault A');
  insertMembership(database, OWNER_A_MEMBERSHIP, VAULT_A, OWNER_A_USER, 'owner');
  insertUser(database, MEMBER_A_USER, 'Amir (member A)', 0);
  insertDevice(database, MEMBER_A_DEVICE, MEMBER_A_USER, 'Amir Laptop');
  insertMembership(database, MEMBER_A_MEMBERSHIP, VAULT_A, MEMBER_A_USER, 'editor');

  // Vault B: a genuinely independent vault + owner minted by Phase 1's
  // createVault. Owner B is NOT the instance owner and has no relationship to
  // vault A. We then give owner B an approved device + session, and add an
  // ordinary member B.
  const createdB = setup.createVault({
    ownerDisplayName: 'Bianca (owner B)',
    vaultDisplayName: 'Vault B',
  });
  insertDevice(database, OWNER_B_DEVICE, createdB.ownerUserId, 'Bianca Laptop');
  insertUser(database, MEMBER_B_USER, 'Bruno (member B)', 0);
  insertDevice(database, MEMBER_B_DEVICE, MEMBER_B_USER, 'Bruno Laptop');
  insertMembership(
    database,
    MEMBER_B_MEMBERSHIP,
    createdB.vaultId,
    MEMBER_B_USER,
    'editor',
  );

  const ownerA: VaultActor = {
    accessToken: mintAccessToken(database, sessions, OWNER_A_USER, OWNER_A_DEVICE),
    deviceId: OWNER_A_DEVICE,
    membershipId: OWNER_A_MEMBERSHIP,
    userId: OWNER_A_USER,
  };
  const memberA: VaultActor = {
    accessToken: mintAccessToken(database, sessions, MEMBER_A_USER, MEMBER_A_DEVICE),
    deviceId: MEMBER_A_DEVICE,
    membershipId: MEMBER_A_MEMBERSHIP,
    userId: MEMBER_A_USER,
  };
  const ownerB: VaultActor = {
    accessToken: mintAccessToken(
      database,
      sessions,
      createdB.ownerUserId,
      OWNER_B_DEVICE,
    ),
    deviceId: OWNER_B_DEVICE,
    membershipId: createdB.membershipId,
    userId: createdB.ownerUserId,
  };
  const memberB: VaultActor = {
    accessToken: mintAccessToken(database, sessions, MEMBER_B_USER, MEMBER_B_DEVICE),
    deviceId: MEMBER_B_DEVICE,
    membershipId: MEMBER_B_MEMBERSHIP,
    userId: MEMBER_B_USER,
  };

  // Tracked so `afterEach` can release any /wait hold a case left parked. A
  // failed assertion can abort a case before it wakes its own waiters, and a
  // held long-poll's timer must not outlive the case that opened it.
  wakeRegistries.push({
    registry: wakeRegistry,
    vaultIds: [VAULT_A, createdB.vaultId],
  });

  return {
    blobStore,
    database,
    invitations,
    memberA,
    memberB,
    ownerA,
    ownerB,
    revisions,
    sessions,
    vaultB: createdB.vaultId,
    wakeRegistry,
  };
}

function createApp(
  fixture: Fixture,
  options?: { readonly waitTimeoutMs?: number },
): ReturnType<typeof buildApp> {
  const config = parseServerConfig(TEST_ENV);
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
        waitTimeoutMs: options?.waitTimeoutMs ?? 200,
      },
    },
    config,
  });
  applications.push(app);
  return app;
}

function header(
  vaultId: string,
  actor: VaultActor,
  revisionId: string,
  fileId: string,
  parents: readonly string[] = [],
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: actor.deviceId,
    expectedMemberId: actor.membershipId,
    fileId,
    parentRevisionIds: [...parents],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId,
  };
}

function revisionInput(
  vaultId: string,
  actor: VaultActor,
  revisionId: string,
  fileId: string,
  idempotencyKey: string,
  content: string,
  parents: readonly string[] = [],
): { header: ProtectedRevisionHeader; idempotencyKey: string; payload: string } {
  return {
    header: header(vaultId, actor, revisionId, fileId, parents),
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

function setVaultQuota(database: Database.Database, vaultId: string, quota: number): void {
  database.prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`).run(quota, vaultId);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
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

afterEach(async () => {
  for (const { registry, vaultIds } of wakeRegistries.splice(0)) {
    for (const vaultId of vaultIds) {
      registry.notify(vaultId, 0);
    }
  }
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('adversarial cross-vault isolation (two vaults, one server)', () => {
  // Check 1: a caller authenticated for vault A cannot write to vault B.
  it('rejects a push into vault B by a vault-A caller and writes nothing to B', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Owner A crafts a header addressed to vault B (its own device/member), then
    // POSTs it at vault B's endpoint. Membership is loaded by (userId, vaultB);
    // owner A has none, so the request is forbidden before any commit.
    const forged = revisionInput(
      fixture.vaultB,
      fixture.ownerA,
      REVISION_B1,
      FILE_B,
      'kB1',
      'A-cannot-write-B',
    );
    const pushed = await push(app, fixture.ownerA.accessToken, fixture.vaultB, [forged]);

    expect([401, 403]).toContain(pushed.statusCode);

    // Nothing was written to vault B: its cursor is still 0 and no revision row
    // exists. Owner B (a real member) proves the pull side is empty.
    const events = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerB.accessToken}` },
      method: 'GET',
      url: `/vaults/${fixture.vaultB}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect((events.json() as { cursor: number; events: unknown[] }).cursor).toBe(0);
    expect((events.json() as { events: unknown[] }).events).toEqual([]);
    const rows = fixture.database
      .prepare(`SELECT COUNT(*) AS count FROM revisions WHERE vault_id = ?`)
      .get(fixture.vaultB) as { count: number };
    expect(rows.count).toBe(0);
  });

  // Check 2: a vault-A caller cannot long-poll vault B; no cursor leaks.
  it('rejects a /wait on vault B by a vault-A caller and leaks no cursor', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Seed vault B with a revision so its cursor is non-zero — a leak would be
    // observable. Owner B commits it legitimately.
    const seeded = await push(app, fixture.ownerB.accessToken, fixture.vaultB, [
      revisionInput(fixture.vaultB, fixture.ownerB, REVISION_B1, FILE_B, 'kB1', 'seed-B'),
    ]);
    expect(seeded.statusCode).toBe(200);

    const waited = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'GET',
      url: `/vaults/${fixture.vaultB}/wait?cursor=0`,
    });

    expect(waited.statusCode).toBe(403);
    const bodyText = JSON.stringify(waited.json());
    expect(waited.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    // The current cursor of B (1) must never appear in the rejection body.
    expect(bodyText).not.toContain('cursor');
    expect(fixture.wakeRegistry.pendingCount(fixture.vaultB)).toBe(0);
  });

  // Check 3: the content-addressed store is shared for dedup, but a read
  // requires the vault to actually reference the hash. A blob that exists ONLY
  // because vault A stored it is unreadable through vault B.
  it('hides a blob stored only by vault A from a real vault-B member', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const secret = 'opaque-secret-bytes-of-vault-A';
    const pushed = await push(app, fixture.ownerA.accessToken, VAULT_A, [
      revisionInput(VAULT_A, fixture.ownerA, REVISION_A1, FILE_A, 'kA1', secret),
    ]);
    expect(pushed.statusCode).toBe(200);
    const blobHash = (
      pushed.json() as { results: Array<{ receipt: { blobHash: string } }> }
    ).results[0]?.receipt.blobHash;
    expect(blobHash).toBeDefined();
    // Sanity: the hash is really the content digest and the blob is physically
    // present in the shared store.
    expect(blobHash).toBe(await hashBlob(Buffer.from(secret, 'utf8')));

    // Member B is a legitimate member of vault B, but vault B references no such
    // hash — the read is indistinguishable from a missing blob (404).
    const viaB = await app.inject({
      headers: { authorization: `Bearer ${fixture.memberB.accessToken}` },
      method: 'GET',
      url: `/vaults/${fixture.vaultB}/blobs/${blobHash}`,
    });
    expect(viaB.statusCode).toBe(404);
    expect(viaB.json()).toEqual({ error: { code: 'NOT_FOUND' } });

    // And owner A pointing the same hash at vault B (which A is not a member of)
    // is forbidden outright.
    const crossOwnerA = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'GET',
      url: `/vaults/${fixture.vaultB}/blobs/${blobHash}`,
    });
    expect(crossOwnerA.statusCode).toBe(403);

    // The blob remains readable in its own vault A, proving the 404 above is
    // isolation, not loss.
    const viaA = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/blobs/${blobHash}`,
    });
    expect(viaA.statusCode).toBe(200);
    expect(viaA.rawPayload.equals(Buffer.from(secret, 'utf8'))).toBe(true);
  });

  // Check 4: an invitation created for vault A cannot be approved or rejected
  // through vault B's endpoints; approval would mint a membership only in
  // invitation.vault_id, never B.
  it('forbids approving a vault-A invitation through vault B and mints no membership in B', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Owner A mints an invitation for vault A and a joining device redeems it,
    // leaving a pending device awaiting owner A's approval.
    const created = await app.inject({
      body: { intendedMemberDisplayName: 'Carol' },
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'POST',
      url: `/vaults/${VAULT_A}/invitations`,
    });
    expect(created.statusCode).toBe(200);
    const invitation = created.json() as {
      invitationId: string;
      invitationToken: string;
    };

    const redeem = await app.inject({
      body: {
        deviceLabel: 'Carol Laptop',
        initialRefreshToken: generateRefreshToken(),
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    expect(redeem.statusCode).toBe(200);
    const pending = redeem.json() as {
      pendingDeviceId: string;
      verificationPhrase: string;
    };

    const membershipsInBBefore = fixture.database
      .prepare(`SELECT COUNT(*) AS count FROM memberships WHERE vault_id = ?`)
      .get(fixture.vaultB) as { count: number };

    // Owner B (a real owner of vault B) tries to approve vault A's invitation via
    // vault B's own approve endpoint, supplying the correct phrase. The service's
    // #requireOwnerMembership binds the approver's membership to
    // invitation.vault_id (A) — owner B's membership is in B, so it is rejected.
    const crossApprove = await app.inject({
      body: { verificationPhrase: pending.verificationPhrase },
      headers: { authorization: `Bearer ${fixture.ownerB.accessToken}` },
      method: 'POST',
      url: `/vaults/${fixture.vaultB}/invitations/${invitation.invitationId}/approve`,
    });
    expect(crossApprove.statusCode).toBe(403);

    // No membership was minted in vault B, and the pending device is untouched.
    const membershipsInBAfter = fixture.database
      .prepare(`SELECT COUNT(*) AS count FROM memberships WHERE vault_id = ?`)
      .get(fixture.vaultB) as { count: number };
    expect(membershipsInBAfter.count).toBe(membershipsInBBefore.count);
    const device = fixture.database
      .prepare(`SELECT status FROM devices WHERE id = ?`)
      .get(pending.pendingDeviceId) as { status: string } | undefined;
    expect(device?.status).toBe('pending');

    // Rejecting through vault B is likewise forbidden and leaves the device pending.
    const crossReject = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerB.accessToken}` },
      method: 'POST',
      url: `/vaults/${fixture.vaultB}/invitations/${invitation.invitationId}/reject`,
    });
    expect(crossReject.statusCode).toBe(403);
    const deviceAfterReject = fixture.database
      .prepare(`SELECT status FROM devices WHERE id = ?`)
      .get(pending.pendingDeviceId) as { status: string } | undefined;
    expect(deviceAfterReject?.status).toBe('pending');
  });

  // Check 5: owner A is neither owner nor member of vault B, so owner-only
  // actions on B by owner A are forbidden.
  it('forbids owner A performing owner-only actions on vault B', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    // Creating an invitation is owner-only. Owner A has no membership in B → 403.
    const invite = await app.inject({
      body: { intendedMemberDisplayName: 'Mallory' },
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'POST',
      url: `/vaults/${fixture.vaultB}/invitations`,
    });
    expect(invite.statusCode).toBe(403);

    // Even member B (a member, not an owner) cannot create an invitation, but the
    // decisive point is that A is not in B's membership at all.
    const membershipRows = fixture.database
      .prepare(
        `SELECT COUNT(*) AS count FROM memberships WHERE vault_id = ? AND user_id = ?`,
      )
      .get(fixture.vaultB, fixture.ownerA.userId) as { count: number };
    expect(membershipRows.count).toBe(0);
  });

  // Check 6: the wake registry is strictly per vault_id. A commit in vault A
  // must not release a /wait waiter parked on vault B.
  it('does not wake a vault-B waiter when a revision commits in vault A', async () => {
    const fixture = makeFixture();
    // Both holds below are released by an explicit wake, never by elapsed time,
    // so the hold window is set far beyond any plausible commit duration. That
    // is what makes the negative assertion an ordering fact rather than a race:
    // vault B's waiter cannot self-resolve while the commit is in flight, no
    // matter how slow the runner. (The timeout path itself is covered by
    // sync-routes.test.ts, 'resolves with the unchanged cursor when the hold
    // times out'.)
    const app = createApp(fixture, { waitTimeoutMs: 60_000 });

    // Park a real waiter on each vault: owner A on A, owner B on B. Both are
    // members with their cursor at head 0, so both hold rather than fast-path.
    // Vault A's waiter is the positive control — if the commit wake were broken
    // outright, it would never resolve and this test would fail, so B staying
    // parked cannot pass vacuously.
    const heldA = app.inject({
      headers: { authorization: `Bearer ${fixture.ownerA.accessToken}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/wait?cursor=0`,
    });
    const heldB = app.inject({
      headers: { authorization: `Bearer ${fixture.ownerB.accessToken}` },
      method: 'GET',
      url: `/vaults/${fixture.vaultB}/wait?cursor=0`,
    });
    await waitFor(
      () =>
        fixture.wakeRegistry.pendingCount(VAULT_A) === 1 &&
        fixture.wakeRegistry.pendingCount(fixture.vaultB) === 1,
    );

    // Commit a revision in vault A. This must notify ONLY vault A's waiters.
    const committed = await push(app, fixture.ownerA.accessToken, VAULT_A, [
      revisionInput(VAULT_A, fixture.ownerA, REVISION_A1, FILE_A, 'kA1', 'commit-in-A'),
    ]);
    expect(committed.statusCode).toBe(200);

    // Vault A's waiter woke with A's advanced cursor. Awaiting it proves the
    // commit's wake has already been dispatched — no sleeping required.
    const resolvedA = await heldA;
    expect(resolvedA.statusCode).toBe(200);
    expect(resolvedA.json()).toEqual({ cursor: 1 });
    expect(fixture.wakeRegistry.pendingCount(VAULT_A)).toBe(0);

    // Vault B's waiter is still parked after that same wake — it did not cross
    // vaults, and its own hold has ~60 s left to run.
    expect(fixture.wakeRegistry.pendingCount(fixture.vaultB)).toBe(1);

    // B resolves only when B itself is woken, and then with B's UNCHANGED
    // cursor (0): A's commit advanced A's cursor to 1 and left B's at 0.
    const cursorB = fixture.revisions.getCursor(fixture.vaultB);
    expect(cursorB).toBe(0);
    fixture.wakeRegistry.notify(fixture.vaultB, cursorB);
    const resolvedB = await heldB;
    expect(resolvedB.statusCode).toBe(200);
    expect(resolvedB.json()).toEqual({ cursor: 0 });
    expect(fixture.wakeRegistry.pendingCount(fixture.vaultB)).toBe(0);
  });

  // Check 7 (quota half): storage quota is counted per vault_id, so vault A
  // exhausting its budget cannot consume vault B's.
  it('counts storage quota per vault_id: exhausting A leaves B fully spendable', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 100);
    setVaultQuota(fixture.database, fixture.vaultB, 100);
    const app = createApp(fixture);

    // Fill vault A to its cap.
    const fillA = await push(app, fixture.ownerA.accessToken, VAULT_A, [
      revisionInput(VAULT_A, fixture.ownerA, REVISION_A1, FILE_A, 'kA1', 'a'.repeat(100)),
    ]);
    expect(fillA.statusCode).toBe(200);

    // A further byte into A is rejected — A is exhausted.
    const overA = await push(app, fixture.ownerA.accessToken, VAULT_A, [
      revisionInput(
        VAULT_A,
        fixture.ownerA,
        'a0000000-0000-4000-8000-000000000002',
        FILE_A,
        'kA2',
        'x',
        [REVISION_A1],
      ),
    ]);
    expect(overA.statusCode).toBe(413);
    expect(overA.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });

    // Vault B's budget is untouched: it accepts a full 100-byte push.
    const fillB = await push(app, fixture.ownerB.accessToken, fixture.vaultB, [
      revisionInput(fixture.vaultB, fixture.ownerB, REVISION_B1, FILE_B, 'kB1', 'b'.repeat(100)),
    ]);
    expect(fillB.statusCode).toBe(200);
    expect(
      (fillB.json() as { results: Array<{ status: string }> }).results[0]?.status,
    ).toBe('accepted');
  });
});
