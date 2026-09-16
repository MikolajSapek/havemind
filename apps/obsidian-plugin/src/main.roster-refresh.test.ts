/**
 * P3, the roster is read from the server, not from `data.json`.
 *
 * `GET /members` is the vault's single source of truth about who is in it, so a
 * guest and the owner see the same People list. These tests pin the three facts
 * the plan asks for: the roster is fetched on connect, again on reconnect, and a
 * failed request leaves the previously rendered list in place (never an empty
 * pane on an offline device).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMocks = vi.hoisted(() => ({
  startHavemindConnection: vi.fn(),
  connectFromInput: vi.fn(),
  listPendingApprovalsForOwner: vi.fn(),
  fetchMemberRosterForVault: vi.fn(),
  approvePendingDeviceForOwner: vi.fn(),
}));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startHavemindConnection: adapterMocks.startHavemindConnection,
    connectFromInput: adapterMocks.connectFromInput,
    listPendingApprovalsForOwner: adapterMocks.listPendingApprovalsForOwner,
    fetchMemberRosterForVault: adapterMocks.fetchMemberRosterForVault,
    approvePendingDeviceForOwner: adapterMocks.approvePendingDeviceForOwner,
  };
});

import HavemindPlugin from './main';
import type { RosterMember } from './runtime/roster';
import { App, resetObsidianMock, type PluginManifest } from './test/obsidian.mock';
import { internals } from './test/plugin-internals';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

const SERVER_ROSTER: RosterMember[] = [
  { membershipId: 'm-owner', displayName: 'Mikolaj', role: 'owner', self: false },
  { membershipId: 'm-magda', displayName: 'You', role: 'editor', self: true },
];

function liveHandle(
  self: { membershipId: string; role: 'owner' | 'editor' },
  extra: Record<string, unknown> = {},
) {
  return {
    stop: vi.fn(),
    serverName: 'sapserver',
    apiBaseUrl: 'https://sapserver.test/api/v1',
    vaultId: 'vault-1',
    selfMembership: self,
    ...extra,
  };
}

function newPlugin(): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  let store: Record<string, unknown> = {};
  internals(plugin).loadData = async () => store;
  internals(plugin).saveData = async (data: unknown) => {
    store = data as Record<string, unknown>;
  };
  plugin.onload();
  return plugin;
}

function memberIds(plugin: HavemindPlugin): string[] {
  return (internals(plugin).rosterMembers as RosterMember[]).map(
    (member) => member.membershipId,
  );
}

/**
 * `refreshRoster()` is fire-and-forget (`void`), and its chain awaits the fetch,
 * the plugin-data read and the write. A macrotask turn lets all of them settle
 * before the assertion reads `rosterMembers`.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('server-sourced member roster (P3)', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
    adapterMocks.listPendingApprovalsForOwner.mockReset();
    adapterMocks.listPendingApprovalsForOwner.mockResolvedValue(null);
    adapterMocks.fetchMemberRosterForVault.mockReset();
    adapterMocks.approvePendingDeviceForOwner.mockReset();
  });

  it('renders People from GET /members after a connect, not from data.json', async () => {
    const plugin = newPlugin();
    // A guest device knows only itself locally: that is the bug the endpoint
    // closes, so the local roster starts with one entry.
    await internals(plugin).recordRosterMember({
      membershipId: 'm-magda',
      displayName: 'You',
      role: 'editor',
      self: true,
    });
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle({ membershipId: 'm-magda', role: 'editor' }),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledTimes(1);
    // The guest now sees every active member of the vault, owner included.
    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('refetches the roster on reconnect', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle({ membershipId: 'm-magda', role: 'editor' }),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();
    await internals(plugin).retryConnection();
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous People list when the roster request fails', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle({ membershipId: 'm-magda', role: 'editor' }),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    adapterMocks.fetchMemberRosterForVault.mockRejectedValue(
      new Error('offline'),
    );
    await internals(plugin).refreshRoster();
    await flushMicrotasks();

    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('keeps the previous People list when the device is not connected', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle({ membershipId: 'm-magda', role: 'editor' }),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(null);
    await internals(plugin).refreshRoster();
    await flushMicrotasks();

    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('persists the server roster so a reopen shows every member', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle({ membershipId: 'm-magda', role: 'editor' }),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    // Drop the in-memory mirror and re-read from data.json only.
    internals(plugin).rosterMembers = [];
    await internals(plugin).loadRoster();

    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('identifies You from the live connection when the local roster is still empty', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle(
        { membershipId: 'm-magda', role: 'editor' },
        { getAccessToken: async () => 'hm_at_live' },
      ),
    );
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledWith(
      plugin,
      expect.objectContaining({
        getAccessToken: expect.any(Function),
        selfMembershipId: 'm-magda',
        connected: {
          apiBaseUrl: 'https://sapserver.test/api/v1',
          vaultId: 'vault-1',
        },
      }),
    );
  });

  it('refetches the People list after the owner approves a joining device', async () => {
    const plugin = newPlugin();
    const owner: RosterMember = {
      membershipId: 'm-owner',
      displayName: 'You',
      role: 'owner',
      self: true,
    };
    const guest: RosterMember = {
      membershipId: 'm-phone',
      displayName: 'Telefon',
      role: 'editor',
      self: false,
    };
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle(
        { membershipId: 'm-owner', role: 'owner' },
        { getAccessToken: async () => 'hm_at_live' },
      ),
    );
    adapterMocks.fetchMemberRosterForVault
      .mockResolvedValueOnce([owner])
      .mockResolvedValueOnce([owner, guest]);
    adapterMocks.approvePendingDeviceForOwner.mockResolvedValue({
      membershipId: 'm-phone',
    });

    await internals(plugin).startConnection();
    await flushMicrotasks();
    expect(memberIds(plugin)).toEqual(['m-owner']);

    internals(plugin).pendingApprovals = [
      {
        invitationId: 'inv-1',
        intendedMemberDisplayName: 'Telefon',
        intendedRole: 'editor',
      },
    ];
    await internals(plugin).approvePendingDevice('inv-1', '123456', () => {
      /* progress is unused */
    });
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledTimes(2);
    expect(memberIds(plugin).sort()).toEqual(['m-owner', 'm-phone']);
  });

  it('does not let an older slow roster response overwrite a newer refresh', async () => {
    const plugin = newPlugin();
    const owner: RosterMember = {
      membershipId: 'm-owner',
      displayName: 'You',
      role: 'owner',
      self: true,
    };
    const guest: RosterMember = {
      membershipId: 'm-phone',
      displayName: 'Telefon',
      role: 'editor',
      self: false,
    };
    let resolveSlow: ((members: RosterMember[]) => void) | undefined;
    adapterMocks.startHavemindConnection.mockResolvedValue(
      liveHandle(
        { membershipId: 'm-owner', role: 'owner' },
        { getAccessToken: async () => 'hm_at_live' },
      ),
    );
    // Connect awaits the first refresh, so give it a fast answer first.
    adapterMocks.fetchMemberRosterForVault
      .mockResolvedValueOnce([owner])
      .mockImplementationOnce(
        () =>
          new Promise<RosterMember[]>((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce([owner, guest]);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    const slowRefresh = internals(plugin).refreshRoster();
    await flushMicrotasks();
    const newerRefresh = internals(plugin).refreshRoster();
    await flushMicrotasks();

    resolveSlow?.([owner]);
    await slowRefresh;
    await newerRefresh;
    await flushMicrotasks();

    expect(memberIds(plugin).sort()).toEqual(['m-owner', 'm-phone']);
  });
});
