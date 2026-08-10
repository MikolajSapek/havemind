/**
 * Command-palette coverage for the three actions that used to be mouse-only.
 *
 * Audit finding: `syncNow`, `disconnect()` and `resetConnection()` were reachable
 * only by clicking a button in the panel — no command, therefore no hotkey and no
 * palette entry. These tests pin the ids, the names, the availability guard
 * (`checkCallback` greys an action out rather than letting it fail), and the fact
 * that Reset connection stays available in exactly the state it exists for.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  App,
  type Command,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
} from './test/obsidian.mock';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => disk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async (data: unknown) => {
    disk = data as Record<string, unknown>;
  };
  return plugin;
}

/** Counters the sync/disconnect commands must move. */
interface ConnectionSpy {
  stops: number;
  starts: number;
}

/**
 * Installs a stand-in connection handle plus a stubbed `startConnection`, so the
 * commands can be exercised without a server: `stops` counts handle teardown,
 * `starts` counts the fresh cycle a forced sync asks for.
 */
function installFakeConnection(plugin: HavemindPlugin): ConnectionSpy {
  const spy: ConnectionSpy = { stops: 0, starts: 0 };
  (plugin as unknown as { connection: unknown }).connection = {
    serverName: 'server.example',
    stop: () => {
      spy.stops += 1;
    },
  };
  (
    plugin as unknown as { startConnection: () => Promise<void> }
  ).startConnection = async () => {
    spy.starts += 1;
  };
  return spy;
}

/** Drains pending microtasks so a fire-and-forget command action completes. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

  it('forces a fresh cycle from Sync now through the panel retry path', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);

    command('sync-now').checkCallback?.(false);
    await flush();

    expect(spy.stops).toBe(1);
    expect(spy.starts).toBe(1);
    expect(registrationState.notices).not.toContain(
      'Havemind: connect before syncing.',
    );
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

  it('clears the stored pairing from the Reset connection command', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    command('reset-connection').callback?.();
    await flush();

    expect(
      registrationState.notices.some((message) =>
        message.startsWith('Havemind: connection reset'),
      ),
    ).toBe(true);
  });
});
