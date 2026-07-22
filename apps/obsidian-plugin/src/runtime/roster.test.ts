import { describe, expect, it } from 'vitest';

import { authorColorToken } from './author-colors';
import {
  buildRosterView,
  parseRoster,
  removeRosterMember,
  RosterStore,
  upsertRosterMember,
  type RosterMember,
  type RosterPersistPort,
} from './roster';

function owner(): RosterMember {
  return {
    membershipId: 'm-owner',
    displayName: 'You',
    role: 'owner',
    self: true,
  };
}

function magda(): RosterMember {
  return {
    membershipId: 'm-magda',
    displayName: 'Magda',
    role: 'editor',
    self: false,
  };
}

describe('buildRosterView', () => {
  it('renders each member as persistently connected with name, role and colour', () => {
    const view = buildRosterView([owner(), magda()]);
    expect(view.empty).toBe(false);
    const magdaRow = view.rows.find((row) => row.membershipId === 'm-magda');
    expect(magdaRow).toMatchObject({
      displayName: 'Magda',
      role: 'editor',
      connected: true,
      statusLabel: 'connected',
      self: false,
    });
    // Colour is the shared stable token, always paired with the name/label.
    expect(magdaRow?.colorToken).toBe(authorColorToken('m-magda'));
  });

  it('is a persistent connection state — never derived from activity, no timeout', () => {
    // The only input is the stored membership list; there is no activity or
    // timestamp parameter. Every rendered member reads as connected.
    const view = buildRosterView([owner(), magda()]);
    expect(view.rows.every((row) => row.connected === true)).toBe(true);
    expect(view.rows.every((row) => row.statusLabel === 'connected')).toBe(true);
  });

  it('includes the owner and lists them first', () => {
    const view = buildRosterView([magda(), owner()]);
    expect(view.rows[0]?.self).toBe(true);
    expect(view.rows[0]?.role).toBe('owner');
  });

  it('scales to N members (a growing list, not hard-coded for two)', () => {
    const members: RosterMember[] = [
      owner(),
      magda(),
      { membershipId: 'm-3', displayName: 'Carla', role: 'editor', self: false },
      { membershipId: 'm-4', displayName: 'Dan', role: 'editor', self: false },
    ];
    const view = buildRosterView(members);
    expect(view.rows).toHaveLength(4);
    // Owner first, then editors alphabetically.
    expect(view.rows.map((row) => row.displayName)).toEqual([
      'You',
      'Carla',
      'Dan',
      'Magda',
    ]);
  });

  it('reports an empty roster before any member is known', () => {
    expect(buildRosterView([]).empty).toBe(true);
  });
});

describe('upsertRosterMember', () => {
  it('replaces an existing member by membershipId without mutating the input', () => {
    const original = [magda()];
    const next = upsertRosterMember(original, {
      ...magda(),
      displayName: 'Magda (editor)',
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.displayName).toBe('Magda (editor)');
    // Immutability: the input array is untouched.
    expect(original[0]?.displayName).toBe('Magda');
  });

  it('appends a new member', () => {
    const next = upsertRosterMember([owner()], magda());
    expect(next.map((m) => m.membershipId)).toEqual(['m-owner', 'm-magda']);
  });
});

describe('RosterStore', () => {
  function fakePersist(initial: Record<string, unknown> = {}): {
    port: RosterPersistPort;
    data: () => Record<string, unknown>;
  } {
    let store: Record<string, unknown> = { ...initial };
    return {
      port: {
        load: async () => store,
        save: async (data) => {
          store = data;
        },
      },
      data: () => store,
    };
  }

  it('persists approved members as the owner approves each one', async () => {
    const { port, data } = fakePersist();
    const store = new RosterStore({ persist: port });

    await store.recordMember(owner());
    await store.recordMember(magda());

    const members = await store.readMembers();
    expect(members.map((m) => m.membershipId).sort()).toEqual([
      'm-magda',
      'm-owner',
    ]);
    // Non-roster keys in data.json are preserved.
    expect(data()).toHaveProperty('approvedMembersRoster');
  });

  it('preserves other plugin-data keys when recording a member', async () => {
    const { port, data } = fakePersist({ syncState: { version: 1 } });
    const store = new RosterStore({ persist: port });
    await store.recordMember(magda());
    expect(data().syncState).toEqual({ version: 1 });
  });

  it('degrades a malformed persisted roster to an empty list', () => {
    expect(parseRoster({ approvedMembersRoster: 'not-an-array' })).toEqual([]);
    expect(parseRoster({ approvedMembersRoster: [{ membershipId: 5 }] })).toEqual(
      [],
    );
    expect(parseRoster(null)).toEqual([]);
  });

  it('removes a member from the persisted roster and returns the survivors', async () => {
    const { port, data } = fakePersist();
    const store = new RosterStore({ persist: port });
    await store.recordMember(owner());
    await store.recordMember(magda());

    const remaining = await store.removeMember('m-magda');
    expect(remaining.map((m) => m.membershipId)).toEqual(['m-owner']);
    // The persisted roster no longer contains the removed member.
    const reread = await store.readMembers();
    expect(reread.map((m) => m.membershipId)).toEqual(['m-owner']);
    expect(data()).toHaveProperty('approvedMembersRoster');
  });

  it('preserves other plugin-data keys when removing a member', async () => {
    const { port, data } = fakePersist({ syncState: { version: 1 } });
    const store = new RosterStore({ persist: port });
    await store.recordMember(magda());
    await store.removeMember('m-magda');
    expect(data().syncState).toEqual({ version: 1 });
  });
});

describe('removeRosterMember', () => {
  it('drops the member by membershipId without mutating the input', () => {
    const input = [owner(), magda()];
    const next = removeRosterMember(input, 'm-magda');
    expect(next.map((m) => m.membershipId)).toEqual(['m-owner']);
    // The original array is untouched (immutability).
    expect(input.map((m) => m.membershipId)).toEqual(['m-owner', 'm-magda']);
  });

  it('is a no-op when the member is not present', () => {
    const next = removeRosterMember([owner()], 'm-unknown');
    expect(next.map((m) => m.membershipId)).toEqual(['m-owner']);
  });
});
