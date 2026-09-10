/**
 * The vault roster read from the server (`GET /members`).
 *
 * The presence roster used to be assembled from what each device happened to
 * witness: the owner recorded a member at the moment it approved that member's
 * device, a guest recorded only itself. Two people in one vault therefore saw
 * different People lists. The server holds the truth (`memberships` joined to
 * `users`) and hands it back to any active member of the vault, so this module
 * fetches it and the plugin renders People from the answer.
 *
 * Access is the same rule `/bootstrap` applies: the refresh token travels in the
 * `x-havemind-refresh-token` header, never in the query string. The response
 * carries no endpoint, token or device detail, only who is in the vault and in
 * what role. Dependency-injected and free of Obsidian/DOM, mirroring
 * `remove-member.ts`, so it unit tests in isolation.
 */

import type { MemberRole, RosterMember } from './roster';
import type { RequestUrlFn } from './sync-transport';

const REFRESH_TOKEN_HEADER = 'x-havemind-refresh-token';

export interface FetchMemberRosterOptions {
  readonly apiBaseUrl: string;
  readonly requestUrl: RequestUrlFn;
  /** The stored refresh token; null when this device holds none. */
  readonly getRefreshToken: () => Promise<string | null>;
  /** Scopes the read to one vault; null lets the server pick the caller's own. */
  readonly vaultId: string | null;
  /** This device's own membership, so its row renders as "You". */
  readonly selfMembershipId: string | null;
}

export class MemberRosterError extends Error {
  override readonly name = 'MemberRosterError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMember(value: unknown, selfMembershipId: string | null): RosterMember {
  if (
    !isRecord(value) ||
    typeof value.membershipId !== 'string' ||
    typeof value.displayName !== 'string' ||
    (value.role !== 'owner' && value.role !== 'editor')
  ) {
    throw new MemberRosterError('The member roster response was malformed.');
  }
  const self = value.membershipId === selfMembershipId;
  return {
    // The local user's own row reads "You", matching how this device already
    // records its own membership (see `adoptSelfMembership`).
    displayName: self ? 'You' : value.displayName,
    membershipId: value.membershipId,
    role: value.role as MemberRole,
    self,
  };
}

/**
 * Reads the server-authoritative roster for the connected vault. Throws on any
 * transport, auth or shape failure so the caller can keep the roster it already
 * has rendered: an offline device must keep showing what it last knew rather
 * than blanking the People pane.
 */
export async function fetchMemberRoster(
  options: FetchMemberRosterOptions,
): Promise<RosterMember[]> {
  const refreshToken = await options.getRefreshToken();
  if (refreshToken === null) {
    throw new MemberRosterError(
      'No refresh token is stored for this device; the roster cannot be read.',
    );
  }
  const query =
    options.vaultId === null
      ? ''
      : `?vault=${encodeURIComponent(options.vaultId)}`;
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/members${query}`,
    method: 'GET',
    headers: { [REFRESH_TOKEN_HEADER]: refreshToken },
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new MemberRosterError(
      `The member roster request returned HTTP ${response.status}.`,
    );
  }
  const members = isRecord(response.json) ? response.json.members : undefined;
  if (!Array.isArray(members)) {
    throw new MemberRosterError('The member roster response was malformed.');
  }
  return members.map((entry) => parseMember(entry, options.selfMembershipId));
}
