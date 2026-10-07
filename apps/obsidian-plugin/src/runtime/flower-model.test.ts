import { describe, expect, it } from 'vitest';

import { buildFlowerModel, type FlowerInput } from './flower-model';
import type { RosterMember } from './roster';

const me: RosterMember = { membershipId: 'm1', displayName: 'You', role: 'owner', self: true };
const phone: RosterMember = { membershipId: 'm2', displayName: 'MIKI IPHONE', role: 'editor', self: false };
const hubert: RosterMember = { membershipId: 'm3', displayName: 'Hubert', role: 'editor', self: false };

function input(overrides: Partial<FlowerInput> = {}): FlowerInput {
  return { members: [phone, me, hubert], status: 'synced', ...overrides };
}

describe('buildFlowerModel', () => {
  it('puts this device on top, the others after it, then free seats', () => {
    const model = buildFlowerModel(input());
    expect(model.seats.map((seat) => [seat.kind, seat.label])).toEqual([
      ['member', 'you'],
      ['member', 'MI'],
      ['member', 'H'],
      ['free', ''],
      ['free', ''],
      ['free', ''],
    ]);
    expect(model.core).toBe('done');
  });

  it('turns the core green only when everything is in sync, never mid-sync or in a conflict', () => {
    expect(buildFlowerModel(input({ status: 'synced' })).core).toBe('done');
    expect(buildFlowerModel(input({ status: 'syncing' })).core).toBe('syncing');
    expect(buildFlowerModel(input({ status: 'conflict' })).core).toBe('alive');
  });

  it('spins the core while syncing and dashes it when the server is out of reach', () => {
    expect(buildFlowerModel(input({ status: 'syncing' })).core).toBe('syncing');
    expect(buildFlowerModel(input({ status: 'retrying' })).core).toBe('syncing');
    for (const status of ['offline', 'reconnect-required', 'reset-required', 'disconnected'] as const) {
      const model = buildFlowerModel(input({ status }));
      expect(model.core).toBe('unreachable');
      expect(model.seats[0]?.kind).toBe('self-offline');
    }
  });

  it('never claims anything about other devices beyond membership', () => {
    const model = buildFlowerModel(input({ status: 'offline' }));
    expect(model.seats[1]?.kind).toBe('member');
    expect(model.seats[2]?.kind).toBe('member');
  });

  it('splits the seat of a member who is the other side of a conflict', () => {
    const model = buildFlowerModel(input({ conflictAuthors: ['MIKI IPHONE', null] }));
    expect(model.seats[1]).toMatchObject({ kind: 'conflict', label: 'MI' });
    expect(model.seats[2]?.kind).toBe('member');
  });

  it('shows a waiting device in the first free seat', () => {
    const model = buildFlowerModel(input({ pendingJoins: 1 }));
    expect(model.seats[3]).toMatchObject({ kind: 'joining', label: '?' });
    expect(model.seats[4]?.kind).toBe('free');
  });

  it('keeps this device and four others above six members, then a +N seat', () => {
    const others: RosterMember[] = Array.from({ length: 7 }, (_, i) => ({
      membershipId: `x${i}`,
      displayName: `Member ${String.fromCharCode(65 + i)}`,
      role: 'editor',
      self: false,
    }));
    const model = buildFlowerModel(
      input({ members: [...others, me], recentActorIds: ['x6', 'x5'], pendingJoins: 1 }),
    );
    expect(model.seats.map((seat) => seat.label)).toEqual(['you', 'MG', 'MF', 'MA', 'MB', '+3']);
    expect(model.seats[5]?.kind).toBe('more');
  });

  it('uses unique initials when two members would collide', () => {
    const mikolaj: RosterMember = { membershipId: 'm5', displayName: 'Mikołaj Sapek', role: 'editor', self: false };
    const magda: RosterMember = { membershipId: 'm4', displayName: 'Magda Smith', role: 'editor', self: false };
    const model = buildFlowerModel(input({ members: [me, mikolaj, magda] }));
    expect(model.seats.slice(0, 3).map((seat) => seat.label)).toEqual(['you', 'Mi', 'Ma']);
  });

  it('labels this device "you", never initials of the "You" placeholder', () => {
    const yvonne: RosterMember = { membershipId: 'm6', displayName: 'Yvonne', role: 'editor', self: false };
    const model = buildFlowerModel(input({ members: [me, yvonne] }));
    expect(model.seats.slice(0, 2).map((seat) => seat.label)).toEqual(['you', 'Y']);
  });

  it('says "1 device", and counts the hidden members exactly', () => {
    expect(buildFlowerModel({ members: [me], status: 'synced' }).description).toBe(
      'Server connected. 1 device: this device.',
    );
    const others: RosterMember[] = Array.from({ length: 7 }, (_, i) => ({
      membershipId: `y${i}`,
      displayName: `Person ${String.fromCharCode(65 + i)}`,
      role: 'editor',
      self: false,
    }));
    // No self row (a roster the server has not finished): 7 members, 4 shown.
    const model = buildFlowerModel({ members: others, status: 'synced' });
    expect(model.seats[5]).toMatchObject({ kind: 'more', label: '+3' });
  });

  it('keeps the other side of a conflict visible when the vault outgrows six', () => {
    const others: RosterMember[] = Array.from({ length: 7 }, (_, i) => ({
      membershipId: `z${i}`,
      displayName: `Person ${String.fromCharCode(65 + i)}`,
      role: 'editor',
      self: false,
    }));
    const model = buildFlowerModel({ members: [me, ...others], status: 'synced', conflictAuthors: ['Person G'] });
    expect(model.seats.find((seat) => seat.kind === 'conflict')?.label).toBe('PG');
  });

  it('describes itself for a screen reader', () => {
    const model = buildFlowerModel(input({ status: 'offline', conflictAuthors: ['Hubert'] }));
    expect(model.description).toBe(
      'Server out of reach. 3 devices: this device (offline), MIKI IPHONE, Hubert (conflict).',
    );
  });

  it('draws an empty flower before the first connection', () => {
    const model = buildFlowerModel({ members: [], status: 'disconnected' });
    expect(model.core).toBe('unreachable');
    expect(model.seats[0]).toMatchObject({ kind: 'self-offline', label: 'you' });
    expect(model.seats.slice(1).every((seat) => seat.kind === 'free')).toBe(true);
  });
});
