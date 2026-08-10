import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  App,
  type ButtonComponent,
  type MockElement,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
  type Setting,
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

function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/** The setting row carrying `name`, or a hard setup failure. */
function row(name: string): Setting {
  const found = registrationState.settingsRows.find((entry) =>
    entry.names.includes(name),
  );
  if (found === undefined) throw new Error(`settings row "${name}" is missing`);
  return found;
}

/** The description the "Connection" setting row currently shows. */
function connectionDesc(): string | undefined {
  return registrationState.settingsRows.find((r) =>
    r.names.includes('Connection'),
  )?.descriptions[0];
}

/** The first button on any rendered row whose label is `label`. */
function button(label: string): ButtonComponent {
  const found = registrationState.settingsRows
    .flatMap((entry) => entry.buttons)
    .find((entry) => entry.buttonText === label);
  if (found === undefined) throw new Error(`button "${label}" is missing`);
  return found;
}

/** A plugin whose plugin-data lives in memory, so a reset can complete. */
function newPlugin(app: App = new App()): HavemindPlugin {
  const plugin = new HavemindPlugin(app, manifest);
  let disk: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => disk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async (data: unknown) => {
    disk = data as Record<string, unknown>;
  };
  return plugin;
}

interface ConnectionSpy {
  stops: number;
  starts: number;
}

/** Installs a stand-in connection handle, as the command-palette tests do. */
function installFakeConnection(plugin: HavemindPlugin): ConnectionSpy {
  const spy: ConnectionSpy = { stops: 0, starts: 0 };
  (plugin as unknown as { connection: unknown }).connection = {
    serverName: 'vault.example',
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

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Renders the registered settings tab and returns a re-render handle. */
async function renderSettings(): Promise<{
  display: () => void;
  containerEl: MockElement;
}> {
  const tab = registrationState.settingsTabs[0];
  if (tab === undefined) throw new Error('settings tab was not registered');
  registrationState.settingsRows.splice(0);
  tab.display();
  await Promise.resolve();
  return {
    display: () => {
      registrationState.settingsRows.splice(0);
      tab.display();
    },
    containerEl: tab.containerEl as unknown as MockElement,
  };
}

describe('HavemindSettingTab refresh affordance (FINDING 4)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('holds a typed reference to its own plugin instead of casting', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const tab = registrationState.settingsTabs[0];
    if (tab === undefined) throw new Error('settings tab was not registered');

    // `PluginSettingTab.plugin` is typed as the base Plugin, so the tab keeps
    // its own narrowed field — that is what removes the double cast the display
    // body used to need on every read.
    expect(
      (tab as unknown as { havemind: HavemindPlugin }).havemind,
    ).toBe(plugin);
  });

  it('re-renders the live connection status on demand while the tab is open', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const tab = registrationState.settingsTabs[0];
    if (tab === undefined) throw new Error('settings tab was not registered');

    registrationState.settingsRows.splice(0);
    tab.display();
    expect(connectionDesc()).toBe(plugin.panelStatusLabel());

    // A status change while the tab stays open would otherwise leave the label
    // stale; the Refresh control must re-read it.
    (plugin as unknown as { connectionStatus: string }).connectionStatus =
      'synced';
    const staleLabel = connectionDesc();

    const refresh = flatten(tab.containerEl as unknown as MockElement).find(
      (e) => e.text === 'Refresh',
    );
    expect(refresh).toBeDefined();

    registrationState.settingsRows.splice(0);
    refresh?.triggerClick();

    expect(connectionDesc()).toBe(plugin.panelStatusLabel());
    expect(connectionDesc()).not.toBe(staleLabel);
  });
});

describe('HavemindSettingTab read-only summary (FINDING 7)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('reports server, status, last sync and member count while disconnected', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    await renderSettings();

    expect(row('Server').descriptions[0]).toBe('Not connected');
    expect(row('Connection').descriptions[0]).toBe(plugin.panelStatusLabel());
    expect(row('Last sync').descriptions[0]).toBe('Not yet');
    expect(row('Vault members').descriptions[0]).toBe(
      'No members recorded yet',
    );
  });

  it('names the connected server and counts the roster once connected', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    installFakeConnection(plugin);
    (
      plugin as unknown as { rosterMembers: unknown[] }
    ).rosterMembers = [
      { membershipId: 'm-owner', displayName: 'Mikolaj', role: 'owner', self: true },
      { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
    ];
    (
      plugin as unknown as { lastSyncedAt: number }
    ).lastSyncedAt = 1_700_000_000_000;
    await renderSettings();

    expect(row('Server').descriptions[0]).toBe('vault.example');
    expect(row('Vault members').descriptions[0]).toBe('2 members');
    expect(row('Last sync').descriptions[0]).not.toBe('Not yet');
  });
});

describe('HavemindSettingTab actions (FINDING 7)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('offers the four connection actions as buttons, panel as the CTA', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    await renderSettings();

    expect(button('Open Havemind panel').cta).toBe(true);
    expect(button('Sync now')).toBeDefined();
    expect(button('Disconnect')).toBeDefined();
    expect(button('Reset connection')).toBeDefined();
  });

  it('greys out Sync now and Disconnect while nothing is connected', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    await renderSettings();

    expect(button('Sync now').disabled).toBe(true);
    expect(button('Disconnect').disabled).toBe(true);
    // Reset exists for a damaged pairing, so it is never greyed out.
    expect(button('Reset connection').disabled).toBe(false);
  });

  it('opens the pane from the CTA', async () => {
    const app = new App();
    const plugin = newPlugin(app);
    await plugin.onload();
    await renderSettings();

    button('Open Havemind panel').trigger();
    await flush();

    expect(app.workspace.revealedLeaves).toHaveLength(1);
  });

  it('runs the same sync handler the palette command runs', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);
    await renderSettings();

    button('Sync now').trigger();
    await flush();

    expect(spy.stops).toBe(1);
    expect(spy.starts).toBe(1);
  });

  it('stops the live loop from the Disconnect button', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const spy = installFakeConnection(plugin);
    await renderSettings();

    button('Disconnect').trigger();
    await flush();

    expect(spy.stops).toBe(1);
  });

  it('clears the stored pairing from the Reset connection button', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    await renderSettings();

    button('Reset connection').trigger();
    await flush();

    expect(
      registrationState.notices.some((message) =>
        message.startsWith('Havemind: connection reset'),
      ),
    ).toBe(true);
  });

  it('toggles the author overlay from the settings tab', async () => {
    const plugin = newPlugin();
    await plugin.onload();
    const tab = await renderSettings();

    expect(row('Author overlay').descriptions[0]).toContain('Currently off');
    button('Show authors').trigger();
    expect(plugin.authorOverlayEnabled()).toBe(true);

    tab.display();
    expect(row('Author overlay').descriptions[0]).toContain('Currently on');
    expect(button('Hide authors')).toBeDefined();
  });
});
