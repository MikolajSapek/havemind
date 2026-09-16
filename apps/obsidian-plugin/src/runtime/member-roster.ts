/**
 * The vault roster read from the server.
 *
 * The presence roster used to be assembled from what each device happened to
 * witness: the owner recorded a member at the moment it approved that member's
 * device, a guest recorded only itself. Two people in one vault therefore saw
 * different People lists. The server holds the truth (`memberships` joined to
 * `users`) and hands it back to any active member of the vault, so this module
 * fetches it and the plugin renders People from the answer.
 *
 * Prefer the same Bearer path sync already uses (`GET /vaults/:vaultId/members`).
 * That route is behind the live access-token rotation the sync loop keeps warm,
 * so a connected device does not open a second auth path just to draw People.
 * When that response lacks membership ids (older servers) or no access token is
 * available yet, fall back to `GET /members` with the refresh token — the same
 * access rule `/bootstrap` applies. Dependency-injected and free of Obsidian/DOM,
 * mirroring `remove-member.ts`, so it unit tests in isolation.
 */

import type { MemberRole, RosterMember } from './roster';
import type { RequestUrlFn } from './sync-transport';

const REFRESH_TOKEN_HEADER = 'x-havemind-refresh-token';

export interface FetchMemberRosterOptions {
  readonly apiBaseUrl: string;
  readonly requestUrl: RequestUrlFn;
  /**
   * Short-lived access token from the live sync session. When present and the
   * vault id is known, the Bearer roster is tried first.
   */
  readonly getAccessToken?: () => Promise<string | null>;
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

function parseMembersPayload(
  json: unknown,
  selfMembershipId: string | null,
): RosterMember[] {
  const members = isRecord(json) ? json.members : undefined;
  if (!Array.isArray(members)) {
    throw new MemberRosterError('The member roster response was malformed.');
  }
  return members.map((entry) => parseMember(entry, selfMembershipId));
}

/**
 * True when every row carries a membership id. Older `/vaults/:id/members`
 * responses listed only displayName + role; those cannot drive the People list
 * (colour, remove, rejoin) and must fall through to `GET /members`.
 */
function hasMembershipIds(json: unknown): boolean {
  const members = isRecord(json) ? json.members : undefined;
  if (!Array.isArray(members) || members.length === 0) {
    // Empty is a valid roster; the Bearer path already answered.
    return Array.isArray(members);
  }
  return members.every(
    (entry) => isRecord(entry) && typeof entry.membershipId === 'string',
  );
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
  if (options.vaultId !== null && options.getAccessToken !== undefined) {
    const accessToken = await options.getAccessToken();
    if (accessToken !== null) {
      const bearerResponse = await options.requestUrl({
        url: `${options.apiBaseUrl}/vaults/${options.vaultId}/members`,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });
      if (bearerResponse.status >= 200 && bearerResponse.status < 300) {
        if (hasMembershipIds(bearerResponse.json)) {
          return parseMembersPayload(
            bearerResponse.json,
            options.selfMembershipId,
          );
        }
        // Older server: quota route without membership ids. Fall through.
      } else if (bearerResponse.status !== 401 && bearerResponse.status !== 403) {
        throw new MemberRosterError(
          `The member roster request returned HTTP ${bearerResponse.status}.`,
        );
      }
      // 401/403: try the refresh-token path before giving up.
    }
  }

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
  return parseMembersPayload(response.json, options.selfMembershipId);
}
