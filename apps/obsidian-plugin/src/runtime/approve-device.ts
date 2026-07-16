/**
 * Owner-only "approve pending device" call against
 * `POST /vaults/:vaultId/invitations/:invitationId/approve` (F8-02d gap 2),
 * authenticated with a Bearer access token. The owner submits the verification
 * phrase the joining device read aloud; the server validates it and, on a match,
 * activates the pending membership.
 *
 * The verification phrase is a second-channel secret: it travels only in the
 * request body and is never placed in the URL, and it is never included in any
 * thrown error message (`plan/01` rule 4 — secrets never in logs/reports).
 */

import type { RequestUrlFn } from './sync-transport';

export interface ApproveDeviceOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly invitationId: string;
  /** The phrase the joining device displayed and read aloud to the owner. */
  readonly verificationPhrase: string;
  readonly getAccessToken: () => Promise<string>;
}

export interface ApprovedDevice {
  readonly deviceId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly status: 'approved';
}

export class ApproveDeviceError extends Error {
  override readonly name = 'ApproveDeviceError';
}

const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  FORBIDDEN:
    'The phrase does not match this pending device, or you are not the owner.',
  NOT_FOUND: 'No pending device is waiting for this invitation.',
  REDEEMED: 'This invitation has no device awaiting approval.',
  GONE: 'This invitation has expired. Create a new one.',
};

export async function approveRedeemedDevice(
  options: ApproveDeviceOptions,
): Promise<ApprovedDevice> {
  const token = await options.getAccessToken();
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/vaults/${options.vaultId}/invitations/${options.invitationId}/approve`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    throw: false,
    body: JSON.stringify({ verificationPhrase: options.verificationPhrase }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ApproveDeviceError(describeFailure(response.status, response.json));
  }

  const json = response.json;
  if (
    !isRecord(json) ||
    typeof json.deviceId !== 'string' ||
    typeof json.membershipId !== 'string' ||
    typeof json.userId !== 'string'
  ) {
    throw new ApproveDeviceError('The approval response was malformed.');
  }

  return {
    deviceId: json.deviceId,
    membershipId: json.membershipId,
    userId: json.userId,
    status: 'approved',
  };
}

function describeFailure(status: number, json: unknown): string {
  const code =
    isRecord(json) && isRecord(json.error) && typeof json.error.code === 'string'
      ? json.error.code
      : undefined;
  if (code !== undefined && MESSAGE_BY_CODE[code] !== undefined) {
    return MESSAGE_BY_CODE[code];
  }
  return `Approval returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
