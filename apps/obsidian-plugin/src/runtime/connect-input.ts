/**
 * Distinguishes the two things a user can paste into the Connect screen and the
 * owner-pairing HTTP call:
 *  - an owner pairing token (`hm_pt_…`) from `havemind setup`, redeemed at
 *    `POST /owner/pair` for the owner's first device;
 *  - an invitation envelope (`v1.…`) minted by the owner, redeemed through the
 *    invitee onboarding flow.
 */

import type { RequestUrlFn } from './sync-transport';
import { isRecord } from './is-record';

export type ConnectInputKind = 'pairing' | 'envelope' | 'unknown';

const PAIRING_PREFIX = 'hm_pt_';
const ENVELOPE_PREFIX = 'v1.';

export function classifyConnectInput(text: string): ConnectInputKind {
  const trimmed = text.trim();
  if (trimmed.startsWith(PAIRING_PREFIX)) return 'pairing';
  if (trimmed.startsWith(ENVELOPE_PREFIX)) return 'envelope';
  return 'unknown';
}

function originOf(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * The owner's pairing input, as one paste or two fields (plan 013). The
 * installer prints `hm_pt_…@https://server`, so the owner pastes one line; the
 * token alone plus the Server URL field still works. The code is typed by the
 * owner from their own terminal, never taken from a link (see
 * `isSafePassiveJoinProtocolData`).
 */
export function resolvePairingCode(
  input: string,
  serverField: string,
): { readonly pairingToken: string; readonly serverUrl: string } {
  const trimmed = input.trim();
  const at = trimmed.indexOf('@');
  if (at === -1) return { pairingToken: trimmed, serverUrl: serverField.trim() };
  const pairingToken = trimmed.slice(0, at);
  const embedded = trimmed.slice(at + 1);
  const embeddedOrigin = originOf(embedded) ?? embedded;
  const field = serverField.trim();
  if (field.length > 0 && originOf(field) !== embeddedOrigin) {
    throw new Error(`the code is for ${embeddedOrigin}, but the Server URL field says ${field}. Clear the field or use the matching code.`);
  }
  return { pairingToken, serverUrl: embeddedOrigin };
}

export interface PairOwnerDeviceOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly deviceLabel: string;
  /**
   * SHA-256 hex of the client-held refresh token. Only the hash crosses the
   * wire; the server binds the refresh family to it and the client keeps the
   * raw secret (mirrors the invitee redeem contract).
   */
  readonly initialRefreshTokenHash: string;
  readonly pairingToken: string;
}

export interface OwnerPairing {
  readonly vaultId: string;
  readonly deviceId: string;
  /**
   * Server membership id for the owner, when the pairing response supplies it.
   * Required before the owner device can build push revision headers (rule 3).
   */
  readonly memberId?: string;
}

class OwnerPairError extends Error {
  override readonly name = 'OwnerPairError';
}

export async function pairOwnerDevice(
  options: PairOwnerDeviceOptions,
): Promise<OwnerPairing> {
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/owner/pair`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    throw: false,
    body: JSON.stringify({
      deviceLabel: options.deviceLabel,
      initialRefreshTokenHash: options.initialRefreshTokenHash,
      pairingToken: options.pairingToken,
    }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new OwnerPairError(`Owner pairing returned HTTP ${response.status}.`);
  }
  const json = response.json;
  if (
    !isRecord(json) ||
    typeof json.vaultId !== 'string' ||
    typeof json.deviceId !== 'string'
  ) {
    throw new OwnerPairError('Owner pairing response was malformed.');
  }
  return {
    vaultId: json.vaultId,
    deviceId: json.deviceId,
    ...(typeof json.membershipId === 'string'
      ? { memberId: json.membershipId }
      : {}),
  };
}
