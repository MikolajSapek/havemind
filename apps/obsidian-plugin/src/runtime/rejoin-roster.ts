/**
 * Roster view for the People tab (owner side).
 *
 * The server reports no presence, so the view claims none: every other member
 * can be sent a Rejoin grant (harmless for a healthy device, which never asks
 * for it) and removed. The owner's own row offers neither.
 */

import { authorColorToken } from './author-colors';
import type { MemberRole, RosterMember } from './roster';

export interface RejoinRosterRowView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: MemberRole;
  /** The owner may issue a Rejoin grant; never for the owner's own row. */
  readonly rejoinable: boolean;
  /** The owner may remove the member; never the owner's own row. */
  readonly removable: boolean;
  readonly colorToken: string;
  readonly self: boolean;
}

export interface RejoinRosterView {
  readonly empty: boolean;
  readonly rows: readonly RejoinRosterRowView[];
}

/** Rows ordered owner first, then by display name. */
export function buildRejoinRosterView(members: readonly RosterMember[]): RejoinRosterView {
  const rows = [...members]
    .sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'owner' ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    })
    .map(
      (member): RejoinRosterRowView => ({
        colorToken: authorColorToken(member.membershipId),
        displayName: member.displayName,
        membershipId: member.membershipId,
        rejoinable: !member.self,
        removable: !member.self,
        role: member.role,
        self: member.self,
      }),
    );
  return { empty: rows.length === 0, rows };
}
