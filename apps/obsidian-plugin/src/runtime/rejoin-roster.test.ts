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
  it('marks every member connected and none rejoinable when nothing is dead', () => {
    const view = buildRejoinRosterView([owner, magda]);
    expect(view.empty).toBe(false);
    expect(view.rows.map((row) => row.rejoinable)).toEqual([false, false]);
    expect(view.rows.every((row) => row.statusLabel === 'connected')).toBe(true);
  });

  it('shows a Rejoin affordance only for a disconnected non-self member', () => {
    const view = buildRejoinRosterView([owner, magda], ['m-magda']);
    const magdaRow = view.rows.find((row) => row.membershipId === 'm-magda');
    const ownerRow = view.rows.find((row) => row.membershipId === 'm-owner');
    expect(magdaRow).toMatchObject({
      connected: false,
      statusLabel: 'disconnected',
      rejoinable: true,
    });
    expect(ownerRow).toMatchObject({
      connected: true,
      statusLabel: 'connected',
      rejoinable: false,
    });
  });

  it('never marks the owner’s own row rejoinable even if listed as dead', () => {
    const view = buildRejoinRosterView([owner, magda], ['m-owner', 'm-magda']);
    const ownerRow = view.rows.find((row) => row.membershipId === 'm-owner');
    expect(ownerRow?.rejoinable).toBe(false);
    expect(ownerRow?.connected).toBe(true);
  });

  it('pairs every row colour with a name and a text status label', () => {
    const view = buildRejoinRosterView([magda], ['m-magda']);
    const row = view.rows[0];
    expect(row?.displayName).toBe('Magda');
    expect(row?.statusLabel).toBe('disconnected');
    expect(typeof row?.colorToken).toBe('string');
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
    const ownerRow = view.rows.find((row) => row.membershipId === 'm-owner');
    const magdaRow = view.rows.find((row) => row.membershipId === 'm-magda');
    expect(ownerRow?.removable).toBe(false);
    expect(magdaRow?.removable).toBe(true);
  });

  it('keeps a member removable whether it is connected or disconnected', () => {
    const connected = buildRejoinRosterView([owner, magda]);
    const disconnected = buildRejoinRosterView([owner, magda], ['m-magda']);
    expect(
      connected.rows.find((row) => row.membershipId === 'm-magda')?.removable,
    ).toBe(true);
    expect(
      disconnected.rows.find((row) => row.membershipId === 'm-magda')
        ?.removable,
    ).toBe(true);
  });
});
