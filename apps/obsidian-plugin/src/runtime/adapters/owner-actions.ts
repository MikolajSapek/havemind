/**
 * The four owner-authenticated one-shot actions the UI can invoke on a connected
 * vault: mint an invitation, approve a redeemed device, issue a rejoin grant for a
 * dead contact, and revoke a membership. Each resolves the connected vault (owner
 * pairing or invitee onboarding), builds a short-lived access provider over the
 * stored refresh token, performs exactly one authenticated call, and returns null
 * rather than throwing when this device is not connected, so the caller can
 * prompt "connect first" instead of surfacing an auth error. Secrets and
 * verification phrases are forwarded to request bodies only, never logged.
 */

import type { Plugin } from 'obsidian';

import { RefreshTokenAccessProvider } from '../access-token';
import { approveRedeemedDevice, type ApprovedDevice } from '../approve-device';
import {
  createVaultInvitation,
  type CreatedInvitation,
} from '../create-invitation';
import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { listPendingApprovals, type PendingApproval } from '../list-pending-approvals';
import { requestRejoinGrant, type RejoinGrantWaiting } from '../rejoin';
import { revokeMembership, type MembershipRemoved } from '../remove-member';
import { ensureClientInstanceId } from '../../storage/client-store';

import { resolveConnectedVault } from './onboarding-wiring';
import { createClientInstanceRepo } from './plugin-data-ports';
import { createRequestUrlFn } from './request-url';
import {
  generateRefreshTokenValue,
  generateRotationIdValue,
} from './tokens';

/**
 * Owner-only: mint a new invitation for the connected vault and return the
 * copyable envelope. Requires an already-connected owner session; returns null
 * if the vault is not connected. The envelope (which contains the secret) is
 * returned for display only and is never logged.
 */
export async function createInvitationForOwner(
  plugin: Plugin,
  options?: { intendedRole?: 'editor' | 'owner'; intendedMemberDisplayName?: string },
): Promise<CreatedInvitation | null> {
  // The owner may be connected via /owner/pair (an ownerConnection record) or via
  // the invitee onboarding flow (a connected onboarding state). Resolve either.
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    // GAP-5: durable in-flight rotation persistence. Connect-safe, the
    // provider swallows any load/save/clear failure and degrades to
    // in-memory-only, so a SecretStorage outage never aborts connect or sync.
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });

  return createVaultInvitation({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    serverOrigin: connected.serverOrigin,
    vaultId: connected.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
    ...(options?.intendedRole === undefined
      ? {}
      : { intendedRole: options.intendedRole }),
    ...(options?.intendedMemberDisplayName === undefined
      ? {}
      : { intendedMemberDisplayName: options.intendedMemberDisplayName }),
  });
}

/**
 * Owner-only: approve the device that redeemed an invitation and read out
 * `verificationPhrase`. Requires an already-connected owner session; returns
 * null if the vault is not connected. The phrase is a second-channel secret
 * and is never logged (only forwarded to the request body).
 */
export async function approvePendingDeviceForOwner(
  plugin: Plugin,
  options: { invitationId: string; verificationPhrase: string },
): Promise<ApprovedDevice | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    // GAP-5: durable in-flight rotation persistence. Connect-safe, the
    // provider swallows any load/save/clear failure and degrades to
    // in-memory-only, so a SecretStorage outage never aborts connect or sync.
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });

  return approveRedeemedDevice({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    invitationId: options.invitationId,
    verificationPhrase: options.verificationPhrase,
    getAccessToken: () => accessProvider.getAccessToken(),
  });
}

/** Reads the server-authoritative, secret-free pending approval queue. */
export async function listPendingApprovalsForOwner(
  plugin: Plugin,
): Promise<readonly PendingApproval[] | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) return null;
  const clientInstanceId = await ensureClientInstanceId(createClientInstanceRepo(plugin));
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });
  return listPendingApprovals({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
  });
}

/**
 * Owner-only (F9 Rejoin): issue a rejoin grant for a known, currently-dead
 * contact. Requires an already-connected owner session (mirrors
 * `createInvitationForOwner`); returns null when the vault is not connected so
 * the caller can prompt the owner to connect first. Nothing secret is returned,
 * only the non-secret "waiting for the contact to reconnect" acknowledgement.
 */
export async function requestRejoinGrantForOwner(
  plugin: Plugin,
  options: { membershipId: string },
): Promise<RejoinGrantWaiting | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    // GAP-5: durable in-flight rotation persistence. Connect-safe, the
    // provider swallows any load/save/clear failure and degrades to
    // in-memory-only, so a SecretStorage outage never aborts connect or sync.
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });

  return requestRejoinGrant({
    apiBaseUrl: connected.apiBaseUrl,
    requestUrl: createRequestUrlFn(),
    getAccessToken: () => accessProvider.getAccessToken(),
    membershipId: options.membershipId,
  });
}

/**
 * Owner action: permanently remove a member from the connected vault via the
 * authenticated transport. Returns `null` when this device is not connected as
 * the vault owner (nothing to authenticate with); otherwise resolves once the
 * server has revoked the membership. Nothing secret is sent or logged.
 */
export async function revokeMembershipForOwner(
  plugin: Plugin,
  options: { membershipId: string },
): Promise<MembershipRemoved | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    // GAP-5: durable in-flight rotation persistence. Connect-safe, the
    // provider swallows any load/save/clear failure and degrades to
    // in-memory-only, so a SecretStorage outage never aborts connect or sync.
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });

  return revokeMembership({
    apiBaseUrl: connected.apiBaseUrl,
    requestUrl: createRequestUrlFn(),
    getAccessToken: () => accessProvider.getAccessToken(),
    membershipId: options.membershipId,
  });
}
