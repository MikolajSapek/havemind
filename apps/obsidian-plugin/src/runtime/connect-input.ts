/**
 * Distinguishes the two things a user can paste into the Connect screen and the
 * owner-pairing HTTP call:
 *  - an owner pairing token (`hm_pt_…`) from `havemind setup`, redeemed at
 *    `POST /owner/pair` for the owner's first device;
 *  - an invitation envelope (`v1.…`) minted by the owner, redeemed through the
 *    invitee onboarding flow.
 */

import type { RequestUrlFn } from './sync-transport';

export type ConnectInputKind = 'pairing' | 'envelope' | 'unknown';

const PAIRING_PREFIX = 'hm_pt_';
const ENVELOPE_PREFIX = 'v1.';

export function classifyConnectInput(text: string): ConnectInputKind {
  const trimmed = text.trim();
  if (trimmed.startsWith(PAIRING_PREFIX)) return 'pairing';
  if (trimmed.startsWith(ENVELOPE_PREFIX)) return 'envelope';
  return 'unknown';
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
}

export class OwnerPairError extends Error {
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
  return { vaultId: json.vaultId, deviceId: json.deviceId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
