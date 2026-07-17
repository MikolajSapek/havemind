import { beforeEach, describe, expect, it, vi } from 'vitest';

// Control the async connection-build seams so we can pin a handle mid-flight and
// drive unload / concurrent-connect races deterministically. Everything else the
// real adapters export is preserved.
const adapterMocks = vi.hoisted(() => ({
  startHavemindConnection: vi.fn(),
  connectFromInput: vi.fn(),
}));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startHavemindConnection: adapterMocks.startHavemindConnection,
    connectFromInput: adapterMocks.connectFromInput,
  };
});

import HavemindPlugin from './main';
import { App, resetObsidianMock, type PluginManifest } from './test/obsidian.mock';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

interface FakeHandle {
  stop: ReturnType<typeof vi.fn>;
  serverName: string;
}

function fakeHandle(serverName: string): FakeHandle {
  return { stop: vi.fn(), serverName };
}

/** Fresh plugin with plugin-data persistence stubbed (empty vault data). */
function newPlugin(): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  // loadRoster()/roster persistence read plugin data; the headless Plugin mock
  // does not model loadData/saveData, so stub them to an empty store.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async () => undefined;
  plugin.onload();
  return plugin;
}

describe('startConnection lifecycle safety', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
  });

  it('stops (never leaves live) a connection handle that resolves after onunload', async () => {
    // FIX 1: onLayoutReady fires `void startConnection()`. If the user disables the
    // plugin while the connection build is still awaiting, onunload runs first
    // (stopping a still-null field), then the await resolves with a LIVE handle.
    // Without the guard that handle is assigned and its vault listeners + sync loop
    // leak forever. It must instead be stopped and never assigned.
    const plugin = newPlugin();
    const handle = fakeHandle('sapserver');
    let resolveConnect!: (h: FakeHandle) => void;
    adapterMocks.startHavemindConnection.mockReturnValue(
      new Promise<FakeHandle>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (plugin as any).startConnection() as Promise<void>;

    // The user disables the plugin while the connection is still being built.
    plugin.unload();

    // Only now does the in-flight build resolve with a live handle.
    resolveConnect(handle);
    await pending;

    expect(handle.stop).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBeNull();
  });

  it('does not orphan a connection established by connectFromInput while startConnection is in flight', async () => {
    // FIX 2: a user-initiated connectFromInput (e.g. invitee approval polling)
    // completes and assigns a live handle while the layout-ready startConnection is
    // still awaiting. The late resolution must NOT clobber that user handle: it
    // stops its own late handle and leaves the user connection untouched.
    const plugin = newPlugin();
    const layoutHandle = fakeHandle('layout');
    let resolveConnect!: (h: FakeHandle) => void;
    adapterMocks.startHavemindConnection.mockReturnValue(
      new Promise<FakeHandle>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (plugin as any).startConnection() as Promise<void>;

    // A user-initiated connect wins the race and assigns a live handle.
    const userHandle = fakeHandle('user');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).connection = userHandle;

    // The layout-ready connect resolves late.
    resolveConnect(layoutHandle);
    await pending;

    expect(layoutHandle.stop).toHaveBeenCalledTimes(1);
    expect(userHandle.stop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(userHandle);
  });

  it('assigns the handle normally when no unload or concurrent connect intervenes', async () => {
    const plugin = newPlugin();
    const handle = fakeHandle('sapserver');
    adapterMocks.startHavemindConnection.mockResolvedValue(handle);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).startConnection();

    expect(handle.stop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(handle);
  });
});

describe('connectFromInput lifecycle safety', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
  });

  it('stops (never leaves live) a connectFromInput handle that resolves after onunload', async () => {
    // Same class of gap as startConnection FIX 1: connectFromInput's invitee
    // approval poll can run up to ~1h. If the user disables the plugin while
    // that poll is still in flight, onunload already ran its
    // `connection?.stop()` on a still-null field, then the await resolves with
    // a LIVE handle. Without the guard that handle is assigned and its vault
    // listeners + sync loop leak forever. It must instead be stopped and never
    // assigned.
    const plugin = newPlugin();
    const handle = fakeHandle('sapserver');
    let resolveConnect!: (h: FakeHandle) => void;
    adapterMocks.connectFromInput.mockReturnValue(
      new Promise<FakeHandle>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    const pending = (
      plugin as unknown as {
        connectFromInput: (
          input: string,
          serverUrl: string,
          report: (message: string) => void,
        ) => Promise<void>;
      }
    ).connectFromInput('invitation-envelope', 'https://sapserver.example', () => {});

    // The user disables the plugin while the approval poll is still pending.
    plugin.unload();

    // Only now does the in-flight approval poll resolve with a live handle.
    resolveConnect(handle);
    await pending;

    expect(handle.stop).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBeNull();
  });
});
