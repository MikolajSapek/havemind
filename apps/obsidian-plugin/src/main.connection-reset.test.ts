/**
 * P1 #5 — a corrupt or half-paired persisted connection must be REPORTED, never
 * looped as "server offline".
 *
 * Field incident this pins: on a second computer the persisted `ownerConnection`
 * record was half-written, so every connect attempt fell through to the offline
 * retry loop and the only recovery was deleting `data.json` by hand. Connect must
 * detect the broken state, preserve the raw bytes to a sidecar, and offer a
 * reset the user can click.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';

import HavemindPlugin, { HavemindOnboardingView } from './main';
import {
  evaluateOwnerConnection,
  parseOwnerConnection,
  startHavemindConnection,
} from './runtime/obsidian-adapters';
import { ObsidianOnboardingSecrets } from './runtime/onboarding-secrets';
import { buildConnectionPanel, type ConnectionStatus } from './runtime/status';
import {
  App,
  type MockElement,
  resetObsidianMock,
  SecretStorage,
  type PluginManifest,
  WorkspaceLeaf,
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

/** A valid client_instance_id (16-64 lowercase alphanumerics/hyphens). */
const CLIENT_INSTANCE_ID = '11111111-2222-4333-8444-555555555555';
const REFRESH_SECRET_KEY = `havemind-${CLIENT_INSTANCE_ID}-onb-refresh`;

const INTACT_RECORD = {
  apiBaseUrl: 'https://sync.example.test',
  vaultId: 'vault-1',
  memberId: 'm-owner',
  deviceId: 'd-owner',
} as const;

interface Disk {
  value: Record<string, unknown>;
}

/** Depth-first list of an element and all of its descendants. */
function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/** A bare Plugin double: plugin-data over `disk`, plus a SecretStorage. */
function fakePlugin(
  disk: Disk,
  secretStorage: unknown = new SecretStorage(),
): Plugin {
  return {
    app: { secretStorage },
    async loadData() {
      return disk.value;
    },
    async saveData(data: unknown) {
      disk.value = data as Record<string, unknown>;
    },
  } as unknown as Plugin;
}

/** A real plugin whose plugin-data is backed by `disk`. */
function newPlugin(disk: Disk): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => disk.value;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async (data: unknown) => {
    disk.value = data as Record<string, unknown>;
  };
  plugin.onload();
  return plugin;
}

describe('connect-time corruption gate (P1 #5)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('reports reset-required for a persisted ownerConnection missing vaultId — never onboarding, never an offline loop', async () => {
    // The exact field shape: a record was written but `vaultId` never landed.
    // Old behaviour conflated this with "absent" and fell through to the invitee
    // onboarding resume, which then reported disconnected/offline forever.
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: { apiBaseUrl: 'https://sync.example.test' },
      },
    };
    const statuses: ConnectionStatus[] = [];

    const handle = await startHavemindConnection(fakePlugin(disk), (status) => {
      statuses.push(status);
    });

    expect(statuses).toEqual(['reset-required']);
    expect(statuses).not.toContain('offline');
    expect(statuses).not.toContain('disconnected');
    // Nothing was started: the returned handle is inert.
    expect(handle.serverName).toBe('');
  });

  it('preserves the corrupt ownerConnection bytes under a timestamped sidecar before anything clears them', async () => {
    const corrupt = { apiBaseUrl: 'https://sync.example.test', vaultId: 42 };
    const disk: Disk = {
      value: { clientInstanceId: CLIENT_INSTANCE_ID, ownerConnection: corrupt },
    };

    await startHavemindConnection(fakePlugin(disk), () => undefined);

    const sidecarKeys = Object.keys(disk.value).filter((key) =>
      key.startsWith('ownerConnectionCorrupt.'),
    );
    expect(sidecarKeys).toHaveLength(1);
    expect(disk.value[sidecarKeys[0] as string]).toEqual(corrupt);
    // Detection alone never destroys the primary — only an explicit reset does.
    expect(disk.value.ownerConnection).toEqual(corrupt);
  });

  it('reports reset-required for a half-paired record whose refresh secret is missing from SecretStorage', async () => {
    // Structurally perfect record, but the refresh token it depends on is gone:
    // every push/refresh dies on auth, which used to surface as an offline loop.
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: INTACT_RECORD,
      },
    };
    const statuses: ConnectionStatus[] = [];

    await startHavemindConnection(fakePlugin(disk), (status) => {
      statuses.push(status);
    });

    expect(statuses).toEqual(['reset-required']);
  });

  it('stays on the normal connect path for an intact record with its refresh secret present (positive control)', async () => {
    // This area had a rolled-back regression (build 864652): the happy path must
    // never be re-classified as broken.
    const secretStorage = new SecretStorage();
    secretStorage.setSecret(REFRESH_SECRET_KEY, 'refresh-token');
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: INTACT_RECORD,
      },
    };

    const gate = await evaluateOwnerConnection(fakePlugin(disk, secretStorage));

    expect(gate.kind).toBe('connect');
    expect(gate.kind === 'connect' ? gate.connection : null).toMatchObject({
      apiBaseUrl: INTACT_RECORD.apiBaseUrl,
      vaultId: INTACT_RECORD.vaultId,
      memberId: INTACT_RECORD.memberId,
      deviceId: INTACT_RECORD.deviceId,
    });
    // No sidecar is written on the happy path.
    expect(
      Object.keys(disk.value).some((key) => key.includes('Corrupt.')),
    ).toBe(false);
  });

  it('treats a genuinely absent ownerConnection as absent (invitee onboarding), never reset-required', async () => {
    const disk: Disk = { value: { clientInstanceId: CLIENT_INSTANCE_ID } };
    const gate = await evaluateOwnerConnection(fakePlugin(disk));
    expect(gate.kind).toBe('absent');
  });

  it('fails OPEN when the secret probe itself throws — a SecretStorage outage never fakes a broken pairing', async () => {
    const throwingStorage = {
      getSecret(): string {
        throw new Error('SecretStorage unavailable');
      },
      setSecret(): void {
        throw new Error('SecretStorage unavailable');
      },
    };
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: INTACT_RECORD,
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gate = await evaluateOwnerConnection(
      fakePlugin(disk, throwingStorage),
    );

    expect(gate.kind).toBe('connect');
    warn.mockRestore();
  });

  it('parseOwnerConnection distinguishes absent from corrupt from connection', () => {
    expect(parseOwnerConnection(null).status).toBe('absent');
    expect(parseOwnerConnection(undefined).status).toBe('absent');
    expect(parseOwnerConnection({ apiBaseUrl: 'https://a.test' }).status).toBe(
      'corrupt',
    );
    expect(parseOwnerConnection('not-a-record').status).toBe('corrupt');
    expect(parseOwnerConnection(INTACT_RECORD).status).toBe('connection');
  });
});

describe('Reset connection action (P1 #5)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('clears the Havemind data.json keys and the stored secrets, preserving every corrupt-* sidecar', async () => {
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: { apiBaseUrl: 'https://sync.example.test' },
        syncState: { cursor: 7 },
        'syncState.bak': { cursor: 6 },
        pushProducer: { mappings: [], heads: {} },
        approvedMembersRoster: { members: [] },
        onboarding: { phase: 'connected' },
        'syncStateCorrupt.1000': { bad: 'sync' },
        'pushProducerCorrupt.2000': { bad: 'producer' },
      },
    };
    const plugin = newPlugin(disk);
    plugin.app.secretStorage.setSecret(REFRESH_SECRET_KEY, 'refresh-token');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).resetConnection();

    const keys = Object.keys(disk.value);
    // Every corrupt sidecar survives, including the one minted for the record
    // that was just cleared.
    expect(keys).toContain('syncStateCorrupt.1000');
    expect(keys).toContain('pushProducerCorrupt.2000');
    expect(keys.some((key) => key.startsWith('ownerConnectionCorrupt.'))).toBe(
      true,
    );
    // Nothing else remains — no half-paired record to loop on.
    expect(keys.filter((key) => !key.includes('Corrupt.'))).toEqual([]);
    // The secret is gone too, so a stale refresh token can never resurrect the
    // dead pairing. Obsidian's SecretStorage exposes no delete, so "cleared"
    // means an empty write — which the secrets port reads back as absent.
    expect(plugin.app.secretStorage.getSecret(REFRESH_SECRET_KEY)).toBe('');
    const secrets = new ObsidianOnboardingSecrets({
      clientInstanceId: CLIENT_INSTANCE_ID,
      secretStorage: plugin.app.secretStorage,
    });
    await expect(secrets.getRefreshToken()).resolves.toBeNull();
  });

  it('returns the UI to disconnected so the user can pair again', async () => {
    const disk: Disk = {
      value: {
        clientInstanceId: CLIENT_INSTANCE_ID,
        ownerConnection: { apiBaseUrl: 'https://sync.example.test' },
      },
    };
    const plugin = newPlugin(disk);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).connectionStatus = 'reset-required';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).resetConnection();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connectionStatus).toBe('disconnected');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (plugin as any).connectionPanel() as { showForm: boolean };
    expect(panel.showForm).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).connection).toBeNull();
  });

  it('renders an accessible "Reset connection" button in the reset-required panel', async () => {
    let reset = 0;
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'reset-required', serverName: 'sap' }),
      onReset: () => {
        reset += 1;
      },
      onConnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    const button = all.find(({ text }) => text === 'Reset connection');
    expect(button).toBeDefined();
    // Accessible name, English, no emoji.
    expect(button?.attrs['aria-label']).toBe(
      'Reset the stored Havemind connection and pair this device again',
    );
    expect(button?.text).toMatch(/^[\w\s]+$/);
    button?.triggerClick();
    expect(reset).toBe(1);
  });

  it('never renders "Retry now" in the reset-required panel — retrying a broken record just loops', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'reset-required' }),
      onRetry: () => undefined,
      onReset: () => undefined,
      onConnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    expect(all.some(({ text }) => text === 'Retry now')).toBe(false);
  });

  it('explains the broken state in the panel detail instead of blaming the server', async () => {
    const panel = buildConnectionPanel({ status: 'reset-required' });
    expect(panel.label).toBe('Connection data damaged');
    expect(panel.detail).toContain(
      'The stored connection data is incomplete or unreadable.',
    );
    expect(panel.detail).not.toContain('The server refused the session.');
    expect(panel.icon.length).toBeGreaterThan(0);
    expect(panel.colorToken).toBe('--text-error');
  });
});
