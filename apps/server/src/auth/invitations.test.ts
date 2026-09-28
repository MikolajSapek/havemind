import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TTL_SECONDS,
  makeTempDir,
  openMigratedDatabase,
  REFRESH_TTL_SECONDS,
  releaseTestResources,
} from '../test/fixtures/server-fixtures.js';
import {
  InvitationError,
  InvitationService,
  type CreateInvitationResult,
  type InvitationErrorCode,
  type RedeemForOnboardingResult,
} from './invitations.js';
import { OwnerSetupService, createLocalOwnerSetupContext } from './setup.js';
import {
  generateRefreshToken,
  hashInvitationToken,
  parseInvitationToken,
} from './tokens.js';

const START_TIME = '2026-07-15T03:00:00.000Z';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const OWNER_DEVICE_ID = '70000000-0000-4000-8000-000000000001';
const REDEMPTION_ID = '70000000-0000-4000-8000-000000000002';
const OWNER_PUBLIC_KEY = Buffer.alloc(32, 0x7a);

interface Fixture {
  readonly database: Database.Database;
  readonly service: InvitationService;
  readonly ownerMembershipId: string;
  readonly ownerDeviceId: string;
  readonly vaultId: string;
}

function makeFixture(): Fixture {
  const database = openMigratedDatabase(makeTempDir('havemind-invitations-'));
  const now = (): Date => new Date(START_TIME);

  const owner = new OwnerSetupService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    now,
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
    now,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });

  return {
    database,
    ownerDeviceId: OWNER_DEVICE_ID,
    ownerMembershipId: initialized.membershipId,
    service,
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
): RedeemForOnboardingResult {
  return fixture.service.redeemInvitationForOnboarding({
    deviceLabel: 'Joiner Phone',
    initialRefreshToken: generateRefreshToken(),
    invitationToken,
    redemptionId: REDEMPTION_ID,
  });
}

function approve(
  fixture: Fixture,
  invitationId: string,
  verificationPhrase: string,
): void {
  fixture.service.approveRedeemedDevice({
    approverMembershipId: fixture.ownerMembershipId,
    invitationId,
    verificationPhrase,
  });
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

afterEach(releaseTestResources);

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
        .get(invitation.intendedMemberId),
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
