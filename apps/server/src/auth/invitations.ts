import { randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { SessionRepository } from './session-repository.js';
import {
  generateInvitationToken,
  generatePendingDeviceCredential,
  hashInvitationToken,
  hashPendingDeviceCredential,
  hashRefreshToken,
  parseInvitationToken,
  parsePendingDeviceCredential,
  parseRefreshToken,
  type AccessToken,
} from './tokens.js';
import {
  deriveVerificationPhrase,
  generateVerificationSecret,
  parseVerificationPhrase,
  parseVerificationSecret,
} from './verification-phrase.js';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Invitations live for exactly 15 minutes and cannot be replayed. */
export const INVITATION_TTL_SECONDS = 15 * 60;
const MAX_DISPLAY_NAME_LENGTH = 80;
const PUBLIC_KEY_LENGTH = 32;
const DEFAULT_INTENDED_MEMBER_NAME = 'Invited member';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_CHARACTER_CEILING = 0x20;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < CONTROL_CHARACTER_CEILING) {
      return true;
    }
  }
  return false;
}

export type InvitationErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_INVITATION'
  | 'INVITATION_ALREADY_REDEEMED'
  | 'INVITATION_EXPIRED'
  | 'NO_PENDING_DEVICE'
  | 'NOT_AUTHORIZED'
  | 'PHRASE_MISMATCH'
  | 'REPOSITORY_INTEGRITY';

const ERROR_MESSAGES: Readonly<Record<InvitationErrorCode, string>> = {
  INVALID_INPUT: 'Invalid invitation input.',
  INVALID_INVITATION: 'Invalid invitation.',
  INVITATION_ALREADY_REDEEMED: 'The invitation was already redeemed.',
  INVITATION_EXPIRED: 'The invitation has expired.',
  NO_PENDING_DEVICE: 'No pending device awaits approval.',
  NOT_AUTHORIZED: 'The membership may not perform this action.',
  PHRASE_MISMATCH: 'The verification phrase did not match.',
  REPOSITORY_INTEGRITY: 'Stored invitation state is invalid.',
};

const ERROR_HTTP_STATUS: Readonly<Record<InvitationErrorCode, number>> = {
  INVALID_INPUT: 400,
  INVALID_INVITATION: 404,
  INVITATION_ALREADY_REDEEMED: 409,
  INVITATION_EXPIRED: 410,
  NO_PENDING_DEVICE: 409,
  NOT_AUTHORIZED: 403,
  PHRASE_MISMATCH: 403,
  REPOSITORY_INTEGRITY: 500,
};

/** A deliberately secret-free invitation error safe to log or serialize. */
export class InvitationError extends Error {
  public readonly code: InvitationErrorCode;

  public constructor(code: InvitationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'InvitationError';
    this.code = code;
  }

  public get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  public toJSON(): Readonly<{
    name: string;
    code: InvitationErrorCode;
    message: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

export interface InvitationServiceOptions {
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export type InvitationRole = 'editor' | 'owner';

export interface CreateInvitationInput {
  readonly vaultId: string;
  readonly createdByMembershipId: string;
  readonly inviterDeviceId: string;
  readonly intendedRole?: InvitationRole;
  readonly intendedMemberDisplayName?: string;
}

export interface CreateInvitationResult {
  readonly invitationId: string;
  readonly invitationToken: string;
  readonly expiresAt: string;
  readonly intendedMemberId: string;
  readonly intendedMemberDisplayName: string;
}

export interface InvitationReview {
  readonly expiresAt: string;
  readonly intendedMemberDisplayName: string;
  readonly inviterDisplayName: string;
  readonly memberId: string;
  readonly vaultId: string;
  readonly vaultName: string;
}

export interface RedeemForOnboardingInput {
  readonly invitationToken: string;
  readonly deviceLabel: string;
  readonly initialRefreshToken: string;
  readonly redemptionId: string;
}

export interface RedeemForOnboardingResult {
  readonly pendingCredential: string;
  readonly pendingDeviceId: string;
  readonly verificationPhrase: string;
}

export type ApprovalStatus =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved';
      readonly deviceId: string;
      readonly bootstrapCursor: string | null;
    };

export interface ApproveRedeemedDeviceInput {
  readonly invitationId: string;
  readonly approverMembershipId: string;
  readonly verificationPhrase: string;
}

export interface ApproveRedeemedDeviceResult {
  readonly deviceId: string;
  readonly familyId: string;
  readonly membershipId: string;
  readonly userId: string;
}

export interface RedeemInvitationInput {
  readonly invitationToken: string;
  readonly deviceId: string;
  readonly deviceDisplayName: string;
  readonly memberDisplayName: string;
  readonly publicKey: Buffer;
}

export interface RedeemInvitationResult {
  readonly state: 'pending_approval';
  readonly invitationId: string;
  readonly pendingDeviceId: string;
  readonly userId: string;
  readonly verificationPhrase: string;
}

export interface ApprovePendingDeviceInput {
  readonly invitationId: string;
  readonly approverMembershipId: string;
  readonly verificationPhrase: string;
  readonly initialRefreshToken: string;
}

export interface ApprovePendingDeviceResult {
  readonly accessToken: AccessToken;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly familyId: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly userId: string;
}

export interface RejectPendingDeviceInput {
  readonly invitationId: string;
  readonly approverMembershipId: string;
}

type RedeemOutcome =
  | { readonly kind: 'expired' }
  | { readonly kind: 'ok'; readonly result: RedeemInvitationResult };

type ApproveOutcome =
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'ok'; readonly result: ApprovePendingDeviceResult };

interface InvitationRow {
  readonly id: string;
  readonly vaultId: string;
  readonly inviterDeviceId: string;
  readonly verificationSecret: string;
  readonly intendedRole: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly consumedByUserId: string | null;
  readonly pendingDeviceId: string | null;
  readonly intendedMemberDisplayName: string | null;
  readonly intendedMemberId: string | null;
  readonly pendingCredentialHash: string | null;
  readonly pendingRefreshTokenHash: string | null;
}

interface OwnerMembershipRow {
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly vaultId: string;
}

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvitationError('INVALID_INPUT');
  }
  return value;
}

function requireDisplayName(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new InvitationError('INVALID_INPUT');
  }
  return value;
}

function requirePublicKey(value: Buffer): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.length !== PUBLIC_KEY_LENGTH ||
    value.every((byte) => byte === 0)
  ) {
    throw new InvitationError('INVALID_INPUT');
  }
  return value;
}

function requireRole(value: InvitationRole | undefined): InvitationRole {
  if (value === undefined) {
    return 'editor';
  }
  if (value !== 'editor' && value !== 'owner') {
    throw new InvitationError('INVALID_INPUT');
  }
  return value;
}

function readClock(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvitationError('INVALID_INPUT');
  }
  return value;
}

function addSeconds(date: Date, seconds: number): string {
  const milliseconds = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new InvitationError('INVALID_INPUT');
  }
  return new Date(milliseconds).toISOString();
}

function requireStoredDate(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new InvitationError('REPOSITORY_INTEGRITY');
  }
  return milliseconds;
}

/**
 * Owner-scoped invitations, race-safe single-use redemption and pending-device
 * approval with a human-readable verification phrase. The server derives the
 * phrase from a stored secret so both sides compare the same value in the pilot
 * (before end-to-end encryption); it never mints vault credentials before the
 * owner confirms the phrase.
 */
export class InvitationService {
  readonly #database: Database.Database;
  readonly #accessTokenTtlSeconds: number;
  readonly #refreshTokenTtlSeconds: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #sessions: SessionRepository;

  public constructor(
    database: Database.Database,
    options: InvitationServiceOptions = {},
  ) {
    this.#database = database;
    this.#accessTokenTtlSeconds =
      options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.#refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    this.#now = options.now ?? (() => new Date());
    this.#randomUuid = options.randomUuid ?? randomUUID;
    this.#sessions = new SessionRepository(database, {
      accessTokenTtlSeconds: this.#accessTokenTtlSeconds,
      now: this.#now,
      randomUuid: this.#randomUuid,
    });
  }

  public createInvitation(
    input: CreateInvitationInput,
  ): CreateInvitationResult {
    const vaultId = requireUuid(input.vaultId);
    const membershipId = requireUuid(input.createdByMembershipId);
    const inviterDeviceId = requireUuid(input.inviterDeviceId);
    const intendedRole = requireRole(input.intendedRole);
    const intendedMemberDisplayName = requireDisplayName(
      input.intendedMemberDisplayName ?? DEFAULT_INTENDED_MEMBER_NAME,
    );
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const expiresAt = addSeconds(now, INVITATION_TTL_SECONDS);
    const invitationToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(invitationToken);
    const verificationSecret = generateVerificationSecret();
    const intendedMemberId = this.#newUuid();

    const create = this.#database.transaction((): CreateInvitationResult => {
      const membership = this.#requireOwnerMembership(membershipId, vaultId);
      this.#requireInviterDevice(inviterDeviceId, membership.userId);

      const invitationId = this.#newUuid();
      this.#database
        .prepare(
          `INSERT INTO invitations (
             id, vault_id, created_by_membership_id, inviter_device_id,
             token_hash, verification_secret, intended_role, expires_at,
             created_at, consumed_at, consumed_by_user_id, pending_device_id,
             revoked_at, intended_member_display_name, intended_member_id,
             pending_credential_hash, pending_refresh_token_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          invitationId,
          vaultId,
          membershipId,
          inviterDeviceId,
          tokenHash,
          verificationSecret,
          intendedRole,
          expiresAt,
          createdAt,
          intendedMemberDisplayName,
          intendedMemberId,
        );

      return {
        expiresAt,
        intendedMemberDisplayName,
        intendedMemberId,
        invitationId,
        invitationToken,
      };
    });

    return create.immediate();
  }

  public redeemInvitation(
    input: RedeemInvitationInput,
  ): RedeemInvitationResult {
    let tokenHash: string;
    try {
      tokenHash = hashInvitationToken(
        parseInvitationToken(input.invitationToken),
      );
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }
    const deviceId = requireUuid(input.deviceId);
    const deviceDisplayName = requireDisplayName(input.deviceDisplayName);
    const memberDisplayName = requireDisplayName(input.memberDisplayName);
    const publicKey = requirePublicKey(input.publicKey);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();

    const redeem = this.#database.transaction((): RedeemOutcome => {
      const invitation = this.#loadInvitationByHash(tokenHash);
      if (invitation.consumedAt !== null) {
        throw new InvitationError('INVITATION_ALREADY_REDEEMED');
      }
      if (requireStoredDate(invitation.expiresAt) <= now.getTime()) {
        // Burn the invitation so a replay cannot succeed, then surface the
        // expiry outside the transaction so this write commits.
        this.#burnInvitation(invitation.id, createdAt);
        return { kind: 'expired' };
      }

      const userId = this.#newUuid();
      this.#database
        .prepare(
          `INSERT INTO users (
             id, display_name, is_instance_owner, status, created_at, revoked_at
           ) VALUES (?, ?, 0, 'active', ?, NULL)`,
        )
        .run(userId, memberDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO devices (
             id, user_id, display_name, public_key, status,
             created_at, approved_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
        )
        .run(deviceId, userId, deviceDisplayName, publicKey, createdAt);

      const consumed = this.#database
        .prepare(
          `UPDATE invitations
           SET consumed_at = ?, consumed_by_user_id = ?, pending_device_id = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(createdAt, userId, deviceId, invitation.id);
      if (consumed.changes !== 1) {
        throw new InvitationError('INVITATION_ALREADY_REDEEMED');
      }

      const verificationPhrase = deriveVerificationPhrase(
        parseVerificationSecret(invitation.verificationSecret),
        {
          invitationId: invitation.id,
          inviterDeviceId: invitation.inviterDeviceId,
          pendingDeviceId: deviceId,
          vaultId: invitation.vaultId,
        },
      );

      return {
        kind: 'ok',
        result: {
          invitationId: invitation.id,
          pendingDeviceId: deviceId,
          state: 'pending_approval',
          userId,
          verificationPhrase,
        },
      };
    });

    const outcome = redeem.immediate();
    if (outcome.kind === 'expired') {
      throw new InvitationError('INVITATION_EXPIRED');
    }
    return outcome.result;
  }

  public approvePendingDevice(
    input: ApprovePendingDeviceInput,
  ): ApprovePendingDeviceResult {
    const invitationId = requireUuid(input.invitationId);
    const approverMembershipId = requireUuid(input.approverMembershipId);
    let suppliedPhrase: string;
    try {
      suppliedPhrase = parseVerificationPhrase(input.verificationPhrase);
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }
    const now = readClock(this.#now);
    const approvedAt = now.toISOString();

    const approve = this.#database.transaction((): ApproveOutcome => {
        const invitation = this.#loadInvitationById(invitationId);
        this.#requireOwnerMembership(approverMembershipId, invitation.vaultId);

        const pendingDeviceId = invitation.pendingDeviceId;
        const pendingUserId = invitation.consumedByUserId;
        if (pendingDeviceId === null || pendingUserId === null) {
          throw new InvitationError('NO_PENDING_DEVICE');
        }
        const device = this.#database
          .prepare('SELECT status FROM devices WHERE id = ?')
          .get(pendingDeviceId) as { status: string } | undefined;
        if (device === undefined || device.status !== 'pending') {
          throw new InvitationError('NO_PENDING_DEVICE');
        }

        const expectedPhrase = deriveVerificationPhrase(
          parseVerificationSecret(invitation.verificationSecret),
          {
            invitationId: invitation.id,
            inviterDeviceId: invitation.inviterDeviceId,
            pendingDeviceId,
            vaultId: invitation.vaultId,
          },
        );
        if (suppliedPhrase !== expectedPhrase) {
          // Discard the pending device and surface the mismatch outside the
          // transaction so the deletion commits and no token is ever issued.
          this.#deletePendingUser(pendingUserId);
          return { kind: 'mismatch' };
        }

        const approved = this.#database
          .prepare(
            `UPDATE devices SET status = 'approved', approved_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(approvedAt, pendingDeviceId);
        if (approved.changes !== 1) {
          throw new InvitationError('REPOSITORY_INTEGRITY');
        }

        const membershipId = this.#newUuid();
        this.#database
          .prepare(
            `INSERT INTO memberships (
               id, vault_id, user_id, role, status, created_at, revoked_at
             ) VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            membershipId,
            invitation.vaultId,
            pendingUserId,
            this.#normalizeStoredRole(invitation.intendedRole),
            approvedAt,
          );

        const session = this.#sessions.createInitialSessionInCurrentTransaction(
          {
            deviceId: pendingDeviceId,
            initialRefreshToken: input.initialRefreshToken,
            refreshTokenTtlSeconds: this.#refreshTokenTtlSeconds,
            userId: pendingUserId,
          },
        );

        return {
          kind: 'ok',
          result: {
            accessExpiresAt: session.accessExpiresAt,
            accessToken: session.accessToken,
            deviceId: pendingDeviceId,
            familyId: session.familyId,
            membershipId,
            refreshExpiresAt: session.refreshExpiresAt,
            userId: pendingUserId,
          },
        };
      });

    const outcome = approve.immediate();
    if (outcome.kind === 'mismatch') {
      throw new InvitationError('PHRASE_MISMATCH');
    }
    return outcome.result;
  }

  public rejectPendingDevice(input: RejectPendingDeviceInput): void {
    const invitationId = requireUuid(input.invitationId);
    const approverMembershipId = requireUuid(input.approverMembershipId);

    const reject = this.#database.transaction((): void => {
      const invitation = this.#loadInvitationById(invitationId);
      this.#requireOwnerMembership(approverMembershipId, invitation.vaultId);
      if (
        invitation.pendingDeviceId === null ||
        invitation.consumedByUserId === null
      ) {
        throw new InvitationError('NO_PENDING_DEVICE');
      }
      this.#deletePendingUser(invitation.consumedByUserId);
    });

    reject.immediate();
  }

  /**
   * Reads invitation metadata for the joining device without consuming it. The
   * holder already possesses the token, so a missing/expired/consumed token
   * surfaces its precise state (404/410/409); no membership is required.
   */
  public reviewInvitation(rawInvitationToken: string): InvitationReview {
    let tokenHash: string;
    try {
      tokenHash = hashInvitationToken(parseInvitationToken(rawInvitationToken));
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }
    const now = readClock(this.#now);

    const invitation = this.#loadInvitationByHash(tokenHash);
    if (invitation.consumedAt !== null) {
      throw new InvitationError('INVITATION_ALREADY_REDEEMED');
    }
    if (requireStoredDate(invitation.expiresAt) <= now.getTime()) {
      throw new InvitationError('INVITATION_EXPIRED');
    }
    if (
      invitation.intendedMemberId === null ||
      invitation.intendedMemberDisplayName === null
    ) {
      throw new InvitationError('REPOSITORY_INTEGRITY');
    }

    const vault = this.#database
      .prepare('SELECT display_name AS displayName FROM vaults WHERE id = ?')
      .get(invitation.vaultId) as { displayName: string } | undefined;
    const inviter = this.#database
      .prepare(
        `SELECT users.display_name AS displayName
         FROM devices
         INNER JOIN users ON users.id = devices.user_id
         WHERE devices.id = ?`,
      )
      .get(invitation.inviterDeviceId) as { displayName: string } | undefined;
    if (vault === undefined || inviter === undefined) {
      throw new InvitationError('REPOSITORY_INTEGRITY');
    }

    return {
      expiresAt: invitation.expiresAt,
      intendedMemberDisplayName: invitation.intendedMemberDisplayName,
      inviterDisplayName: inviter.displayName,
      memberId: invitation.intendedMemberId,
      vaultId: invitation.vaultId,
      vaultName: vault.displayName,
    };
  }

  /**
   * Single-use redemption driven entirely by the joining device: the server
   * generates the device identity and a pending-poll credential, binds the
   * device's own initial refresh token (hash only) to activate on approval, and
   * returns the verification phrase. It never mints vault credentials here.
   */
  public redeemInvitationForOnboarding(
    input: RedeemForOnboardingInput,
  ): RedeemForOnboardingResult {
    let tokenHash: string;
    let refreshTokenHash: string;
    try {
      tokenHash = hashInvitationToken(
        parseInvitationToken(input.invitationToken),
      );
      refreshTokenHash = hashRefreshToken(
        parseRefreshToken(input.initialRefreshToken),
      );
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }
    const deviceDisplayName = requireDisplayName(input.deviceLabel);
    requireUuid(input.redemptionId);
    const now = readClock(this.#now);
    const createdAt = now.toISOString();
    const pendingCredential = generatePendingDeviceCredential();
    const pendingCredentialHash = hashPendingDeviceCredential(pendingCredential);

    const redeem = this.#database.transaction((): RedeemOutcome => {
      const invitation = this.#loadInvitationByHash(tokenHash);
      if (invitation.consumedAt !== null) {
        throw new InvitationError('INVITATION_ALREADY_REDEEMED');
      }
      if (requireStoredDate(invitation.expiresAt) <= now.getTime()) {
        this.#burnInvitation(invitation.id, createdAt);
        return { kind: 'expired' };
      }
      if (
        invitation.intendedMemberId === null ||
        invitation.intendedMemberDisplayName === null
      ) {
        throw new InvitationError('REPOSITORY_INTEGRITY');
      }

      const userId = invitation.intendedMemberId;
      const deviceId = this.#newUuid();
      this.#database
        .prepare(
          `INSERT INTO users (
             id, display_name, is_instance_owner, status, created_at, revoked_at
           ) VALUES (?, ?, 0, 'active', ?, NULL)`,
        )
        .run(userId, invitation.intendedMemberDisplayName, createdAt);
      this.#database
        .prepare(
          `INSERT INTO devices (
             id, user_id, display_name, public_key, status,
             created_at, approved_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
        )
        .run(deviceId, userId, deviceDisplayName, randomBytes(PUBLIC_KEY_LENGTH), createdAt);

      const consumed = this.#database
        .prepare(
          `UPDATE invitations
           SET consumed_at = ?, consumed_by_user_id = ?, pending_device_id = ?,
               pending_credential_hash = ?, pending_refresh_token_hash = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(
          createdAt,
          userId,
          deviceId,
          pendingCredentialHash,
          refreshTokenHash,
          invitation.id,
        );
      if (consumed.changes !== 1) {
        throw new InvitationError('INVITATION_ALREADY_REDEEMED');
      }

      const verificationPhrase = deriveVerificationPhrase(
        parseVerificationSecret(invitation.verificationSecret),
        {
          invitationId: invitation.id,
          inviterDeviceId: invitation.inviterDeviceId,
          pendingDeviceId: deviceId,
          vaultId: invitation.vaultId,
        },
      );

      return {
        kind: 'ok',
        result: {
          invitationId: invitation.id,
          pendingDeviceId: deviceId,
          state: 'pending_approval',
          userId,
          verificationPhrase,
        },
      };
    });

    const outcome = redeem.immediate();
    if (outcome.kind === 'expired') {
      throw new InvitationError('INVITATION_EXPIRED');
    }
    return {
      pendingCredential,
      pendingDeviceId: outcome.result.pendingDeviceId,
      verificationPhrase: outcome.result.verificationPhrase,
    };
  }

  /**
   * Resolves the approval state for a redeemed device using its pending-poll
   * credential. The credential is matched by hash, so a wrong credential is
   * indistinguishable from an unknown invitation.
   */
  public getApprovalStatus(
    pendingDeviceId: string,
    rawPendingCredential: string,
  ): ApprovalStatus {
    requireUuid(pendingDeviceId);
    let credentialHash: string;
    try {
      credentialHash = hashPendingDeviceCredential(
        parsePendingDeviceCredential(rawPendingCredential),
      );
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }

    const invitation = this.#database
      .prepare(
        `${INVITATION_SELECT} WHERE pending_credential_hash = ?`,
      )
      .get(credentialHash) as InvitationRow | undefined;
    if (
      invitation === undefined ||
      invitation.pendingDeviceId !== pendingDeviceId
    ) {
      throw new InvitationError('INVALID_INVITATION');
    }

    const device = this.#database
      .prepare('SELECT status FROM devices WHERE id = ?')
      .get(pendingDeviceId) as { status: string } | undefined;
    if (device === undefined) {
      throw new InvitationError('INVALID_INVITATION');
    }
    if (device.status === 'pending') {
      return { status: 'pending' };
    }
    if (device.status === 'approved') {
      return { bootstrapCursor: null, deviceId: pendingDeviceId, status: 'approved' };
    }
    throw new InvitationError('INVALID_INVITATION');
  }

  /**
   * Owner approval of a redeemed device: verifies the phrase, activates the
   * membership and activates the joining device's own refresh family from the
   * hash stored at redemption. No token is issued to the owner.
   */
  public approveRedeemedDevice(
    input: ApproveRedeemedDeviceInput,
  ): ApproveRedeemedDeviceResult {
    const invitationId = requireUuid(input.invitationId);
    const approverMembershipId = requireUuid(input.approverMembershipId);
    let suppliedPhrase: string;
    try {
      suppliedPhrase = parseVerificationPhrase(input.verificationPhrase);
    } catch {
      throw new InvitationError('INVALID_INPUT');
    }
    const now = readClock(this.#now);
    const approvedAt = now.toISOString();

    const approve = this.#database.transaction((): ApproveOutcome => {
      const invitation = this.#loadInvitationById(invitationId);
      this.#requireOwnerMembership(approverMembershipId, invitation.vaultId);

      const pendingDeviceId = invitation.pendingDeviceId;
      const pendingUserId = invitation.consumedByUserId;
      const refreshTokenHash = invitation.pendingRefreshTokenHash;
      if (
        pendingDeviceId === null ||
        pendingUserId === null ||
        refreshTokenHash === null
      ) {
        throw new InvitationError('NO_PENDING_DEVICE');
      }
      const device = this.#database
        .prepare('SELECT status FROM devices WHERE id = ?')
        .get(pendingDeviceId) as { status: string } | undefined;
      if (device === undefined || device.status !== 'pending') {
        throw new InvitationError('NO_PENDING_DEVICE');
      }

      const expectedPhrase = deriveVerificationPhrase(
        parseVerificationSecret(invitation.verificationSecret),
        {
          invitationId: invitation.id,
          inviterDeviceId: invitation.inviterDeviceId,
          pendingDeviceId,
          vaultId: invitation.vaultId,
        },
      );
      if (suppliedPhrase !== expectedPhrase) {
        this.#deletePendingUser(pendingUserId);
        return { kind: 'mismatch' };
      }

      const approved = this.#database
        .prepare(
          `UPDATE devices SET status = 'approved', approved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(approvedAt, pendingDeviceId);
      if (approved.changes !== 1) {
        throw new InvitationError('REPOSITORY_INTEGRITY');
      }

      const membershipId = this.#newUuid();
      this.#database
        .prepare(
          `INSERT INTO memberships (
             id, vault_id, user_id, role, status, created_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .run(
          membershipId,
          invitation.vaultId,
          pendingUserId,
          this.#normalizeStoredRole(invitation.intendedRole),
          approvedAt,
        );

      const family =
        this.#sessions.createInitialFamilyFromHashInCurrentTransaction({
          deviceId: pendingDeviceId,
          refreshTokenHash,
          refreshTokenTtlSeconds: this.#refreshTokenTtlSeconds,
          userId: pendingUserId,
        });

      return {
        kind: 'ok',
        result: {
          accessExpiresAt: '',
          accessToken: '' as AccessToken,
          deviceId: pendingDeviceId,
          familyId: family.familyId,
          membershipId,
          refreshExpiresAt: family.refreshExpiresAt,
          userId: pendingUserId,
        },
      };
    });

    const outcome = approve.immediate();
    if (outcome.kind === 'mismatch') {
      throw new InvitationError('PHRASE_MISMATCH');
    }
    return {
      deviceId: outcome.result.deviceId,
      familyId: outcome.result.familyId,
      membershipId: outcome.result.membershipId,
      userId: outcome.result.userId,
    };
  }

  #loadInvitationByHash(tokenHash: string): InvitationRow {
    const row = this.#database
      .prepare(`${INVITATION_SELECT} WHERE token_hash = ?`)
      .get(tokenHash) as InvitationRow | undefined;
    if (row === undefined) {
      throw new InvitationError('INVALID_INVITATION');
    }
    return row;
  }

  #loadInvitationById(invitationId: string): InvitationRow {
    const row = this.#database
      .prepare(`${INVITATION_SELECT} WHERE id = ?`)
      .get(invitationId) as InvitationRow | undefined;
    if (row === undefined) {
      throw new InvitationError('INVALID_INVITATION');
    }
    return row;
  }

  #requireOwnerMembership(
    membershipId: string,
    vaultId: string,
  ): OwnerMembershipRow {
    const membership = this.#database
      .prepare(
        `SELECT user_id AS userId, role, status, vault_id AS vaultId
         FROM memberships WHERE id = ?`,
      )
      .get(membershipId) as OwnerMembershipRow | undefined;
    if (
      membership === undefined ||
      membership.status !== 'active' ||
      membership.role !== 'owner' ||
      membership.vaultId !== vaultId
    ) {
      throw new InvitationError('NOT_AUTHORIZED');
    }
    return membership;
  }

  #requireInviterDevice(inviterDeviceId: string, ownerUserId: string): void {
    const device = this.#database
      .prepare(
        'SELECT user_id AS userId, status FROM devices WHERE id = ?',
      )
      .get(inviterDeviceId) as
      | { userId: string; status: string }
      | undefined;
    if (
      device === undefined ||
      device.status !== 'approved' ||
      device.userId !== ownerUserId
    ) {
      throw new InvitationError('NOT_AUTHORIZED');
    }
  }

  #burnInvitation(invitationId: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE invitations SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(now, invitationId);
  }

  #deletePendingUser(userId: string): void {
    this.#database.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  #normalizeStoredRole(role: string): InvitationRole {
    if (role !== 'editor' && role !== 'owner') {
      throw new InvitationError('REPOSITORY_INTEGRITY');
    }
    return role;
  }

  #newUuid(): string {
    return requireUuid(this.#randomUuid());
  }
}

const INVITATION_SELECT = `
  SELECT id,
         vault_id AS vaultId,
         inviter_device_id AS inviterDeviceId,
         verification_secret AS verificationSecret,
         intended_role AS intendedRole,
         expires_at AS expiresAt,
         consumed_at AS consumedAt,
         consumed_by_user_id AS consumedByUserId,
         pending_device_id AS pendingDeviceId,
         intended_member_display_name AS intendedMemberDisplayName,
         intended_member_id AS intendedMemberId,
         pending_credential_hash AS pendingCredentialHash,
         pending_refresh_token_hash AS pendingRefreshTokenHash
  FROM invitations
`;
