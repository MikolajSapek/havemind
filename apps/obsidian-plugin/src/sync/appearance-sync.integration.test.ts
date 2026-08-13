/**
 * Integration coverage for the SAFE appearance-config sync scope (F-appearance).
 * It drives the REAL producer path — VaultChangeObserver +
 * OutboxLocalChangeRepository — against an in-memory vault that surfaces
 * `.obsidian/` config files, and asserts the scope decision end-to-end:
 *
 *  - an allowlisted config change (`.obsidian/appearance.json`) is classified,
 *    committed and ENQUEUED as an opaque revision envelope; and
 *  - a denylisted plugin secret (`.obsidian/plugins/foo/data.json`) is NEVER
 *    classified, committed or enqueued.
 *
 * This proves the guard admits the allowlist and rejects the denylist through
 * the same machinery real sync uses, not just the pure predicate in isolation.
 */

import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from './outbox-repository';
import { reconcileVaultState } from './reconciliation';

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

const APPEARANCE_PATH = '.obsidian/appearance.json';
const APPEARANCE_JSON = '{"accentColor":"#7c3aed","theme":"obsidian"}';
const PLUGIN_SECRET_PATH = '.obsidian/plugins/foo/data.json';
const GRAPH_PATH = '.obsidian/graph.json';

/** Minimal in-memory vault that (unlike real Obsidian) surfaces `.obsidian/`. */
class InMemoryConfigVault implements VaultSnapshotPort {
  readonly contents = new Map<string, string>();

  async listSyncablePaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }

  async listAllPaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }

  async readText(path: string): Promise<string> {
    return this.contents.get(path) ?? '';
  }

  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }

  async exists(path: string): Promise<boolean> {
    return this.contents.has(path);
  }
}

class MemoryStore {
  state: ProducerState = { mappings: [], heads: {} };
  async load(): Promise<ProducerState> {
    return this.state;
  }
  async save(state: ProducerState): Promise<void> {
    this.state = state;
  }
}

function makeHarness() {
  const vault = new InMemoryConfigVault();
  const enqueued: OutboxEnvelope[] = [];
  let revCounter = 0;
  let fileCounter = 0;
  let opCounter = 0;

  const repository = new OutboxLocalChangeRepository({
    identity: IDENTITY,
    store: new MemoryStore(),
    enqueue: async (envelope) => {
      enqueued.push(envelope);
    },
    generateRevisionId: () => {
      revCounter += 1;
      return `00000000-0000-4000-8000-00000000000${revCounter}`;
    },
    onLocalMaterialized: async () => undefined,
    onLocalForgotten: async () => undefined,
  });

  const observer = new VaultChangeObserver({
    clock: () => 1,
    generateFileId: () => {
      fileCounter += 1;
      return `ffffffff-0000-4000-8000-00000000000${fileCounter}`;
    },
    generateOperationId: () => {
      opCounter += 1;
      return `op-${opCounter}`;
    },
    repository,
    vault,
  });

  return { vault, observer, repository, enqueued };
}

function decodeContent(envelope: OutboxEnvelope): string {
  return Buffer.from(envelope.payloadBase64, 'base64').toString('utf8');
}

describe('appearance-config sync scope (integration)', () => {
  it('enqueues an allowlisted .obsidian/appearance.json change as an opaque revision', async () => {
    const { vault, observer, repository, enqueued } = makeHarness();
    vault.contents.set(APPEARANCE_PATH, APPEARANCE_JSON);

    const operation = await observer.observeCreate(APPEARANCE_PATH);

    expect(operation).not.toBeNull();
    expect(operation?.kind).toBe('create');
    expect(operation?.path).toBe(APPEARANCE_PATH);

    expect(enqueued).toHaveLength(1);
    const envelope = enqueued[0] as OutboxEnvelope;
    const payload = decodeRevisionPayload(decodeContent(envelope));
    expect(payload.path).toBe(APPEARANCE_PATH);
    expect(payload.content).toContain('"accentColor":"#7c3aed"');

    // The config file is now a durable mapping — a later modify resolves it.
    expect(await repository.listMappings()).toHaveLength(1);
  });

  it('never enqueues a denylisted .obsidian/plugins/foo/data.json change', async () => {
    const { vault, observer, repository, enqueued } = makeHarness();
    vault.contents.set(PLUGIN_SECRET_PATH, '{"secret":"do-not-sync"}');

    const operation = await observer.observeCreate(PLUGIN_SECRET_PATH);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(await repository.listMappings()).toHaveLength(0);
  });

  it('DENYLIST WINS: a data.json under the themes-lookalike allow path is not enqueued', async () => {
    const { vault, observer, enqueued } = makeHarness();
    const themesDataJson = '.obsidian/themes/Minimal/data.json';
    vault.contents.set(themesDataJson, '{"secret":"nope"}');

    const operation = await observer.observeCreate(themesDataJson);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
  });

  it("NEVER enqueues a foreign plugin's code file (.obsidian/plugins/dataview/main.js)", async () => {
    // Audit #3 finding 2: mirroring plugin code let any vault member replace
    // another member's installed plugin — remote code execution on reload. The
    // allowlist admits appearance settings only, so the producer path never even
    // classifies this file.
    const { vault, observer, repository, enqueued } = makeHarness();
    const mainJs = '.obsidian/plugins/dataview/main.js';
    vault.contents.set(mainJs, 'module.exports = {};\n');

    const operation = await observer.observeCreate(mainJs);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(await repository.listMappings()).toHaveLength(0);
  });

  it("NEVER enqueues a foreign plugin's manifest or stylesheet either", async () => {
    const { vault, observer, enqueued } = makeHarness();
    for (const path of [
      '.obsidian/plugins/dataview/manifest.json',
      '.obsidian/plugins/dataview/styles.css',
    ]) {
      vault.contents.set(path, 'x');
      expect(await observer.observeCreate(path)).toBeNull();
    }
    expect(enqueued).toHaveLength(0);
  });

  it('enqueues an allowlisted theme stylesheet (.obsidian/themes/Minimal/theme.css)', async () => {
    const { vault, observer, repository, enqueued } = makeHarness();
    const themeCss = '.obsidian/themes/Minimal/theme.css';
    vault.contents.set(themeCss, 'body { --accent: #7c3aed; }\n');

    const operation = await observer.observeCreate(themeCss);

    expect(operation).not.toBeNull();
    expect(operation?.path).toBe(themeCss);
    expect(enqueued).toHaveLength(1);
    const payload = decodeRevisionPayload(
      decodeContent(enqueued[0] as OutboxEnvelope),
    );
    expect(payload.path).toBe(themeCss);
    expect(await repository.listMappings()).toHaveLength(1);
  });

  it('never enqueues the enabled-plugins list .obsidian/community-plugins.json', async () => {
    const { vault, observer, enqueued } = makeHarness();
    const communityPlugins = '.obsidian/community-plugins.json';
    vault.contents.set(communityPlugins, '["dataview","havemind-sync"]');

    const operation = await observer.observeCreate(communityPlugins);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
  });

  it('pushes graph.json WITHOUT its machine-local view state', async () => {
    // `scale` and the `collapse-*` flags describe this screen, not the user's
    // settings. They must never reach the wire, or the peer would adopt this
    // machine's zoom level (see `config-normalize.ts`).
    const { vault, observer, enqueued } = makeHarness();
    vault.contents.set(
      GRAPH_PATH,
      JSON.stringify({
        scale: 1.739,
        close: true,
        'collapse-filter': true,
        colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
        showTags: true,
      }),
    );

    const operation = await observer.observeCreate(GRAPH_PATH);

    expect(operation).not.toBeNull();
    expect(enqueued).toHaveLength(1);
    const payload = decodeRevisionPayload(
      decodeContent(enqueued[0] as OutboxEnvelope),
    );
    const pushed = JSON.parse(payload.content ?? '') as Record<string, unknown>;
    expect(pushed).toEqual({
      colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
      showTags: true,
    });
  });

  it('enqueues NOTHING when opening the graph view rewrote only scale/collapse state', async () => {
    // The reported bug: merely OPENING the graph view makes Obsidian rewrite
    // graph.json, which used to produce a revision on every open — two devices
    // then ping-ponged and spawned conflict copies of a settings file.
    const { vault, observer, enqueued } = makeHarness();
    const semantic = { colorGroups: [{ query: 'tag:#work' }], showTags: true };
    vault.contents.set(GRAPH_PATH, JSON.stringify({ ...semantic, scale: 1 }));
    await observer.observeCreate(GRAPH_PATH);
    expect(enqueued).toHaveLength(1);

    // Obsidian rewrites the file: new zoom, panels folded, nothing semantic.
    vault.contents.set(
      GRAPH_PATH,
      JSON.stringify({
        ...semantic,
        scale: 2.7182818,
        close: true,
        'collapse-forces': true,
      }),
    );
    const afterOpen = await observer.observeModify(GRAPH_PATH);

    expect(afterOpen).toBeNull();
    expect(enqueued).toHaveLength(1);
  });

  it('still enqueues a genuine colour-group change to graph.json', async () => {
    const { vault, observer, enqueued } = makeHarness();
    vault.contents.set(GRAPH_PATH, JSON.stringify({ colorGroups: [], scale: 1 }));
    await observer.observeCreate(GRAPH_PATH);

    vault.contents.set(
      GRAPH_PATH,
      JSON.stringify({
        colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
        scale: 9,
      }),
    );
    const operation = await observer.observeModify(GRAPH_PATH);

    expect(operation?.kind).toBe('update');
    expect(enqueued).toHaveLength(2);
    const payload = decodeRevisionPayload(
      decodeContent(enqueued[1] as OutboxEnvelope),
    );
    expect(payload.content).toContain('"rgb": 8087286');
    expect(payload.content).not.toContain('scale');
  });

  it('a full reconcile scan reads a zoom-only graph.json rewrite as UNCHANGED', async () => {
    // The observer is only one of the two producer entry points. The startup /
    // post-outage scan (`reconcileVaultState`) reads every eligible file itself
    // and compares it against the mapping, so it needs the same volatile-field
    // filter — otherwise a device that merely had the graph view open before a
    // restart re-pushes a settings revision on every reconnect.
    const { vault, observer, repository, enqueued } = makeHarness();
    const semantic = {
      colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
      showTags: true,
    };
    vault.contents.set(GRAPH_PATH, JSON.stringify({ ...semantic, scale: 1 }));
    await observer.observeCreate(GRAPH_PATH);
    expect(enqueued).toHaveLength(1);

    vault.contents.set(
      GRAPH_PATH,
      JSON.stringify({
        ...semantic,
        scale: 3.14159,
        close: true,
        'collapse-display': true,
      }),
    );
    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it('a full reconcile scan still stages a genuine colour-group change', async () => {
    const { vault, observer, repository, enqueued } = makeHarness();
    vault.contents.set(GRAPH_PATH, JSON.stringify({ colorGroups: [], scale: 1 }));
    await observer.observeCreate(GRAPH_PATH);

    vault.contents.set(
      GRAPH_PATH,
      JSON.stringify({
        colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
        scale: 1,
      }),
    );
    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(enqueued).toHaveLength(2);
    const payload = decodeRevisionPayload(
      decodeContent(enqueued[1] as OutboxEnvelope),
    );
    expect(payload.content).toContain('"rgb": 8087286');
    expect(payload.content).not.toContain('scale');
  });

  it('never enqueues anything under our own .obsidian/plugins/havemind-sync/ folder', async () => {
    const { vault, observer, enqueued } = makeHarness();
    const ourMainJs = '.obsidian/plugins/havemind-sync/main.js';
    vault.contents.set(ourMainJs, 'module.exports = {};\n');

    const operation = await observer.observeCreate(ourMainJs);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
  });
});
