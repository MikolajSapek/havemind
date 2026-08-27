/**
 * Owner-only "approve pending device" call against
 * `POST /vaults/:vaultId/invitations/:invitationId/approve` (F8-02d gap 2),
 * authenticated with a Bearer access token. The owner submits the verification
 * phrase the joining device read aloud; the server validates it and, on a match,
 * activates the pending membership.
 *
 * The verification phrase is a second-channel secret: it travels only in the
 * request body and is never placed in the URL, and it is never included in any
 * thrown error message (`plan/01` rule 4, secrets never in logs/reports).
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

export interface ApproveDeviceErrorOptions {
  /** How many code attempts remain before the invitation locks (wrong-code only). */
  readonly attemptsRemaining?: number;
  /** True once the invitation is locked and a fresh one must be minted. */
  readonly locked?: boolean;
}

export class ApproveDeviceError extends Error {
  override readonly name = 'ApproveDeviceError';
  /** Attempts left after a wrong code, when the server reported it. */
  readonly attemptsRemaining?: number;
  /** True when the invitation is now locked (too many wrong codes). */
  readonly locked: boolean;

  constructor(message: string, options: ApproveDeviceErrorOptions = {}) {
    super(message);
    this.locked = options.locked ?? false;
    if (options.attemptsRemaining !== undefined) {
      this.attemptsRemaining = options.attemptsRemaining;
    }
  }
}

const LOCKED_MESSAGE =
  'Too many incorrect codes. This invitation is now invalid, create a new one.';

const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  FORBIDDEN: 'You are not the owner of this vault, so you cannot approve here.',
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
    throw describeFailure(response.status, response.json);
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

/**
 * Maps a secret-free error body to a user-facing message. A wrong code carries
 * how many attempts remain (from the server-authoritative counter); the code
 * itself is never interpolated into the message.
 */
function describeFailure(status: number, json: unknown): ApproveDeviceError {
  const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const attemptsRemaining =
    typeof error?.attemptsRemaining === 'number'
      ? error.attemptsRemaining
      : undefined;

  if (code === 'PHRASE_MISMATCH') {
    const remaining = attemptsRemaining ?? 0;
    const plural = remaining === 1 ? 'attempt' : 'attempts';
    return new ApproveDeviceError(
      `Incorrect code, ${remaining} ${plural} left.`,
      { attemptsRemaining: remaining },
    );
  }
  if (code === 'APPROVAL_LOCKED') {
    return new ApproveDeviceError(LOCKED_MESSAGE, { locked: true });
  }
  const known = code === undefined ? undefined : MESSAGE_BY_CODE[code];
  if (known !== undefined) {
    return new ApproveDeviceError(known);
  }
  return new ApproveDeviceError(`Approval returned HTTP ${status}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
