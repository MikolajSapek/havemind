/**
 * Empty-phone join must not mint conflict copies.
 *
 * Bootstrap materialises server heads before vault listeners exist. If the
 * producer mapping is still unbound during that pull, connect-time reconcile
 * treats every just-written note as a brand-new local create, pushes a fresh
 * fileId for the same path, and the next cycle storms Havemind Conflicts with
 * "Target unknown" rows on an otherwise empty phone vault.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import type { LocalFileMapping } from '../obsidian/vault-adapter';
import { VaultChangeObserver, type VaultSnapshotPort } from '../obsidian/vault-adapter';
import { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import { reconcileVaultState } from '../sync/reconciliation';
import type { RemoteEvent } from '../sync/sync-runner';
import { createRemoteApplyProducerSync } from './remote-apply-coordinator';
import { createVaultFilePort } from './adapters/vault-file-port';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from './local-base-lifecycle';
import { DurableSyncState, type PersistedSyncState } from './sync-state';
import { VaultApplyAdapter } from './vault-apply';

const VAULT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const FILE_ID = '44444444-4444-4444-8444-444444444444';
const REV_ID = '55555555-5555-4555-8555-555555555555';

async function realSha256(content: string): Promise<string> {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

class InMemoryVault {
  readonly contents = new Map<string, string>();
  readonly adapter = {
    exists: async (path: string) => this.contents.has(path),
    read: async (path: string) => this.contents.get(path) ?? '',
    readBinary: async () => new ArrayBuffer(0),
    write: async (path: string, data: string) => {
      this.contents.set(path, data);
    },
    writeBinary: async () => undefined,
    mkdir: async () => undefined,
    remove: async (path: string) => {
      this.contents.delete(path);
    },
  };
  getFiles() {
    return [...this.contents.keys()].map((path) => ({ path }));
  }
  getAbstractFileByPath(path: string) {
    return this.contents.has(path) ? { path } : null;
  }
  async read(file: { path: string }) {
    return this.contents.get(file.path) ?? '';
  }
  async readBinary() {
    return new ArrayBuffer(0);
  }
  async create(path: string, content: string) {
    if (this.contents.has(path)) throw new Error(`already exists: ${path}`);
    this.contents.set(path, content);
  }
  async modify(file: { path: string }, content: string) {
    this.contents.set(file.path, content);
  }
  async createFolder() {
    /* folders are implicit in this harness */
  }
  async createBinary() {
    /* unused */
  }
  async delete(path: string) {
    this.contents.delete(path);
  }
}

function makePersist() {
  let stored: PersistedSyncState | null = null;
  return {
    async load() {
      return stored;
    },
    async loadBackup() {
      return null;
    },
    async save(state: PersistedSyncState) {
      stored = state;
    },
    async preserveCorrupt() {
      /* no-op */
    },
  };
}

function remoteEvent(): RemoteEvent {
  return {
    serverSequence: 1,
    revision: {
      revisionId: REV_ID,
      fileId: FILE_ID,
      contentHash: 'will-be-ignored',
      parentRevisionIds: [],
    },
  };
}

describe('bootstrap producer binding (empty-phone join)', () => {
  function makeHarness(getProducer: () => OutboxLocalChangeRepository | null) {
    const vault = new InMemoryVault();
    const state = new DurableSyncState({ persist: makePersist() });
    let producerState: {
      mappings: LocalFileMapping[];
      heads: Record<string, string>;
    } = { mappings: [], heads: {} };
    const outbox: string[] = [];

    const repository = new OutboxLocalChangeRepository({
      identity: { vaultId: VAULT_ID, memberId: MEMBER_ID, deviceId: DEVICE_ID },
      store: {
        async load() {
          return producerState;
        },
        async save(next) {
          producerState = {
            mappings: [...next.mappings],
            heads: { ...next.heads },
          };
        },
      },
      enqueue: async (envelope) => {
        outbox.push(envelope.revisionId);
      },
      generateRevisionId: () => globalThis.crypto.randomUUID(),
      onLocalMaterialized: (m) => applyLocalMaterialization(state, m),
      onLocalForgotten: (f) => forgetLocalMaterialization(state, f),
    });

    const snapshot: VaultSnapshotPort = {
      async listSyncablePaths() {
        return [...vault.contents.keys()];
      },
      async readText(path) {
        return vault.contents.get(path) ?? '';
      },
      async readBinary() {
        return new Uint8Array(0);
      },
      async listAllPaths() {
        return [...vault.contents.keys()];
      },
      async exists(path) {
        return vault.contents.has(path);
      },
    };

    const observer = new VaultChangeObserver({
      clock: () => 1,
      generateFileId: () => '66666666-6666-4666-8666-666666666666',
      generateOperationId: () => '77777777-7777-4777-8777-777777777777',
      repository,
      vault: snapshot,
    });

    const adapter = new VaultApplyAdapter({
      files: createVaultFilePort({ vault: vault as unknown as never, state }),
      conflictFolder: 'Havemind Conflicts',
      resolveRevision: async () =>
        ({
          kind: 'markdown',
          operation: 'create',
          path: 'Notes/Hackathon 2027.md',
          previousPath: null,
          content: 'REMOTE\n',
        }) satisfies DecodedRevisionPayload,
      hashContent: realSha256,
      producerSync: createRemoteApplyProducerSync(getProducer),
      onRemoteApplied: () => undefined,
    });

    return {
      vault,
      snapshot,
      observer,
      repository,
      outbox,
      adapter,
      producerState: () => producerState,
    };
  }

  it('reconcile leaves bootstrap files unchanged when the producer was bound during apply', async () => {
    let bound: OutboxLocalChangeRepository | null = null;
    const h = makeHarness(() => bound);
    bound = h.repository;

    await h.adapter.applyRemote(remoteEvent(), { bootstrap: true });
    expect(h.vault.contents.get('Notes/Hackathon 2027.md')).toBe('REMOTE\n');
    expect(h.producerState().mappings).toHaveLength(1);

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: h.snapshot,
    });

    expect(result.created).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(h.outbox).toEqual([]);
    expect(
      [...h.vault.contents.keys()].some((p) => p.startsWith('Havemind Conflicts/')),
    ).toBe(false);
  });

  it('reconcile forks a new fileId when bootstrap applied with producer unbound', async () => {
    // Characterises the empty-phone storm: syncNow ran before producerRef was
    // set, so adopt was a no-op and reconcile treated every note as local-new.
    const h = makeHarness(() => null);

    await h.adapter.applyRemote(remoteEvent(), { bootstrap: true });
    expect(h.producerState().mappings).toHaveLength(0);

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: h.snapshot,
    });

    expect(result.created).toBe(1);
    expect(h.outbox).toHaveLength(1);
    expect(h.producerState().mappings[0]?.fileId).toBe(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(h.producerState().mappings[0]?.fileId).not.toBe(FILE_ID);
  });
});
