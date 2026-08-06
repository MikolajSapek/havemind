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

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

const APPEARANCE_PATH = '.obsidian/appearance.json';
const APPEARANCE_JSON = '{"accentColor":"#7c3aed","theme":"obsidian"}';
const PLUGIN_SECRET_PATH = '.obsidian/plugins/foo/data.json';

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

  it("mirrors a foreign plugin's code file (.obsidian/plugins/dataview/main.js)", async () => {
    const { vault, observer, repository, enqueued } = makeHarness();
    const mainJs = '.obsidian/plugins/dataview/main.js';
    vault.contents.set(mainJs, 'module.exports = {};\n');

    const operation = await observer.observeCreate(mainJs);

    expect(operation).not.toBeNull();
    expect(operation?.path).toBe(mainJs);
    expect(enqueued).toHaveLength(1);
    const payload = decodeRevisionPayload(
      decodeContent(enqueued[0] as OutboxEnvelope),
    );
    expect(payload.path).toBe(mainJs);
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

  it('never enqueues anything under our own .obsidian/plugins/havemind-sync/ folder', async () => {
    const { vault, observer, enqueued } = makeHarness();
    const ourMainJs = '.obsidian/plugins/havemind-sync/main.js';
    vault.contents.set(ourMainJs, 'module.exports = {};\n');

    const operation = await observer.observeCreate(ourMainJs);

    expect(operation).toBeNull();
    expect(enqueued).toHaveLength(0);
  });
});
