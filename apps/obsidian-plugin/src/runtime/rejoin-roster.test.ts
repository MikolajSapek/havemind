import { describe, expect, it } from 'vitest';

import { buildRejoinRosterView } from './rejoin-roster';
import type { RosterMember } from './roster';

const owner: RosterMember = {
  membershipId: 'm-owner',
  displayName: 'You',
  role: 'owner',
  self: true,
};
const magda: RosterMember = {
  membershipId: 'm-magda',
  displayName: 'Magda',
  role: 'editor',
  self: false,
};

describe('buildRejoinRosterView', () => {
  // The server reports no presence, so the roster claims none: a "connected"
  // label was a constant, and "disconnected" only an owner's manual guess.
  it('carries no presence claim and offers Rejoin on every other member', () => {
    const view = buildRejoinRosterView([owner, magda]);
    expect(view.empty).toBe(false);
    for (const row of view.rows) {
      expect(row).not.toHaveProperty('connected');
      expect(row).not.toHaveProperty('statusLabel');
    }
    expect(view.rows.find((row) => row.membershipId === 'm-magda')?.rejoinable).toBe(true);
    expect(view.rows.find((row) => row.membershipId === 'm-owner')?.rejoinable).toBe(false);
  });

  it('pairs every row colour with a name', () => {
    const row = buildRejoinRosterView([magda]).rows[0];
    expect(row?.displayName).toBe('Magda');
    expect(row?.colorToken.length).toBeGreaterThan(0);
  });

  it('orders owner first then members by display name', () => {
    const other: RosterMember = {
      membershipId: 'm-adam',
      displayName: 'Adam',
      role: 'editor',
      self: false,
    };
    const view = buildRejoinRosterView([magda, other, owner]);
    expect(view.rows.map((row) => row.membershipId)).toEqual([
      'm-owner',
      'm-adam',
      'm-magda',
    ]);
  });

  it('is empty for an empty roster', () => {
    expect(buildRejoinRosterView([]).empty).toBe(true);
  });

  it('marks every non-self member removable and never the owner self row', () => {
    const view = buildRejoinRosterView([owner, magda]);
    expect(view.rows.find((row) => row.membershipId === 'm-owner')?.removable).toBe(false);
    expect(view.rows.find((row) => row.membershipId === 'm-magda')?.removable).toBe(true);
  });
});
