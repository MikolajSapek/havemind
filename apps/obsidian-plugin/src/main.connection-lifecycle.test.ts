import { beforeEach, describe, expect, it, vi } from 'vitest';

// Control the async connection-build seams so we can pin a handle mid-flight and
// drive unload / concurrent-connect races deterministically. Everything else the
// real adapters export is preserved.
const adapterMocks = vi.hoisted(() => ({
  startHavemindConnection: vi.fn(),
  connectFromInput: vi.fn(),
  requestRejoinGrantForOwner: vi.fn(),
  revokeMembershipForOwner: vi.fn(),
  buildRejoinControllerForInvitee: vi.fn(),
}));

vi.mock('./runtime/obsidian-adapters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startHavemindConnection: adapterMocks.startHavemindConnection,
    connectFromInput: adapterMocks.connectFromInput,
    requestRejoinGrantForOwner: adapterMocks.requestRejoinGrantForOwner,
    revokeMembershipForOwner: adapterMocks.revokeMembershipForOwner,
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

describe('Retry now (user-initiated reconnect)', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
    adapterMocks.requestRejoinGrantForOwner.mockReset();
    adapterMocks.buildRejoinControllerForInvitee.mockReset();
  });

  it('stops the current handle and restarts through the shared startConnection path', async () => {
    const plugin = newPlugin();
    const stale = fakeHandle('stale');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).connection = stale;
    const fresh = fakeHandle('fresh');
    adapterMocks.startHavemindConnection.mockResolvedValue(fresh);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).retryConnection();

    expect(stale.stop).toHaveBeenCalledTimes(1);
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(fresh);
    plugin.unload();
  });

  it('is idempotent under a rapid double-click: exactly one live handle', async () => {
    const plugin = newPlugin();
    const stale = fakeHandle('stale');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).connection = stale;
    const fresh = fakeHandle('fresh');
    let resolveConnect!: (h: FakeHandle) => void;
    adapterMocks.startHavemindConnection.mockReturnValue(
      new Promise<FakeHandle>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    // Two clicks land before the first build resolves; the second must be a
    // no-op so no second build (and thus no second live handle) is ever created.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (plugin as any).retryConnection() as Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = (plugin as any).retryConnection() as Promise<void>;
    resolveConnect(fresh);
    await Promise.all([first, second]);

    expect(stale.stop).toHaveBeenCalledTimes(1);
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);
    expect(fresh.stop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(fresh);
    plugin.unload();
  });

  it('respects the unload guard: a retry resolving after unload leaves no live handle', async () => {
    const plugin = newPlugin();
    const handle = fakeHandle('late');
    let resolveConnect!: (h: FakeHandle) => void;
    adapterMocks.startHavemindConnection.mockReturnValue(
      new Promise<FakeHandle>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (plugin as any).retryConnection() as Promise<void>;
    plugin.unload();
    resolveConnect(handle);
    await pending;

    expect(handle.stop).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBeNull();
  });

  it('restarts on a terminal reconnect-required state and DISARMS the rejoin poll (FINDING 1)', async () => {
    const plugin = newPlugin();
    const controller = { attempt: vi.fn(), getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);
    adapterMocks.startHavemindConnection.mockResolvedValue(fakeHandle('resumed'));

    // A terminal auth failure arms the invitee rejoin poll.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);

    // The user clicks Retry now: restart FIRST (persisted creds may still work).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).retryConnection();

    // A restart was attempted …
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);
    // … and the stale rejoin poll is DISARMED, so a later poll tick can never
    // tear down the healthy connection this retry just built. If the restart
    // lands back in reconnect-required, handleStatus re-arms the poll fresh.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
    plugin.unload();
  });

  it('disarms the rejoin poll on retry so a later poll tick never tears down the retry-built connection (FINDING 1a)', async () => {
    const plugin = newPlugin();
    // A poll that, left armed, would reach 'syncing' and tear down + restart the
    // connection — exactly the thrash this fix prevents.
    const attempt = vi
      .fn()
      .mockResolvedValue({ status: 'syncing', membershipId: 'm', vaultId: 'v' });
    const controller = { attempt, getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);
    const resumed = fakeHandle('resumed');
    adapterMocks.startHavemindConnection.mockResolvedValue(resumed);

    // reconnect-required arms the invitee rejoin poll.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);

    // The user clicks Retry now and the connection comes back healthy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).retryConnection();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(resumed);

    // The stale 30 s poll fires afterwards. It must NOT touch the healthy
    // retry-built handle: no attempt(), no stop(), no second startConnection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();

    expect(attempt).not.toHaveBeenCalled();
    expect(resumed.stop).not.toHaveBeenCalled();
    expect(adapterMocks.startHavemindConnection).toHaveBeenCalledTimes(1);
    plugin.unload();
  });

  it('a successful re-pair via connectFromInput disarms the rejoin poll and clears the sticky banner (FINDING 1c)', async () => {
    // After a terminal auth failure the invitee rejoin poll is armed and the
    // sticky "server refused" banner is set. If the user instead re-pairs from
    // scratch (owner /owner/pair path), connectFromInput must tear that terminal
    // state down — matching retryConnection's disarm-first idiom — otherwise the
    // doomed rejoin poll keeps running and the banner never drops even though a
    // healthy session is live.
    const plugin = newPlugin();
    const controller = { attempt: vi.fn(), getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);

    // A terminal auth failure arms the invitee rejoin poll and sets the banner.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connectionError).toBeDefined();

    // The user re-pairs from scratch and the pairing succeeds.
    const paired = fakeHandle('re-paired');
    adapterMocks.connectFromInput.mockResolvedValue(paired);
    await (
      plugin as unknown as {
        connectFromInput: (
          input: string,
          serverUrl: string,
          report: (message: string) => void,
        ) => Promise<void>;
      }
    ).connectFromInput('owner-pairing-token', 'https://sapserver.example', () => {});

    // The stale rejoin poll is disarmed, the sticky banner is cleared, and the
    // sync controller runs on the freshly paired session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connectionError).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(paired);
    plugin.unload();
  });

  it('no-ops a poll tick when the connection was re-established since the poll armed (FINDING 1b, generation guard)', async () => {
    const plugin = newPlugin();
    const attempt = vi
      .fn()
      .mockResolvedValue({ status: 'syncing', membershipId: 'm', vaultId: 'v' });
    const controller = { attempt, getState: () => 'terminal-auth' };
    adapterMocks.buildRejoinControllerForInvitee.mockResolvedValue(controller);
    const resumed = fakeHandle('resumed');
    adapterMocks.startHavemindConnection.mockResolvedValue(resumed);

    // Arm the poll at the current connect generation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).handleStatus('reconnect-required', STATUS_VIEW);
    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBe(controller);

    // A connection is re-established by SOME path that does not itself disarm the
    // poll (here a bare startConnection). The generation counter advances.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).startConnection();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBe(resumed);

    // The armed poll now ticks. The generation guard detects the connection was
    // re-established since arming and no-ops (never calls attempt / tears down),
    // then disarms.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).pollRejoinOnce();

    expect(attempt).not.toHaveBeenCalled();
    expect(resumed.stop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).rejoinController).toBeNull();
    plugin.unload();
  });
});

describe('F9 rejoin wiring', () => {
  beforeEach(() => {
    resetObsidianMock();
    adapterMocks.startHavemindConnection.mockReset();
    adapterMocks.connectFromInput.mockReset();
    adapterMocks.requestRejoinGrantForOwner.mockReset();
    adapterMocks.revokeMembershipForOwner.mockReset();
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

  it('owner removeMember revokes via the adapter and drops the member from the roster', async () => {
    const plugin = newPlugin();
    // An in-memory data.json so the roster store can persist and re-read.
    let store: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).loadData = async () => store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).saveData = async (data: Record<string, unknown>) => {
      store = data;
    };
    // Seed the persistent roster with the owner (self) and Magda.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).recordRosterMember({
      membershipId: 'm-owner',
      displayName: 'You',
      role: 'owner',
      self: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).recordRosterMember({
      membershipId: 'm-magda',
      displayName: 'Magda',
      role: 'editor',
      self: false,
    });
    // The owner had marked Magda disconnected before removing her.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).deadMembershipIds = ['m-magda'];

    adapterMocks.revokeMembershipForOwner.mockResolvedValue({
      status: 'removed',
      membershipId: 'm-magda',
    });

    await (plugin as unknown as {
      removeMember: (id: string) => Promise<void>;
    }).removeMember('m-magda');

    expect(adapterMocks.revokeMembershipForOwner).toHaveBeenCalledWith(plugin, {
      membershipId: 'm-magda',
    });
    // Magda disappears from the roster; the owner self row remains.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const members = (plugin as any).rosterMembers as Array<{ membershipId: string }>;
    expect(members.map((m) => m.membershipId)).toEqual(['m-owner']);
    // The dead-marker is cleared too, so no stale Rejoin affordance lingers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).deadMembershipIds).not.toContain('m-magda');
    // Removal is a control-plane action — it records nothing in the activity feed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).activityLog.snapshot()).toHaveLength(0);
  });

  it('does not touch the roster when the owner is not connected (adapter returns null)', async () => {
    const plugin = newPlugin();
    let store: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).loadData = async () => store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).saveData = async (data: Record<string, unknown>) => {
      store = data;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).recordRosterMember({
      membershipId: 'm-magda',
      displayName: 'Magda',
      role: 'editor',
      self: false,
    });
    adapterMocks.revokeMembershipForOwner.mockResolvedValue(null);

    await (plugin as unknown as {
      removeMember: (id: string) => Promise<void>;
    }).removeMember('m-magda');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const members = (plugin as any).rosterMembers as Array<{ membershipId: string }>;
    expect(members.map((m) => m.membershipId)).toEqual(['m-magda']);
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

describe('disconnect() tears down the rejoin poll (NIT)', () => {
  beforeEach(() => resetObsidianMock());

  it('disarms an armed invitee rejoin poll, like retryConnection/onunload', () => {
    const plugin = newPlugin();
    const timer = globalThis.setInterval(() => undefined, 1_000_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = plugin as any;
    internals.rejoinController = { attempt: () => undefined };
    internals.rejoinPollTimer = timer;
    internals.rejoinArmedGeneration = 0;

    internals.disconnect();

    expect(internals.rejoinController).toBeNull();
    expect(internals.rejoinPollTimer).toBeNull();
  });
});
