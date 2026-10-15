/**
 * The owner's list of devices waiting for approval must match the server: no
 * expired rows, refreshed when a connection syncs, and gone after Disconnect.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMocks = vi.hoisted(() => ({
  listPendingApprovalsForOwner: vi.fn(),
  persistActivity: vi.fn(() => () => undefined),
}));

vi.mock('./runtime/activity-persistence', () => ({ persistActivity: adapterMocks.persistActivity }));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listPendingApprovalsForOwner: adapterMocks.listPendingApprovalsForOwner };
});

import HavemindPlugin from './main';
import { formatStatusBar } from './runtime/status';
import { App, resetObsidianMock } from './test/obsidian.mock';
import { internals } from './test/plugin-internals';
import { manifest } from './test/fixtures';

const future = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

function newPlugin(): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  internals(plugin).loadData = async () => null;
  internals(plugin).saveData = async () => undefined;
  plugin.onload();
  return plugin;
}

function asOwner(plugin: HavemindPlugin): void {
  (plugin as unknown as { connection: unknown }).connection = {
    stop: vi.fn(),
    selfMembership: { membershipId: 'm-owner', role: 'owner' },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('pending approvals', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.listPendingApprovalsForOwner.mockReset();
  });

  it('never lists an expired waiting device', () => {
    const plugin = newPlugin();
    plugin.invitations.pendingApprovals = [
      { invitationId: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() },
      { invitationId: 'live', expiresAt: future(5) },
    ];
    expect(plugin.invitations.activePendingApprovals().map((e) => e.invitationId)).toEqual(['live']);
    expect(plugin.invitations.composerModel().pending.map((e) => e.invitationId)).toEqual(['live']);
  });

  it('asks the server again when an owner connection syncs, at most every 30 s', async () => {
    const plugin = newPlugin();
    asOwner(plugin);
    adapterMocks.listPendingApprovalsForOwner.mockResolvedValue([
      { invitationId: 'fresh', expiresAt: future(10) },
    ]);

    internals(plugin).handleStatus('synced', formatStatusBar({ status: 'synced' }));
    internals(plugin).handleStatus('synced', formatStatusBar({ status: 'synced' }));
    await settle();

    expect(adapterMocks.listPendingApprovalsForOwner).toHaveBeenCalledTimes(1);
    expect(plugin.invitations.pendingApprovals.map((e) => e.invitationId)).toEqual(['fresh']);
  });

  it('does not ask on a device that is not the owner', async () => {
    const plugin = newPlugin();
    (plugin as unknown as { connection: unknown }).connection = {
      stop: vi.fn(),
      selfMembership: { membershipId: 'm-guest', role: 'editor' },
    };
    internals(plugin).handleStatus('synced', formatStatusBar({ status: 'synced' }));
    await settle();
    expect(adapterMocks.listPendingApprovalsForOwner).not.toHaveBeenCalled();
  });

  it('is cleared by Disconnect, with the invitation and the roster', () => {
    const plugin = newPlugin();
    plugin.invitations.pendingApprovals = [{ invitationId: 'live', expiresAt: future(5) }];
    plugin.invitations.pendingInvitation = {
      invitationId: 'live',
      expiresAt: future(5),
    } as never;
    plugin.invitations.connectionActive = true;
    plugin.people.rosterMembers = [{ membershipId: 'm1', displayName: 'You', role: 'owner', self: true }];

    internals(plugin).disconnect();

    expect(plugin.invitations.pendingApprovals).toEqual([]);
    expect(plugin.invitations.pendingInvitation).toBeNull();
    expect(plugin.invitations.connectionActive).toBe(false);
    expect(plugin.people.rosterMembers).toEqual([]);
  });
});
