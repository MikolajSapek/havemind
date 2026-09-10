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
}));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startHavemindConnection: adapterMocks.startHavemindConnection,
    connectFromInput: adapterMocks.connectFromInput,
    listPendingApprovalsForOwner: adapterMocks.listPendingApprovalsForOwner,
    fetchMemberRosterForVault: adapterMocks.fetchMemberRosterForVault,
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
    adapterMocks.startHavemindConnection.mockResolvedValue({
      stop: vi.fn(),
      serverName: 'sapserver',
      selfMembership: { membershipId: 'm-magda', role: 'editor' },
    });
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledTimes(1);
    // The guest now sees every active member of the vault, owner included.
    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('refetches the roster on reconnect', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue({
      stop: vi.fn(),
      serverName: 'sapserver',
      selfMembership: { membershipId: 'm-magda', role: 'editor' },
    });
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();
    await internals(plugin).retryConnection();
    await flushMicrotasks();

    expect(adapterMocks.fetchMemberRosterForVault).toHaveBeenCalledTimes(2);
    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('keeps the previously rendered roster when the request fails (offline device)', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue({
      stop: vi.fn(),
      serverName: 'sapserver',
      selfMembership: { membershipId: 'm-magda', role: 'editor' },
    });
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();
    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);

    // The device goes offline; the next connect cannot reach /members.
    adapterMocks.fetchMemberRosterForVault.mockRejectedValue(
      new Error('network unreachable'),
    );
    await internals(plugin).retryConnection();
    await flushMicrotasks();

    // The pane still shows what it last knew, never a blank People list.
    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });

  it('keeps the previously rendered roster when the server is not reachable as this member', async () => {
    const plugin = newPlugin();
    await internals(plugin).recordRosterMember({
      membershipId: 'm-magda',
      displayName: 'You',
      role: 'editor',
      self: true,
    });
    adapterMocks.startHavemindConnection.mockResolvedValue({
      stop: vi.fn(),
      serverName: 'sapserver',
      selfMembership: { membershipId: 'm-magda', role: 'editor' },
    });
    // Not connected as a member of any vault: the adapter reports null.
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(null);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    expect(memberIds(plugin)).toEqual(['m-magda']);
  });

  it('persists the server roster so a reopened pane shows it before the next fetch', async () => {
    const plugin = newPlugin();
    adapterMocks.startHavemindConnection.mockResolvedValue({
      stop: vi.fn(),
      serverName: 'sapserver',
      selfMembership: { membershipId: 'm-magda', role: 'editor' },
    });
    adapterMocks.fetchMemberRosterForVault.mockResolvedValue(SERVER_ROSTER);

    await internals(plugin).startConnection();
    await flushMicrotasks();

    // Drop the in-memory mirror and re-read from data.json only.
    internals(plugin).rosterMembers = [];
    await internals(plugin).loadRoster();

    expect(memberIds(plugin).sort()).toEqual(['m-magda', 'm-owner']);
  });
});
