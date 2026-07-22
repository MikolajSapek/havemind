/**
 * F9 Remove member (owner side, client transport).
 *
 * The owner permanently revokes a member's connection to the vault by calling
 * `POST /owner/memberships/:membershipId/revoke`. The server revocation is
 * append-only — the member's past revisions and attribution survive — but their
 * membership and devices are terminally locked out. Re-adding the member later
 * requires a fresh invitation and full pairing (rejoin cannot re-admit a revoked
 * member). This module is dependency-injected and free of Obsidian/DOM so it
 * unit tests in isolation (mirrors `requestRejoinGrant`).
 */

import type { RequestUrlFn } from './sync-transport';

export interface RevokeMembershipOptions {
  readonly apiBaseUrl: string;
  readonly requestUrl: RequestUrlFn;
  readonly getAccessToken: () => Promise<string>;
  /** The member to remove, from the owner's local roster. */
  readonly membershipId: string;
}

export interface MembershipRemoved {
  readonly status: 'removed';
  readonly membershipId: string;
}

export class RevokeMembershipError extends Error {
  override readonly name = 'RevokeMembershipError';
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Owner action: permanently remove a member from the vault. On success the
 * owner UI drops the member from its roster and shows a confirmation Notice.
 */
export async function revokeMembership(
  options: RevokeMembershipOptions,
): Promise<MembershipRemoved> {
  const token = await options.getAccessToken();
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/owner/memberships/${options.membershipId}/revoke`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    throw: false,
    body: JSON.stringify({}),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new RevokeMembershipError(
      `Remove member request failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return { membershipId: options.membershipId, status: 'removed' };
}
