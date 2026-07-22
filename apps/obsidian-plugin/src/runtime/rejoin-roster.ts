/**
 * Rejoin-aware roster view (F9 Rejoin, owner side).
 *
 * The base roster (`roster.ts`) treats every approved member as permanently
 * connected — presence is connection state, not activity, and there is no
 * inactivity timeout. Rejoin adds ONE new fact on top of that model: a member
 * whose connection is KNOWN-DEAD (its refresh family was burned / it hit a
 * terminal 401 / it was quarantined). Such a member is drawn as "disconnected"
 * and gains a Rejoin affordance so the owner can re-admit that exact contact
 * without re-running pairing.
 *
 * This is a pure projection over the persistent roster plus the set of
 * known-dead membership ids the owner's client has observed; it never mutates
 * the base roster and never derives "disconnected" from mere inactivity. Colour
 * is always paired with a name + a text status label (never colour alone), per
 * the project accessibility rule.
 */

import { authorColorToken } from './author-colors';
import type { MemberRole, RosterMember } from './roster';

/** One rendered roster row with a rejoin affordance when the member is dead. */
export interface RejoinRosterRowView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: MemberRole;
  /** Persistent connection state — false only for a known-dead member. */
  readonly connected: boolean;
  /** Text/aria label paired with the colour dot — never colour alone. */
  readonly statusLabel: 'connected' | 'disconnected';
  /**
   * True only for a disconnected, non-self member: the owner may click Rejoin.
   * A connected member and the owner's own row are never rejoinable.
   */
  readonly rejoinable: boolean;
  /**
   * True for every non-self member: the owner may permanently remove them from
   * the vault. Unlike `rejoinable`, this is independent of connection state — a
   * member can be removed whether connected or disconnected. The owner's own row
   * is never removable.
   */
  readonly removable: boolean;
  readonly colorToken: string;
  readonly self: boolean;
}

export interface RejoinRosterView {
  readonly empty: boolean;
  readonly rows: readonly RejoinRosterRowView[];
}

/**
 * Builds the rejoin-aware roster view. Rows are ordered owner-first then by
 * display name (stable as the list grows). A member is "disconnected" — and
 * therefore rejoinable — only when its membership id is in `deadMembershipIds`
 * and it is not the local user's own row.
 */
export function buildRejoinRosterView(
  members: readonly RosterMember[],
  deadMembershipIds: readonly string[] = [],
): RejoinRosterView {
  const dead = new Set(deadMembershipIds);
  const rows = [...members]
    .sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'owner' ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    })
    .map((member): RejoinRosterRowView => {
      // The owner never rejoins itself, so a self row is always connected.
      const isDead = !member.self && dead.has(member.membershipId);
      return {
        colorToken: authorColorToken(member.membershipId),
        connected: !isDead,
        displayName: member.displayName,
        membershipId: member.membershipId,
        rejoinable: isDead,
        // Removal is state-independent: every non-self member can be removed,
        // connected or not. The owner's own row is never removable.
        removable: !member.self,
        role: member.role,
        self: member.self,
        statusLabel: isDead ? 'disconnected' : 'connected',
      };
    });
  return { empty: rows.length === 0, rows };
}
