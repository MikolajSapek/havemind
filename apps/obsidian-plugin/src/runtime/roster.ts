/**
 * Presence roster: who is connected to this vault.
 *
 * Presence here is CONNECTION STATE, not activity. Once the owner has invited
 * someone, set their display name and the approval succeeded, that member is a
 * PERSISTENT part of the roster with a green "connected" dot, and stays green
 * until the connection is explicitly torn down (a future `revoke` action, not
 * built here). The dot is NEVER derived from recent sync activity and there is
 * NO inactivity timeout: an established connection reads as connected until an
 * explicit teardown (see `plan/01` and the owner's design decision).
 *
 * Endpoint-free: the roster is sourced entirely from what the owner's client
 * already knows at approval time (each approved member's display name +
 * membershipId + role), persisted locally in `data.json`. It scales to N
 * members, a growing list, never hard-coded for two.
 *
 * This module is pure (no Obsidian/DOM/network) except for the persistence
 * boundary, which is injected. Colour comes from the shared `author-colors`
 * module so a member is drawn the same colour in the roster, the Activity log
 * and the F6 author overlay; colour is ALWAYS paired with a name + text label
 * (never colour alone) per the project accessibility rule.
 */

import { authorColorToken } from './author-colors';

export type MemberRole = 'owner' | 'editor';

/** A persistent, connected member of the vault (roster row source of truth). */
export interface RosterMember {
  /** Server membership id, the stable key for colour and identity. */
  readonly membershipId: string;
  /** Display name the owner set for this member (e.g. "Magda"), or the owner. */
  readonly displayName: string;
  readonly role: MemberRole;
  /** True for the local user's own membership (rendered as "You"). */
  readonly self: boolean;
}

/** One rendered roster row: name + role + persistent connected dot. */
export interface RosterRowView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: MemberRole;
  /** Persistent connection state, always true here (green until teardown). */
  readonly connected: true;
  /** Text/aria label paired with the colour dot, never colour alone. */
  readonly statusLabel: 'connected';
  /** Deterministic, stable colour token for this member. */
  readonly colorToken: string;
  readonly self: boolean;
}

export interface RosterView {
  readonly empty: boolean;
  readonly rows: readonly RosterRowView[];
}

/**
 * Immutably upsert a member by `membershipId` (approve-time record wins over an
 * older one). Returns a new array; never mutates the input.
 */
export function upsertRosterMember(
  roster: readonly RosterMember[],
  member: RosterMember,
): RosterMember[] {
  return [
    ...roster.filter((entry) => entry.membershipId !== member.membershipId),
    member,
  ];
}

/**
 * Immutably remove a member by `membershipId`. Returns a new array; never
 * mutates the input. A membership id that is not present is a harmless no-op.
 */
export function removeRosterMember(
  roster: readonly RosterMember[],
  membershipId: string,
): RosterMember[] {
  return roster.filter((entry) => entry.membershipId !== membershipId);
}

/**
 * Builds the "Connected" roster view. Rows are ordered owner-first, then by
 * display name, so the list is stable as it grows. Every row carries the
 * connected state + label + colour token together.
 */
export function buildRosterView(
  members: readonly RosterMember[],
): RosterView {
  const rows = [...members]
    .sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'owner' ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    })
    .map(
      (member): RosterRowView => ({
        membershipId: member.membershipId,
        displayName: member.displayName,
        role: member.role,
        connected: true,
        statusLabel: 'connected',
        colorToken: authorColorToken(member.membershipId),
        self: member.self,
      }),
    );
  return { empty: rows.length === 0, rows };
}

// ---------------------------------------------------------------------------
// Local persistence (endpoint-free source of truth)
// ---------------------------------------------------------------------------

const ROSTER_KEY = 'approvedMembersRoster';

/** Persistence boundary; wraps raw `Plugin.loadData`/`saveData` in production. */
export interface RosterPersistPort {
  load(): Promise<unknown>;
  save(data: Record<string, unknown>): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses one untrusted persisted roster entry, or null if malformed. */
function parseMember(value: unknown): RosterMember | null {
  if (
    !isRecord(value) ||
    typeof value.membershipId !== 'string' ||
    typeof value.displayName !== 'string' ||
    (value.role !== 'owner' && value.role !== 'editor') ||
    typeof value.self !== 'boolean'
  ) {
    return null;
  }
  return {
    membershipId: value.membershipId,
    displayName: value.displayName,
    role: value.role,
    self: value.self,
  };
}

/** Parses the untrusted persisted roster; a malformed blob degrades to []. */
export function parseRoster(raw: unknown): RosterMember[] {
  const source = isRecord(raw) ? raw[ROSTER_KEY] : null;
  if (!Array.isArray(source)) return [];
  const members: RosterMember[] = [];
  for (const entry of source) {
    const parsed = parseMember(entry);
    if (parsed !== null) {
      members.push(parsed);
    }
  }
  return members;
}

/**
 * Durable approved-members roster over the shared plugin-data blob. Records each
 * approved member as the owner approves it, and reads the persistent roster
 * back on demand. Only non-secret presence facts are stored (no tokens/PINs).
 */
export class RosterStore {
  private readonly persist: RosterPersistPort;

  constructor(options: { readonly persist: RosterPersistPort }) {
    this.persist = options.persist;
  }

  async readMembers(): Promise<RosterMember[]> {
    return parseRoster(await this.persist.load());
  }

  /** Upserts a member (idempotent by membershipId) and persists the roster. */
  async recordMember(member: RosterMember): Promise<RosterMember[]> {
    const data = await this.persist.load();
    const base = isRecord(data) ? data : {};
    const next = upsertRosterMember(parseRoster(data), member);
    await this.persist.save({ ...base, [ROSTER_KEY]: next });
    return next;
  }

  /**
   * Removes a member (idempotent by membershipId) and persists the roster.
   * Used when the owner permanently removes a member from the vault; the server
   * revocation is append-only, and here the owner's local presence list simply
   * drops the departed member.
   */
  async removeMember(membershipId: string): Promise<RosterMember[]> {
    const data = await this.persist.load();
    const base = isRecord(data) ? data : {};
    const next = removeRosterMember(parseRoster(data), membershipId);
    await this.persist.save({ ...base, [ROSTER_KEY]: next });
    return next;
  }
}
