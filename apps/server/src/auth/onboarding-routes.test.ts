import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import type { StoredRevisionEvent } from '../revision-repository.js';
import { InvitationService } from './invitations.js';
import { registerPreAuthOnboardingRoutes } from './onboarding-routes.js';
import { SessionRepository } from './session-repository.js';
import {
  createRefreshSuccessor,
  generateRefreshToken,
  generatePairingToken,
  hashPairingToken,
  hashRefreshToken,
  parsePairingToken,
  parseRefreshToken,
} from './tokens.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const START_TIME = '2026-07-16T03:00:00.000Z';
const INVITATION_TTL_MS = 15 * 60 * 1_000;

const OWNER_USER = '80000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '80000000-0000-4000-8000-0000000000a2';
const VAULT = '80000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '80000000-0000-4000-8000-0000000000a4';

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly invitations: InvitationService;
  readonly ownerAccessToken: string;
  readonly clock: { ms: number };
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function insertUser(database: Database.Database, id: string, name: string) {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, 1, 'active', ?, NULL)`,
    )
    .run(id, name, START_TIME);
}

function insertDevice(
  database: Database.Database,
  id: string,
  userId: string,
  name: string,
) {
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(id, userId, name, Buffer.alloc(32, 0x22), START_TIME, START_TIME);
}

function insertVault(database: Database.Database, id: string, name: string) {
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
) {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
    )
    .run(id, vaultId, userId, START_TIME);
}

function insertPairing(
  database: Database.Database,
  token: string,
) {
  database
    .prepare(
      `INSERT INTO owner_pairings (
         id, user_id, vault_id, membership_id, token_hash,
         created_at, expires_at, consumed_at, consumed_by_device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      randomUUID(),
      OWNER_USER,
      VAULT,
      OWNER_MEMBERSHIP,
      hashPairingToken(parsePairingToken(token)),
      START_TIME,
      '2099-01-01T00:00:00.000Z',
    );
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
  const directory = mkdtempSync(join(tmpdir(), 'havemind-onboarding-'));
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

  insertUser(database, OWNER_USER, 'Alice');
  insertDevice(database, OWNER_DEVICE, OWNER_USER, 'Alice Laptop');
  insertVault(database, VAULT, 'Shared Vault');
  insertMembership(database, OWNER_MEMBERSHIP, VAULT, OWNER_USER);

  const ownerAccessToken = mintAccessToken(
    database,
    sessions,
    OWNER_USER,
    OWNER_DEVICE,
  );

  return { clock, database, invitations, ownerAccessToken, sessions };
}

function createApp(
  fixture: Fixture,
  options?: { rateLimit?: { maxRequests: number; windowMs: number } },
) {
  const config = parseServerConfig(TEST_ENV);
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database: fixture.database,
      invitations: fixture.invitations,
      now: () => new Date(fixture.clock.ms),
      sessions: fixture.sessions,
      ...(options?.rateLimit === undefined
        ? {}
        : { rateLimit: options.rateLimit }),
    },
    config,
  });
  applications.push(app);
  return app;
}

async function createInvitation(
  app: ReturnType<typeof buildApp>,
  token: string,
) {
  return app.inject({
    body: { intendedMemberDisplayName: 'Bob' },
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    url: `/vaults/${VAULT}/invitations`,
  });
}

interface PendingRedemption {
  readonly invitationId: string;
  readonly pending: {
    readonly pendingCredential: string;
    readonly pendingDeviceId: string;
    readonly verificationPhrase: string;
  };
}

/** Polls the pre-auth approval status endpoint as the joining device would. */
function pollApproval(
  app: ReturnType<typeof buildApp>,
  pendingDeviceId: string,
  pendingCredential: string,
) {
  return app.inject({
    headers: { 'x-havemind-pending-credential': pendingCredential },
    method: 'GET',
    url: `/devices/${pendingDeviceId}/approval`,
  });
}

/** Creates and redeems an invitation, returning the joining device's code. */
async function redeemPending(
  app: ReturnType<typeof buildApp>,
  ownerAccessToken: string,
): Promise<PendingRedemption> {
  const created = await createInvitation(app, ownerAccessToken);
  const invitation = created.json() as {
    invitationId: string;
    invitationToken: string;
  };
  const redeem = await app.inject({
    body: {
      deviceLabel: 'Bob Laptop',
      initialRefreshToken: generateRefreshToken(),
      invitationToken: invitation.invitationToken,
      redemptionId: randomUUID(),
    },
    method: 'POST',
    url: '/invitations/redeem',
  });
  const pending = redeem.json() as {
    pendingCredential: string;
    pendingDeviceId: string;
    verificationPhrase: string;
  };
  return { invitationId: invitation.invitationId, pending };
}

/** POSTs a verification code to the owner approve route. */
function approveWith(
  app: ReturnType<typeof buildApp>,
  ownerAccessToken: string,
  invitationId: string,
  verificationPhrase: string,
) {
  return app.inject({
    body: { verificationPhrase },
    headers: { authorization: `Bearer ${ownerAccessToken}` },
    method: 'POST',
    url: `/vaults/${VAULT}/invitations/${invitationId}/approve`,
  });
}

/** Produces a syntactically valid 6-digit PIN guaranteed to differ from `code`. */
function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
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

describe('onboarding HTTP surface', () => {
  it('runs the full invite → redeem → approve → refresh → bootstrap flow', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const created = await createInvitation(app, fixture.ownerAccessToken);
    expect(created.statusCode).toBe(200);
    const invitation = created.json() as {
      expiresAt: string;
      intendedMemberId: string;
      invitationId: string;
      invitationToken: string;
    };
    expect(invitation.invitationToken.startsWith('hm_it_')).toBe(true);

    const review = await app.inject({
      body: { invitationToken: invitation.invitationToken },
      method: 'POST',
      url: '/invitations/review',
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toEqual({
      expiresAt: invitation.expiresAt,
      intendedMemberDisplayName: 'Bob',
      inviterDisplayName: 'Alice',
      memberId: invitation.intendedMemberId,
      vaultId: VAULT,
      vaultName: 'Shared Vault',
      version: 1,
    });

    const initialRefreshToken = generateRefreshToken();
    const redeem = await app.inject({
      body: {
        deviceLabel: 'Bob Laptop',
        initialRefreshToken,
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    expect(redeem.statusCode).toBe(200);
    const pending = redeem.json() as {
      pendingCredential: string;
      pendingDeviceId: string;
      status: string;
      verificationPhrase: string;
    };
    expect(pending.status).toBe('pending');
    expect(pending.pendingCredential.startsWith('hm_pd_')).toBe(true);

    const pollBefore = await app.inject({
      headers: { 'x-havemind-pending-credential': pending.pendingCredential },
      method: 'GET',
      url: `/devices/${pending.pendingDeviceId}/approval`,
    });
    expect(pollBefore.json()).toEqual({ status: 'pending' });

    const approve = await app.inject({
      body: { verificationPhrase: pending.verificationPhrase },
      headers: { authorization: `Bearer ${fixture.ownerAccessToken}` },
      method: 'POST',
      url: `/vaults/${VAULT}/invitations/${invitation.invitationId}/approve`,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({
      deviceId: pending.pendingDeviceId,
      status: 'approved',
    });

    const pollAfter = await app.inject({
      headers: { 'x-havemind-pending-credential': pending.pendingCredential },
      method: 'GET',
      url: `/devices/${pending.pendingDeviceId}/approval`,
    });
    // The approved poll surfaces the invitee's active membership id — the exact
    // memberships.id that POST /revisions checks expectedMemberId against — so the
    // invitee can stamp a valid push identity. It is the membership row, never the
    // invitee's user id (intendedMemberId), which the server assigns as user_id.
    const inviteeMembership = fixture.database
      .prepare(
        `SELECT id AS membershipId FROM memberships
         WHERE user_id = ? AND vault_id = ? AND status = 'active'`,
      )
      .get(invitation.intendedMemberId, VAULT) as { membershipId: string };
    expect(inviteeMembership.membershipId).not.toBe(invitation.intendedMemberId);
    expect(pollAfter.json()).toEqual({
      bootstrapCursor: null,
      deviceId: pending.pendingDeviceId,
      membershipId: inviteeMembership.membershipId,
      status: 'approved',
    });

    const successor = createRefreshSuccessor();
    const refresh = await app.inject({
      body: {
        refreshToken: initialRefreshToken,
        rotationId: successor.rotationId,
        successorRefreshToken: successor.refreshToken,
      },
      method: 'POST',
      url: '/auth/refresh',
    });
    expect(refresh.statusCode).toBe(200);
    expect((refresh.json() as { accessToken: string }).accessToken.startsWith('hm_at_')).toBe(
      true,
    );

    const bootstrap = await app.inject({
      headers: { 'x-havemind-refresh-token': successor.refreshToken },
      method: 'GET',
      url: '/bootstrap',
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toEqual({
      complete: true,
      items: [],
      nextCursor: null,
      version: 1,
    });
  });

  it('rejects a redemption of an invitation older than 15 minutes with 410', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const created = await createInvitation(app, fixture.ownerAccessToken);
    const invitation = created.json() as { invitationToken: string };

    fixture.clock.ms += INVITATION_TTL_MS + 1_000;

    const redeem = await app.inject({
      body: {
        deviceLabel: 'Bob Laptop',
        initialRefreshToken: generateRefreshToken(),
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    expect(redeem.statusCode).toBe(410);
  });

  it('rejects a second redemption of the same invitation with 409', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const created = await createInvitation(app, fixture.ownerAccessToken);
    const invitation = created.json() as { invitationToken: string };

    const first = await app.inject({
      body: {
        deviceLabel: 'Bob Laptop',
        initialRefreshToken: generateRefreshToken(),
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      body: {
        deviceLabel: 'Bob Laptop',
        initialRefreshToken: generateRefreshToken(),
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    expect(second.statusCode).toBe(409);
  });

  it('keeps the pending device and reports remaining attempts on a wrong code (403)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const { invitationId, pending } = await redeemPending(
      app,
      fixture.ownerAccessToken,
    );

    const approve = await approveWith(
      app,
      fixture.ownerAccessToken,
      invitationId,
      wrongCode(pending.verificationPhrase),
    );
    expect(approve.statusCode).toBe(403);
    expect(approve.json()).toEqual({
      error: { attemptsRemaining: 2, code: 'PHRASE_MISMATCH' },
    });

    // A single typo must not kill the flow: the device is still pending.
    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(pending.pendingDeviceId) as { status: string } | undefined;
    expect(device?.status).toBe('pending');

    // The joining device polling meanwhile still sees 'pending', so it stays on
    // the waiting screen (never offline) through the owner's wrong attempt.
    const poll = await pollApproval(
      app,
      pending.pendingDeviceId,
      pending.pendingCredential,
    );
    expect(poll.json()).toEqual({ status: 'pending' });
  });

  it('locks the pending device after three wrong codes and blocks further approval', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const { invitationId, pending } = await redeemPending(
      app,
      fixture.ownerAccessToken,
    );
    const wrong = wrongCode(pending.verificationPhrase);

    const first = await approveWith(app, fixture.ownerAccessToken, invitationId, wrong);
    expect(first.json()).toEqual({
      error: { attemptsRemaining: 2, code: 'PHRASE_MISMATCH' },
    });
    const second = await approveWith(app, fixture.ownerAccessToken, invitationId, wrong);
    expect(second.json()).toEqual({
      error: { attemptsRemaining: 1, code: 'PHRASE_MISMATCH' },
    });
    // The third wrong code locks the attempt out.
    const third = await approveWith(app, fixture.ownerAccessToken, invitationId, wrong);
    expect(third.statusCode).toBe(403);
    expect(third.json()).toEqual({ error: { code: 'APPROVAL_LOCKED' } });

    // The device is gone and cannot be brute-forced further — even the correct
    // code no longer approves; a fresh invitation is required.
    expect(
      fixture.database
        .prepare('SELECT id FROM devices WHERE id = ?')
        .get(pending.pendingDeviceId),
    ).toBeUndefined();
    const afterLock = await approveWith(
      app,
      fixture.ownerAccessToken,
      invitationId,
      pending.verificationPhrase,
    );
    expect(afterLock.statusCode).toBe(409);

    // The joining device polling after the lock learns it was rejected (200
    // rejected, not an opaque 404), so it can move to the "invitation no longer
    // valid" screen instead of waiting forever.
    const poll = await pollApproval(
      app,
      pending.pendingDeviceId,
      pending.pendingCredential,
    );
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toEqual({ status: 'rejected' });
  });

  it('approves when the correct code is entered on the second attempt', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const { invitationId, pending } = await redeemPending(
      app,
      fixture.ownerAccessToken,
    );

    const wrong = await approveWith(
      app,
      fixture.ownerAccessToken,
      invitationId,
      wrongCode(pending.verificationPhrase),
    );
    expect(wrong.statusCode).toBe(403);

    const correct = await approveWith(
      app,
      fixture.ownerAccessToken,
      invitationId,
      pending.verificationPhrase,
    );
    expect(correct.statusCode).toBe(200);
    expect(correct.json()).toMatchObject({
      deviceId: pending.pendingDeviceId,
      status: 'approved',
    });
    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(pending.pendingDeviceId) as { status: string };
    expect(device.status).toBe('approved');
  });

  it('never returns the verification code to the owner (create or approve body)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const created = await createInvitation(app, fixture.ownerAccessToken);
    const createdBody = JSON.stringify(created.json());
    // The owner mints the invitation but must never receive the derived code.
    expect(createdBody).not.toContain('verificationPhrase');
    expect(createdBody).not.toContain('verification_secret');

    const { invitationId, pending } = await redeemPending(
      app,
      fixture.ownerAccessToken,
    );
    const approve = await approveWith(
      app,
      fixture.ownerAccessToken,
      invitationId,
      pending.verificationPhrase,
    );
    const approveBody = JSON.stringify(approve.json());
    expect(approve.statusCode).toBe(200);
    expect(approveBody).not.toContain('verificationPhrase');
    expect(approveBody).not.toContain(pending.verificationPhrase);
  });

  it('requires owner authentication to generate an invitation', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const anonymous = await app.inject({
      body: { intendedMemberDisplayName: 'Bob' },
      method: 'POST',
      url: `/vaults/${VAULT}/invitations`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects a non-member trying to generate an invitation with 403', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const otherVault = randomUUID();

    const forbidden = await app.inject({
      body: { intendedMemberDisplayName: 'Bob' },
      headers: { authorization: `Bearer ${fixture.ownerAccessToken}` },
      method: 'POST',
      url: `/vaults/${otherVault}/invitations`,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('rejects an unknown pending credential with 404 and no disclosure', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      headers: {
        'x-havemind-pending-credential': `hm_pd_${'A'.repeat(43)}`,
      },
      method: 'GET',
      url: `/devices/${randomUUID()}/approval`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an invalid refresh token at the token endpoint with 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const successor = createRefreshSuccessor();

    const response = await app.inject({
      body: {
        refreshToken: generateRefreshToken(),
        rotationId: successor.rotationId,
        successorRefreshToken: successor.refreshToken,
      },
      method: 'POST',
      url: '/auth/refresh',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects bootstrap with an unknown refresh token with 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      headers: { 'x-havemind-refresh-token': generateRefreshToken() },
      method: 'GET',
      url: '/bootstrap',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rate limits the pre-auth surface before any invitation lookup (429)', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, {
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    });

    const first = await app.inject({
      body: { invitationToken: `hm_it_${'A'.repeat(43)}` },
      method: 'POST',
      url: '/invitations/review',
    });
    const second = await app.inject({
      body: { invitationToken: `hm_it_${'A'.repeat(43)}` },
      method: 'POST',
      url: '/invitations/review',
    });

    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(first.statusCode).not.toBe(429);
  });

  it('lets the owner reject a redeemed device, discarding it without a token', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);
    const created = await createInvitation(app, fixture.ownerAccessToken);
    const invitation = created.json() as {
      invitationId: string;
      invitationToken: string;
    };
    const redeem = await app.inject({
      body: {
        deviceLabel: 'Bob Laptop',
        initialRefreshToken: generateRefreshToken(),
        invitationToken: invitation.invitationToken,
        redemptionId: randomUUID(),
      },
      method: 'POST',
      url: '/invitations/redeem',
    });
    const pending = redeem.json() as { pendingDeviceId: string };

    const reject = await app.inject({
      headers: { authorization: `Bearer ${fixture.ownerAccessToken}` },
      method: 'POST',
      url: `/vaults/${VAULT}/invitations/${invitation.invitationId}/reject`,
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toEqual({ status: 'rejected' });

    const device = fixture.database
      .prepare('SELECT id FROM devices WHERE id = ?')
      .get(pending.pendingDeviceId);
    expect(device).toBeUndefined();
  });

  it('streams a bootstrap page of committed items for a live refresh token', async () => {
    const fixture = makeFixture();
    const rawRefresh = generateRefreshToken();
    fixture.database
      .transaction(() =>
        fixture.sessions.createInitialSessionInCurrentTransaction({
          deviceId: OWNER_DEVICE,
          initialRefreshToken: rawRefresh,
          refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
          userId: OWNER_USER,
        }),
      )
      .immediate();

    const event = {
      fileId: '90000000-0000-4000-8000-0000000000f1',
      receipt: {
        blobHash: 'a'.repeat(64),
        byteLength: 3,
        deviceId: OWNER_DEVICE,
        memberId: OWNER_MEMBERSHIP,
        revisionId: '90000000-0000-4000-8000-0000000000f2',
        serverSequence: 1,
        serverTime: START_TIME,
      },
      revisionId: '90000000-0000-4000-8000-0000000000f2',
      serverSequence: 1,
      type: 'revision-accepted',
    };

    const app = Fastify();
    applications.push(app as unknown as ReturnType<typeof buildApp>);
    registerPreAuthOnboardingRoutes(app, {
      database: fixture.database,
      invitations: fixture.invitations,
      revisions: { listEvents: () => [event] as unknown as StoredRevisionEvent[] },
      sessions: fixture.sessions,
    });

    const bootstrap = await app.inject({
      headers: { 'x-havemind-refresh-token': rawRefresh },
      method: 'GET',
      url: '/bootstrap',
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toEqual({
      complete: true,
      items: [
        {
          contentHash: 'a'.repeat(64),
          fileId: event.fileId,
          revisionId: event.revisionId,
          serverSequence: 1,
        },
      ],
      nextCursor: null,
      version: 1,
    });
  });
});

describe('owner device pairing HTTP surface', () => {
  const refreshTokenHash = (token: string): string =>
    hashRefreshToken(parseRefreshToken(token));

  const pairBody = (pairingToken: string, refreshToken = generateRefreshToken()) => ({
    deviceLabel: 'Owner Mac',
    initialRefreshTokenHash: refreshTokenHash(refreshToken),
    pairingToken,
  });

  it('pairs the owner device from a pairing token and returns the vault id', async () => {
    const fixture = makeFixture();
    const pairingToken = generatePairingToken();
    insertPairing(fixture.database, pairingToken);
    const app = createApp(fixture);

    const response = await app.inject({
      body: pairBody(pairingToken),
      method: 'POST',
      url: '/owner/pair',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { vaultId: string; deviceId: string };
    expect(body.vaultId).toBe(VAULT);
    expect(body.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('returns the owner active membershipId that revisions authorises against', async () => {
    const fixture = makeFixture();
    const pairingToken = generatePairingToken();
    insertPairing(fixture.database, pairingToken);
    const app = createApp(fixture);

    const response = await app.inject({
      body: pairBody(pairingToken),
      method: 'POST',
      url: '/owner/pair',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { membershipId: string };
    // Must equal the memberships.id row that POST /revisions compares
    // `expectedMemberId` against, so the owner push producer round-trips.
    expect(body.membershipId).toBe(OWNER_MEMBERSHIP);
  });

  it('lets the paired owner refresh to an access token (pair → refresh → 200)', async () => {
    const fixture = makeFixture();
    const pairingToken = generatePairingToken();
    insertPairing(fixture.database, pairingToken);
    const app = createApp(fixture);
    const refreshToken = generateRefreshToken();

    const paired = await app.inject({
      body: pairBody(pairingToken, refreshToken),
      method: 'POST',
      url: '/owner/pair',
    });
    expect(paired.statusCode).toBe(200);

    // The client keeps the raw refresh token and rotates it for access; this is
    // the exact flow that produced a 401 storm before the hash contract fix.
    const successor = createRefreshSuccessor();
    const refreshed = await app.inject({
      body: {
        refreshToken,
        rotationId: successor.rotationId,
        successorRefreshToken: successor.refreshToken,
      },
      method: 'POST',
      url: '/auth/refresh',
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { accessToken: string }).accessToken).toMatch(
      /^hm_at_/u,
    );
  });

  it('rejects a reused pairing token with 401 (single-use)', async () => {
    const fixture = makeFixture();
    const pairingToken = generatePairingToken();
    insertPairing(fixture.database, pairingToken);
    const app = createApp(fixture);

    const first = await app.inject({
      body: pairBody(pairingToken),
      method: 'POST',
      url: '/owner/pair',
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      body: pairBody(pairingToken),
      method: 'POST',
      url: '/owner/pair',
    });
    expect(second.statusCode).toBe(401);
  });

  it('rejects an unknown pairing token with a flat 401', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      body: pairBody(generatePairingToken()),
      method: 'POST',
      url: '/owner/pair',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture);

    const response = await app.inject({
      body: { deviceLabel: 'Owner Mac' },
      method: 'POST',
      url: '/owner/pair',
    });
    expect(response.statusCode).toBe(400);
  });
});
