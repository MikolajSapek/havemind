import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  InvitationError,
  InvitationService,
  type ApprovePendingDeviceResult,
  type CreateInvitationResult,
  type InvitationErrorCode,
  type RedeemInvitationResult,
} from './invitations.js';
import { OwnerSetupService, createLocalOwnerSetupContext } from './setup.js';
import { SessionRepository } from './session-repository.js';
import {
  generateInvitationToken,
  generateRefreshToken,
  hashInvitationToken,
  parseAccessToken,
  parseInvitationToken,
} from './tokens.js';
import { parseVerificationPin } from './verification-pin.js';

const START_TIME = '2026-07-15T03:00:00.000Z';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const OWNER_DEVICE_ID = '70000000-0000-4000-8000-000000000001';
const JOINER_DEVICE_ID = '70000000-0000-4000-8000-000000000002';
const OWNER_PUBLIC_KEY = Buffer.alloc(32, 0x7a);
const JOINER_PUBLIC_KEY = Buffer.alloc(32, 0x5b);
const ACCESS_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

interface MutableClock {
  readonly now: () => Date;
  advance(milliseconds: number): void;
}

interface Fixture {
  readonly clock: MutableClock;
  readonly database: Database.Database;
  readonly service: InvitationService;
  readonly sessions: SessionRepository;
  readonly ownerMembershipId: string;
  readonly ownerDeviceId: string;
  readonly vaultId: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createClock(initial = START_TIME): MutableClock {
  let milliseconds = Date.parse(initial);
  return {
    advance(value): void {
      milliseconds += value;
    },
    now: () => new Date(milliseconds),
  };
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-invitations-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);
  const clock = createClock();

  const owner = new OwnerSetupService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now: clock.now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  const initialized = owner.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Owner',
    vaultDisplayName: 'Vault',
  });
  owner.pairOwnerDevice({
    deviceDisplayName: 'Owner Laptop',
    deviceId: OWNER_DEVICE_ID,
    initialRefreshToken: generateRefreshToken(),
    pairingToken: initialized.pairingToken,
    publicKey: OWNER_PUBLIC_KEY,
  });

  const vaultRow = database.prepare('SELECT id FROM vaults').get() as {
    id: string;
  };

  const service = new InvitationService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now: clock.now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  const sessions = new SessionRepository(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now: clock.now,
  });

  return {
    clock,
    database,
    ownerDeviceId: OWNER_DEVICE_ID,
    ownerMembershipId: initialized.membershipId,
    service,
    sessions,
    vaultId: vaultRow.id,
  };
}

function createInvitation(fixture: Fixture): CreateInvitationResult {
  return fixture.service.createInvitation({
    createdByMembershipId: fixture.ownerMembershipId,
    inviterDeviceId: fixture.ownerDeviceId,
    vaultId: fixture.vaultId,
  });
}

function redeem(
  fixture: Fixture,
  invitationToken: string,
): RedeemInvitationResult {
  return fixture.service.redeemInvitation({
    deviceDisplayName: 'Joiner Phone',
    deviceId: JOINER_DEVICE_ID,
    invitationToken,
    memberDisplayName: 'Joiner',
    publicKey: JOINER_PUBLIC_KEY,
  });
}

function approve(
  fixture: Fixture,
  invitationId: string,
  verificationPhrase: string,
): ApprovePendingDeviceResult {
  return fixture.service.approvePendingDevice({
    approverMembershipId: fixture.ownerMembershipId,
    initialRefreshToken: generateRefreshToken(),
    invitationId,
    verificationPhrase,
  });
}

/** Produces a syntactically valid 6-digit PIN guaranteed to differ from `pin`. */
function mutatePhrase(pin: string): string {
  return pin === '000000' ? '111111' : '000000';
}

function deviceCount(database: Database.Database, status: string): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM devices WHERE status = ?')
    .get(status) as { count: number };
  return row.count;
}

function accessTokenCount(database: Database.Database): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM access_tokens')
    .get() as { count: number };
  return row.count;
}

function expectInvitationError(
  run: () => unknown,
  code: InvitationErrorCode,
  httpStatus: number,
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvitationError);
  const error = caught as InvitationError;
  expect(error.code).toBe(code);
  expect(error.httpStatus).toBe(httpStatus);
}

afterEach(() => {
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

describe('InvitationService.createInvitation', () => {
  it('issues a single-use 256-bit token with a 15-minute expiry stored hashed', () => {
    const fixture = makeFixture();
    const result = createInvitation(fixture);

    const parsed = parseInvitationToken(result.invitationToken);
    const payload = Buffer.from(parsed.slice('hm_it_'.length), 'base64url');
    expect(payload.length).toBe(32);

    expect(Date.parse(result.expiresAt) - Date.parse(START_TIME)).toBe(
      FIFTEEN_MINUTES_MS,
    );

    const row = fixture.database
      .prepare(
        `SELECT token_hash AS tokenHash, consumed_at AS consumedAt,
                intended_role AS intendedRole
         FROM invitations WHERE id = ?`,
      )
      .get(result.invitationId) as {
      tokenHash: string;
      consumedAt: string | null;
      intendedRole: string;
    };
    expect(row.tokenHash).toBe(hashInvitationToken(parsed));
    expect(row.tokenHash).not.toContain(result.invitationToken);
    expect(row.consumedAt).toBeNull();
    expect(row.intendedRole).toBe('editor');
  });

  it('rejects an invitation from a membership that does not own the vault', () => {
    const fixture = makeFixture();
    expectInvitationError(
      () =>
        fixture.service.createInvitation({
          createdByMembershipId: '70000000-0000-4000-8000-0000000000ee',
          inviterDeviceId: fixture.ownerDeviceId,
          vaultId: fixture.vaultId,
        }),
      'NOT_AUTHORIZED',
      403,
    );
  });

  it('rejects malformed identifiers', () => {
    const fixture = makeFixture();
    expectInvitationError(
      () =>
        fixture.service.createInvitation({
          createdByMembershipId: fixture.ownerMembershipId,
          inviterDeviceId: 'not-a-uuid',
          vaultId: fixture.vaultId,
        }),
      'INVALID_INPUT',
      400,
    );
  });
});

describe('InvitationService.redeemInvitation', () => {
  it('creates a pending device and returns a comparable verification phrase', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const result = redeem(fixture, invitation.invitationToken);

    expect(result.state).toBe('pending_approval');
    expect(result.pendingDeviceId).toBe(JOINER_DEVICE_ID);
    // The verification value is a 6-digit numeric PIN…
    expect(result.verificationPhrase).toMatch(/^[0-9]{6}$/u);
    expect(() => parseVerificationPin(result.verificationPhrase)).not.toThrow();
    // …and it is byte-identical to the secret the server stored and will later
    // compare against (round-trip equality; no derivation to diverge).
    const storedSecret = fixture.database
      .prepare('SELECT verification_secret AS secret FROM invitations WHERE id = ?')
      .get(invitation.invitationId) as { secret: string };
    expect(result.verificationPhrase).toBe(storedSecret.secret);

    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(JOINER_DEVICE_ID) as { status: string };
    expect(device.status).toBe('pending');

    const invitationRow = fixture.database
      .prepare(
        `SELECT consumed_at AS consumedAt,
                consumed_by_user_id AS consumedByUserId,
                pending_device_id AS pendingDeviceId
         FROM invitations WHERE id = ?`,
      )
      .get(invitation.invitationId) as {
      consumedAt: string | null;
      consumedByUserId: string | null;
      pendingDeviceId: string | null;
    };
    expect(invitationRow.consumedAt).not.toBeNull();
    expect(invitationRow.consumedByUserId).toBe(result.userId);
    expect(invitationRow.pendingDeviceId).toBe(JOINER_DEVICE_ID);
  });

  it('returns a stable phrase that the owner can later confirm', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const redeemed = redeem(fixture, invitation.invitationToken);

    const result = approve(
      fixture,
      invitation.invitationId,
      redeemed.verificationPhrase,
    );
    expect(() => parseAccessToken(result.accessToken)).not.toThrow();
  });

  it('marks an expired invitation consumed, returns 410 and cannot be retried', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    fixture.clock.advance(FIFTEEN_MINUTES_MS + 1);

    expectInvitationError(
      () => redeem(fixture, invitation.invitationToken),
      'INVITATION_EXPIRED',
      410,
    );

    const row = fixture.database
      .prepare('SELECT consumed_at AS consumedAt FROM invitations WHERE id = ?')
      .get(invitation.invitationId) as { consumedAt: string | null };
    expect(row.consumedAt).not.toBeNull();
    expect(deviceCount(fixture.database, 'pending')).toBe(0);

    // A retry after expiry finds the invitation already burned.
    expectInvitationError(
      () => redeem(fixture, invitation.invitationToken),
      'INVITATION_ALREADY_REDEEMED',
      409,
    );
  });

  it('rejects a second redemption of the same token with 409 and no second device', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    redeem(fixture, invitation.invitationToken);

    expectInvitationError(
      () => redeem(fixture, invitation.invitationToken),
      'INVITATION_ALREADY_REDEEMED',
      409,
    );
    expect(deviceCount(fixture.database, 'pending')).toBe(1);
  });

  it('rejects a malformed invitation token', () => {
    const fixture = makeFixture();
    expectInvitationError(
      () => redeem(fixture, generateRefreshToken()),
      'INVALID_INPUT',
      400,
    );
  });

  it('rejects a well-formed but unknown invitation token', () => {
    const fixture = makeFixture();
    expectInvitationError(
      () => redeem(fixture, generateInvitationToken()),
      'INVALID_INVITATION',
      404,
    );
  });
});

describe('InvitationService.approvePendingDevice', () => {
  it('activates the device and issues a refresh session on a matching phrase', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const redeemed = redeem(fixture, invitation.invitationToken);

    const before = accessTokenCount(fixture.database);
    const result = approve(
      fixture,
      invitation.invitationId,
      redeemed.verificationPhrase,
    );

    expect(() => parseAccessToken(result.accessToken)).not.toThrow();
    expect(result.deviceId).toBe(JOINER_DEVICE_ID);
    expect(result.userId).toBe(redeemed.userId);

    const device = fixture.database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(JOINER_DEVICE_ID) as { status: string };
    expect(device.status).toBe('approved');

    const membership = fixture.database
      .prepare(
        `SELECT role, status FROM memberships
         WHERE vault_id = ? AND user_id = ?`,
      )
      .get(fixture.vaultId, redeemed.userId) as {
      role: string;
      status: string;
    };
    expect(membership).toMatchObject({ role: 'editor', status: 'active' });

    expect(accessTokenCount(fixture.database)).toBe(before + 1);
    const session = fixture.sessions.lookupAccess(result.accessToken);
    expect(session?.userId).toBe(redeemed.userId);
  });

  it('removes the pending device and issues no token on a phrase mismatch', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const redeemed = redeem(fixture, invitation.invitationToken);
    const before = accessTokenCount(fixture.database);

    expectInvitationError(
      () =>
        approve(
          fixture,
          invitation.invitationId,
          mutatePhrase(redeemed.verificationPhrase),
        ),
      'PHRASE_MISMATCH',
      403,
    );

    expect(
      fixture.database
        .prepare('SELECT id FROM devices WHERE id = ?')
        .get(JOINER_DEVICE_ID),
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(redeemed.userId),
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare(
          'SELECT id FROM memberships WHERE vault_id = ? AND user_id = ?',
        )
        .get(fixture.vaultId, redeemed.userId),
    ).toBeUndefined();
    expect(accessTokenCount(fixture.database)).toBe(before);
  });

  it('rejects an unparseable phrase without removing the pending device', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    redeem(fixture, invitation.invitationToken);

    expectInvitationError(
      () => approve(fixture, invitation.invitationId, 'not a phrase'),
      'INVALID_INPUT',
      400,
    );
    expect(deviceCount(fixture.database, 'pending')).toBe(1);
  });

  it('refuses approval from a membership that is not an active vault owner', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const redeemed = redeem(fixture, invitation.invitationToken);

    expectInvitationError(
      () =>
        fixture.service.approvePendingDevice({
          approverMembershipId: '70000000-0000-4000-8000-0000000000ef',
          initialRefreshToken: generateRefreshToken(),
          invitationId: invitation.invitationId,
          verificationPhrase: redeemed.verificationPhrase,
        }),
      'NOT_AUTHORIZED',
      403,
    );
    expect(deviceCount(fixture.database, 'pending')).toBe(1);
  });

  it('reports no pending device when the invitation was never redeemed', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);

    expectInvitationError(
      () =>
        approve(fixture, invitation.invitationId, '123456'),
      'NO_PENDING_DEVICE',
      409,
    );
  });
});

describe('InvitationService.rejectPendingDevice', () => {
  it('removes the pending device and its user without issuing a token', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    const redeemed = redeem(fixture, invitation.invitationToken);
    const before = accessTokenCount(fixture.database);

    fixture.service.rejectPendingDevice({
      approverMembershipId: fixture.ownerMembershipId,
      invitationId: invitation.invitationId,
    });

    expect(deviceCount(fixture.database, 'pending')).toBe(0);
    expect(
      fixture.database
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(redeemed.userId),
    ).toBeUndefined();
    expect(accessTokenCount(fixture.database)).toBe(before);

    // A later approval attempt cannot resurrect the device.
    expectInvitationError(
      () =>
        approve(
          fixture,
          invitation.invitationId,
          redeemed.verificationPhrase,
        ),
      'NO_PENDING_DEVICE',
      409,
    );
  });

  it('refuses rejection from a non-owner membership', () => {
    const fixture = makeFixture();
    const invitation = createInvitation(fixture);
    redeem(fixture, invitation.invitationToken);

    expectInvitationError(
      () =>
        fixture.service.rejectPendingDevice({
          approverMembershipId: '70000000-0000-4000-8000-0000000000ef',
          invitationId: invitation.invitationId,
        }),
      'NOT_AUTHORIZED',
      403,
    );
    expect(deviceCount(fixture.database, 'pending')).toBe(1);
  });
});

describe('InvitationError', () => {
  it('serializes to a secret-free payload', () => {
    const error = new InvitationError('INVITATION_EXPIRED');
    expect(error.toJSON()).toEqual({
      code: 'INVITATION_EXPIRED',
      message: expect.any(String),
      name: 'InvitationError',
    });
    expect(error.httpStatus).toBe(410);
  });
});
