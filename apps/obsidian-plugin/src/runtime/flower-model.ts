/**
 * What the flower shows: the core is the server, each seat a vault member.
 *
 * Only what this device knows goes in. It knows the roster, its own connection
 * state, the conflicts it holds and the devices waiting for approval. It does
 * NOT know whether another device is online or up to date, so a member's seat
 * only ever says "is a member" (or "the other side of a conflict"). Pure, no DOM.
 */

import type { ConnectionStatus } from './status';
import type { RosterMember } from './roster';
import { assignInitials } from './initials';

export const FLOWER_SEATS = 6;

export type FlowerCore = 'done' | 'alive' | 'syncing' | 'unreachable';

export type FlowerSeatKind = 'member' | 'self-offline' | 'conflict' | 'joining' | 'more' | 'free';

export interface FlowerSeat {
  readonly kind: FlowerSeatKind;
  /** Initials, "?" for a joining device, "+N" for the overflow seat, "" when free. */
  readonly label: string;
}

export interface FlowerModel {
  readonly core: FlowerCore;
  /** Always six, clockwise from the top; this device is the first. */
  readonly seats: readonly FlowerSeat[];
  /** The whole picture in words, for the SVG's accessible name. */
  readonly description: string;
}

export interface FlowerInput {
  readonly members: readonly RosterMember[];
  readonly status: ConnectionStatus;
  /** Authors of the open conflict copies; null when a copy has no known author. */
  readonly conflictAuthors?: readonly (string | null)[];
  /** Devices waiting for the owner's approval. */
  readonly pendingJoins?: number;
  /** Activity authors, newest first: who keeps a seat when the vault outgrows six. */
  readonly recentActorIds?: readonly string[];
}

function coreFor(status: ConnectionStatus): FlowerCore {
  switch (status) {
    // Green means everything this device has is on the server. A conflict is
    // connected but not done, so it stays violet.
    case 'synced':
      return 'done';
    case 'syncing':
    case 'retrying':
      return 'syncing';
    case 'offline':
    case 'reconnect-required':
    case 'reset-required':
    case 'disconnected':
      return 'unreachable';
    default:
      return 'alive';
  }
}

const CORE_WORDS: Readonly<Record<FlowerCore, string>> = {
  done: 'Server connected.',
  alive: 'Server connected.',
  syncing: 'Syncing with the server.',
  unreachable: 'Server out of reach.',
};

/**
 * Who keeps a seat once the vault outgrows six: the other side of a conflict
 * first (the flower must never hide it), then recent activity, then roster
 * order; stable for ties.
 */
function orderOthers(
  others: readonly RosterMember[],
  recent: readonly string[],
  conflicted: ReadonlySet<string>,
): RosterMember[] {
  const rank = (member: RosterMember): number => {
    if (conflicted.has(member.displayName)) return -1;
    const index = recent.indexOf(member.membershipId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return others
    .map((member, index) => ({ member, index }))
    .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
    .map(({ member }) => member);
}

export function buildFlowerModel(input: FlowerInput): FlowerModel {
  const core = coreFor(input.status);
  const self = input.members.find((member) => member.self);
  const others = input.members.filter((member) => !member.self);
  // This device's own name arrives as "You" (member-roster.ts), so its seat
  // says "you" and only the others compete for unique initials.
  const initials = assignInitials(
    others.map((member) => ({ id: member.membershipId, name: member.displayName })),
  );
  const conflictNames = new Set(
    (input.conflictAuthors ?? []).filter((name): name is string => name !== null),
  );

  const overflow = input.members.length > FLOWER_SEATS;
  const shownOthers = overflow
    ? orderOthers(others, input.recentActorIds ?? [], conflictNames).slice(0, FLOWER_SEATS - 2)
    : others;

  const seats: FlowerSeat[] = [];
  const words: string[] = [];
  const selfKind = core === 'unreachable' ? 'self-offline' : 'member';
  seats.push({ kind: selfKind, label: self === undefined && input.members.length > 0 ? '' : 'you' });
  if (self !== undefined) {
    words.push(`this device${selfKind === 'self-offline' ? ' (offline)' : ''}`);
  }
  for (const member of shownOthers) {
    const conflict = conflictNames.has(member.displayName);
    seats.push({ kind: conflict ? 'conflict' : 'member', label: initials.get(member.membershipId) ?? '?' });
    words.push(conflict ? `${member.displayName} (conflict)` : member.displayName);
  }
  if (overflow) {
    // Count members, not seats: the first seat is "you" even before the
    // roster has a self row.
    const hidden = input.members.length - shownOthers.length - (self === undefined ? 0 : 1);
    seats.push({ kind: 'more', label: `+${hidden}` });
    words.push(`${hidden} more`);
  } else if ((input.pendingJoins ?? 0) > 0 && seats.length < FLOWER_SEATS) {
    seats.push({ kind: 'joining', label: '?' });
  }
  while (seats.length < FLOWER_SEATS) seats.push({ kind: 'free', label: '' });

  const description =
    input.members.length === 0
      ? 'Not connected yet.'
      : `${CORE_WORDS[core]} ${input.members.length} ${input.members.length === 1 ? 'device' : 'devices'}: ${words.join(', ')}.`;
  return { core, seats, description };
}
