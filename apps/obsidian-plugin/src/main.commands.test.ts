/**
 * Command-palette coverage for the three actions that used to be mouse-only.
 *
 * Audit finding: `syncNow`, `disconnect()` and `resetConnection()` were reachable
 * only by clicking a button in the panel, no command, therefore no hotkey and no
 * palette entry. These tests pin the ids, the names, the availability guard
 * (`checkCallback` greys an action out rather than letting it fail), and the fact
 * that Reset connection stays available in exactly the state it exists for.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  App,
  type Command,
  type MockElement,
  registrationState,
  resetObsidianMock,
} from './test/obsidian.mock';
import { internals } from './test/plugin-internals';
import { manifest, flush } from './test/fixtures';

/** The registered command with this id, or a hard setup failure. */
function command(id: string): Command {
  const found = registrationState.commands.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`command "${id}" was not registered`);
  return found;
}

/** A plugin whose plugin-data lives in memory, so a reset can complete. */
function newPlugin(): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  let disk: Record<string, unknown> = {};
  internals(plugin).loadData = async () => disk;
  internals(plugin).saveData = async (data: unknown) => {
    disk = data as Record<string, unknown>;
  };
  return plugin;
}

/** Counters the sync/disconnect commands must move. */
interface ConnectionSpy {
  stops: number;
  starts: number;
  syncs: number;
}

/**
 * Installs a stand-in connection handle plus a stubbed `startConnection`, so the
 * commands can be exercised without a server: `stops` counts handle teardown,
 * `starts` counts the fresh cycle a forced sync asks for.
 */
function installFakeConnection(plugin: HavemindPlugin): ConnectionSpy {
  const spy: ConnectionSpy = { stops: 0, starts: 0, syncs: 0 };
  (plugin as unknown as { connection: unknown }).connection = {
    serverName: 'server.example',
    stop: () => {
      spy.stops += 1;
    },
    syncNow: async () => {
      spy.syncs += 1;
    },
  };
  (
    plugin as unknown as { startConnection: () => Promise<void> }
  ).startConnection = async () => {
    spy.starts += 1;
  };
  return spy;
}

/** Clicks the button labelled `text` anywhere under `root`. */
function clickButton(root: unknown, text: string): void {
  const find = (node: MockElement): MockElement | undefined =>
    node.tag === 'button' && node.text === text
      ? node
      : node.children.map(find).find((match) => match !== undefined);
  const button = root === undefined ? undefined : find(root as MockElement);
  if (button === undefined) throw new Error(`no "${text}" button`);
  button.triggerClick();
}

describe('command palette actions', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('registers Sync now, Disconnect and Reset connection', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    expect(registrationState.commands.map(({ id }) => id)).toEqual([
      'open-activity',
      'connect',
      'create-connection',
      'sync-now',
      'disconnect',
      'reset-connection',
    ]);
    expect(command('sync-now').name).toBe('Sync now');
    expect(command('disconnect').name).toBe('Disconnect');
    expect(command('reset-connection').name).toBe('Reset connection');
  });

  it('greys out Sync now and Disconnect while nothing is connected', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    expect(command('sync-now').checkCallback?.(true)).toBe(false);
    expect(command('disconnect').checkCallback?.(true)).toBe(false);
  });

  it('keeps Reset connection unconditionally available', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    // No availability guard: a damaged connection is precisely when the user
    // needs this, and that state is not always distinguishable up front.
    expect(command('reset-connection').checkCallback).toBeUndefined();
    expect(command('reset-connection').callback).toBeDefined();
  });

  it('offers Sync now and Disconnect once a connection is live', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    installFakeConnection(plugin);

    expect(command('sync-now').checkCallback?.(true)).toBe(true);
    expect(command('disconnect').checkCallback?.(true)).toBe(true);
  });

  it('tells the user to connect first when Sync now runs disconnected', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    command('sync-now').checkCallback?.(false);
    await flush();

    expect(registrationState.notices).toContain(
      'Havemind: connect before syncing.',
    );
  });

  it('runs one sync cycle from Sync now without rebuilding the connection', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);

    command('sync-now').checkCallback?.(false);
    await flush();

    // Rebuilding would abort work in flight and re-read the whole vault.
    expect(spy.syncs).toBe(1);
    expect(spy.stops).toBe(0);
    expect(spy.starts).toBe(0);
    expect(registrationState.notices).not.toContain(
      'Havemind: connect before syncing.',
    );
  });

  // A refused session stops the loop for good, so one more cycle on it can
  // only report a neutral result. Sync now must reconnect, as it did before
  // it learned to run a single cycle.
  it('rebuilds the connection from Sync now when the session was refused', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);
    (plugin as unknown as { connectionStatus: string }).connectionStatus =
      'reconnect-required';

    command('sync-now').checkCallback?.(false);
    await flush();

    expect(spy.syncs).toBe(0);
    expect(spy.stops).toBe(1);
    expect(spy.starts).toBe(1);
  });

  it('stops the live loop from the Disconnect command', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);

    command('disconnect').checkCallback?.(false);
    await flush();

    expect(spy.stops).toBe(1);
    // Nothing is connected any more, so the command greys itself out again.
    expect(command('disconnect').checkCallback?.(true)).toBe(false);
  });

  // U2: one tap in the pane menu wiped the pairing and the sync state, with
  // no way back but a new approval from the owner.
  it('asks before Reset connection clears the stored pairing', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const resetNotice = (): boolean =>
      registrationState.notices.some((message) =>
        message.startsWith('Havemind: connection reset'),
      );

    command('reset-connection').callback?.();
    await flush();
    expect(resetNotice()).toBe(false);
    expect(registrationState.modals).toHaveLength(1);

    clickButton(registrationState.modals[0]?.contentEl, 'Reset connection');
    await flush();
    expect(resetNotice()).toBe(true);
  });

  it('keeps the pairing when the reset confirmation is cancelled', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    command('reset-connection').callback?.();
    clickButton(registrationState.modals[0]?.contentEl, 'Cancel');
    await flush();

    expect(registrationState.modals[0]?.closed).toBe(true);
    expect(
      registrationState.notices.some((message) =>
        message.startsWith('Havemind: connection reset'),
      ),
    ).toBe(false);
  });

  it('closes the owner composer on Done, so the status indicator returns', async () => {
    // The onboarding view gives the composer priority and returns before it
    // draws the status row. Leaving `connectionActive` set after Done therefore
    // hides "Connected, synced" for as long as the pane stays open, which
    // reads as a dropped connection on a vault that is in fact synced.
    const plugin = newPlugin();
    await plugin.onload();
    const internals = plugin as unknown as {
      connectionActive: boolean;
      pendingInvitation: unknown;
      dismissInvitation: () => void;
    };

    internals.connectionActive = true;
    internals.pendingInvitation = {
      envelope: 'v1.ABC',
      expiresAt: '2999-01-01T00:00:00.000Z',
      invitationId: 'id-1',
    };

    internals.dismissInvitation();

    expect(internals.connectionActive).toBe(false);
    expect(internals.pendingInvitation).toBeNull();
  });
});
