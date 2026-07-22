import { beforeEach, describe, expect, it, vi } from 'vitest';

// Control the async connection-build seams so we can pin a handle mid-flight and
// drive unload / concurrent-connect races deterministically. Everything else the
// real adapters export is preserved.
const adapterMocks = vi.hoisted(() => ({
  startHavemindConnection: vi.fn(),
  connectFromInput: vi.fn(),
  requestRejoinGrantForOwner: vi.fn(),
  buildRejoinControllerForInvitee: vi.fn(),
}));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startHavemindConnection: adapterMocks.startHavemindConnection,
    connectFromInput: adapterMocks.connectFromInput,
    requestRejoinGrantForOwner: adapterMocks.requestRejoinGrantForOwner,
    buildRejoinControllerForInvitee: adapterMocks.buildRejoinControllerForInvitee,
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
    adapterMocks.requestRejoinGrantForOwner.mockReset();
    adapterMocks.buildRejoinControllerForInvitee.mockReset();
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
    adapterMocks.requestRejoinGrantForOwner.mockReset();
    adapterMocks.buildRejoinControllerForInvitee.mockReset();
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

  it('does not clobber a connection assigned while connectFromInput was in flight (FIX 3)', async () => {
    // A handle assigned meanwhile (e.g. by the rejoin restart's startConnection)
    // must win: the late connectFromInput handle stops itself and never
    // overwrites the live connection — matching startConnection's invariant.
    const plugin = newPlugin();
    const lateHandle = fakeHandle('late');
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

    // A concurrent connection is established (and assigned) while the paste flow
    // is still awaiting.
    const existing = fakeHandle('existing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).connection = existing;

    resolveConnect(lateHandle);
    await pending;

    expect(lateHandle.stop).toHaveBeenCalledTimes(1);
    expect(existing.stop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(existing);
  });
});

/** Flush the microtask queue so a `void this.armRejoin()` settles before asserting. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const STATUS_VIEW = { text: 'Havemind: Reconnect required', tooltip: '' };

describe('F9 rejoin wiring', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
    adapterMocks.requestRejoinGrantForOwner.mockReset();
    adapterMocks.buildRejoinControllerForInvitee.mockReset();
  });

  it('owner requestRejoin calls the grant adapter and records the waiting contact', async () => {
    const plugin = newPlugin();
    adapterMocks.requestRejoinGrantForOwner.mockResolvedValue({
      status: 'waiting',
      membershipId: 'm-magda',
      boundDeviceId: 'd-magda',
    });

    await (plugin as unknown as {
      requestRejoin: (id: string) => Promise<void>;
    }).requestRejoin('m-magda');

    expect(adapterMocks.requestRejoinGrantForOwner).toHaveBeenCalledWith(plugin, {
      membershipId: 'm-magda',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinWaiting.has('m-magda')).toBe(true);
  });

  it('does not record waiting when the owner is not connected (adapter returns null)', async () => {
    const plugin = newPlugin();
    adapterMocks.requestRejoinGrantForOwner.mockResolvedValue(null);

    await (plugin as unknown as {
      requestRejoin: (id: string) => Promise<void>;
    }).requestRejoin('m-magda');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinWaiting.has('m-magda')).toBe(false);
  });

  it('arms the invitee poll on terminal auth and restarts the connection exactly once', async () => {
    const plugin = newPlugin();
    const attempt = vi
      .fn()
      .mockResolvedValueOnce('terminal-auth')
      .mockResolvedValueOnce({ status: 'syncing', membershipId: 'm', vaultId: 'v' });
    const controller = { attempt, getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);
    adapterMocks.startHavemindConnection.mockResolvedValue(fakeHandle('resumed'));

    // A terminal auth failure arms the rejoin poll from the persisted binding.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    expect(adapterMocks.buildRejoinControllerForInvitee).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);

    // A second terminal status while armed is idempotent — no second controller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    expect(adapterMocks.buildRejoinControllerForInvitee).toHaveBeenCalledTimes(1);

    // First poll: no grant yet — stays armed, no restart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);
    expect(adapterMocks.startHavemindConnection).not.toHaveBeenCalled();

    // Second poll: syncing — disarm and restart the connection once.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);

    // A stray late poll must never start a second connection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);

    plugin.unload();
  });

  it('surfaces a failed rejoin and disarms the poll instead of spinning silently (FIX 4)', async () => {
    // rejoin-failed is a terminal, unrecoverable redemption outcome. The 30 s
    // poll must stop (no silent forever-spin) and the failure must reach the
    // user via status + Notice, leaving a manual reconnect as the retry path.
    const plugin = newPlugin();
    const attempt = vi.fn().mockResolvedValue('rejoin-failed');
    const controller = { attempt, getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);

    // The poll ticks and the controller reports a terminal failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();

    // The interval is disarmed …
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinPollTimer).toBeNull();
    // … and the failure is surfaced to the user (not swallowed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connectionError).toContain('Rejoin');
  });

  it('does not arm when no persisted rejoin identity exists', async () => {
    const plugin = newPlugin();
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
  });

  it('cancels the rejoin restart cleanly when unload races an in-flight poll', async () => {
    const plugin = newPlugin();
    let resolveAttempt!: (value: unknown) => void;
    const attempt = vi.fn(
      () => new Promise((resolve) => {
        resolveAttempt = resolve;
      }),
    );
    const controller = { attempt, getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);
    adapterMocks.startHavemindConnection.mockResolvedValue(fakeHandle('resumed'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poll = (plugin as any).pollRejoinOnce() as Promise<void>;
    // The plugin unloads while the redemption attempt is still in flight.
    plugin.unload();
    // Only now does the attempt resolve with a success that must be ignored.
    resolveAttempt({ status: 'syncing', membershipId: 'm', vaultId: 'v' });
    await poll;

    expect(adapterMocks.startHavemindConnection).not.toHaveBeenCalled();
  });
});
