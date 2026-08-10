/**
 * Invitee-side rejoin (F9): reading back this device's own persisted
 * (membershipId, deviceId, apiBaseUrl) binding and building the `RejoinController`
 * that polls for a grant after a terminal auth failure. An OWNER identity is
 * deliberately refused — completing a rejoin needs an authenticated owner session
 * the burned owner no longer has, so arming that poll could only spin forever.
 * The controller is handed pre-computed synchronous token ports because the
 * browser bundle's only hashing primitive is async and no new crypto may be added.
 */

import type { Plugin } from 'obsidian';

import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { RejoinController } from '../rejoin';
import { isConnectedOnboardingState } from '../connection';
import { ensureClientInstanceId } from '../../storage/client-store';

import { buildOnboardingController } from './onboarding-wiring';
import { readOwnerConnection } from './owner-connection';
import { createClientInstanceRepo } from './plugin-data-ports';
import { createRequestUrlFn } from './request-url';
import { generateRefreshTokenValue, sha256Hex } from './tokens';

/** The persisted (membershipId, deviceId, apiBaseUrl) an invitee presents on rejoin. */
interface RejoinIdentity {
  readonly apiBaseUrl: string;
  readonly deviceId: string;
  readonly membershipId: string;
  /**
   * Which side this device connected as. Only an invitee can complete a rejoin:
   * issuing the grant needs an authenticated owner session the burned owner no
   * longer has (the documented self-grant dead-end), so the owner poll can never
   * succeed and must not be armed (sweep-P1).
   */
  readonly role: 'owner' | 'invitee';
}

/**
 * Reads back this device's own rejoin identity from plugin data — the same
 * (membershipId, deviceId) binding it holds from onboarding/pairing. An owner
 * device carries them in its `ownerConnection` record; an invitee carries them
 * in its connected onboarding state (`memberId` is the active membership id).
 * Returns null when neither is present (nothing to rejoin with).
 */
async function readRejoinIdentity(
  plugin: Plugin,
): Promise<RejoinIdentity | null> {
  const owner = await readOwnerConnection(plugin);
  if (
    owner !== null &&
    owner.deviceId !== undefined &&
    owner.memberId !== undefined
  ) {
    return {
      apiBaseUrl: owner.apiBaseUrl,
      deviceId: owner.deviceId,
      membershipId: owner.memberId,
      role: 'owner',
    };
  }
  const { controller: onboarding } = await buildOnboardingController(plugin);
  const state = await onboarding.resume();
  if (isConnectedOnboardingState(state)) {
    const connected = state as unknown as {
      apiBaseUrl: string;
      deviceId: string;
      memberId: string;
    };
    if (
      typeof connected.deviceId === 'string' &&
      typeof connected.memberId === 'string'
    ) {
      return {
        apiBaseUrl: connected.apiBaseUrl,
        deviceId: connected.deviceId,
        membershipId: connected.memberId,
        role: 'invitee',
      };
    }
  }
  return null;
}

/**
 * Invitee-side (F9 Rejoin): build a `RejoinController` from this device's own
 * persisted binding after its session hit a terminal auth failure. Returns null
 * when no identity is stored (nothing to rejoin with).
 *
 * The `hashRefreshToken` port is synchronous, but the only hashing primitive
 * available in the browser-platform bundle (`crypto.subtle.digest`) is async —
 * and the build forbids `node:crypto`. So we generate ONE candidate refresh
 * token up front, hash it once here with the same SHA-256 hex helper every other
 * token uses (zero new crypto), then hand the controller stable synchronous
 * ports that always return that pre-computed pair. Reusing one candidate across
 * polls is safe: the raw token is only ever persisted and used once redemption
 * succeeds; on every unsuccessful poll only its hash is sent and never bound.
 */
export async function buildRejoinControllerForInvitee(
  plugin: Plugin,
): Promise<RejoinController | null> {
  const identity = await readRejoinIdentity(plugin);
  // No stored identity → nothing to rejoin with. An OWNER identity is a dead-end:
  // completing a rejoin needs an authenticated owner session to issue the grant,
  // which the burned owner no longer has (the documented self-grant dead-end).
  // Building a controller here would only arm a /auth/rejoin poll that can never
  // succeed, so skip it — the surfaced reconnect-required/connectionError state
  // already drives the correct owner recovery (retry / re-paste pairing token).
  // sweep-P1.
  if (identity === null || identity.role === 'owner') {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });

  // The per-device rejoin secret provisioned at onboarding. Without it the
  // device cannot rejoin (fail-closed): a device onboarded before this hardening
  // has none, so its rejoin poll can never succeed and re-onboarding is required.
  const rejoinSecret = await secrets.getRejoinSecret();
  if (rejoinSecret === null) {
    return null;
  }

  const candidateToken = generateRefreshTokenValue();
  const candidateTokenHash = await sha256Hex(candidateToken);

  return new RejoinController({
    apiBaseUrl: identity.apiBaseUrl,
    requestUrl: createRequestUrlFn(),
    membershipId: identity.membershipId,
    deviceId: identity.deviceId,
    rejoinSecret,
    generateRefreshToken: () => candidateToken,
    hashRefreshToken: () => candidateTokenHash,
    saveRefreshToken: (token) => secrets.saveRefreshToken(token),
  });
}
