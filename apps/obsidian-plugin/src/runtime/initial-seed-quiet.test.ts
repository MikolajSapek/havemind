import { describe, expect, it } from 'vitest';

import { TFile, TFolder } from 'obsidian';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalChangeOperation,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import { reconcileVaultState } from '../sync/reconciliation';
import { createVaultFilePort } from './obsidian-adapters';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from './local-base-lifecycle';
import { createRemoteApplyProducerSync } from './remote-apply-coordinator';
import { DurableSyncState, type PersistedSyncState } from './sync-state';
import { VaultApplyAdapter, type RemoteAppliedEvent } from './vault-apply';
import type { RemoteEvent } from '../sync/sync-runner';

const VAULT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

class InMemoryVault {
  readonly contents = new Map<string, string>();
  readonly folders = new Set<string>();
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.folders.has(path)) {
      const folder = new TFolder();
      folder.path = path;
      return folder;
    }
    if (this.contents.has(path)) {
      const file = new TFile();
      file.path = path;
      return file;
    }
    return null;
  }
  async read(file: { path: string }): Promise<string> {
    return this.contents.get(file.path) ?? '';
  }
  async create(path: string, content: string): Promise<void> {
    this.contents.set(path, content);
  }
  async modify(file: { path: string }, content: string): Promise<void> {
    this.contents.set(file.path, content);
  }
  async delete(file: { path: string }): Promise<void> {
    this.contents.delete(file.path);
  }
  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
}

function makeMemoryPersist() {
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

/**
 * Characterisation / regression guard for the owner's one-time initial seed.
 *
 * The reported UX concern was that connecting a vault that already has files
 * "replays the whole day's work" in the Activity panel, one row per pre-existing
 * file. This test pins the ACTUAL behaviour at HEAD: the seed pushes every file
 * (sync intact) but records ZERO Activity entries, both on the local
 * reconciliation path and when the owner's own revisions echo back through the
 * pull. Ongoing live edits still record normally (positive control). If a future
 * change wires reconciliation into the Activity feed, the zero-row assertions
 * below fail and flag the regression.
 */
describe('owner initial seed is quiet in the Activity feed', () => {
  function makeHarness() {
    const vault = new InMemoryVault();
    const state = new DurableSyncState({ persist: makeMemoryPersist() });

    let producerState: {
      mappings: LocalFileMapping[];
      heads: Record<string, string>;
    } = { mappings: [], heads: {} };

    const outbox: string[] = [];
    const localActivity: LocalChangeOperation[] = [];

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
      generateFileId: () => globalThis.crypto.randomUUID(),
      generateOperationId: () => globalThis.crypto.randomUUID(),
      repository,
      vault: snapshot,
    });

    // The producer's live-listener `observed` wrapper (obsidian-adapters.ts):
    // genuine local changes are recorded as Activity. Reconciliation deliberately
    // does NOT go through this wrapper.
    const observed = async (
      task: Promise<LocalChangeOperation | null>,
    ): Promise<void> => {
      const op = await task;
      if (op !== null) localActivity.push(op);
    };

    const remoteApplied: RemoteAppliedEvent[] = [];
    const resolved = new Map<string, DecodedRevisionPayload>();
    const adapter = new VaultApplyAdapter({
      files: createVaultFilePort({ vault: vault as unknown as never, state }),
      conflictFolder: 'Havemind Conflicts',
      resolveRevision: async (event: RemoteEvent) => {
        const payload = resolved.get(event.revision.revisionId);
        if (payload === undefined) throw new Error('no payload for revision');
        return payload;
      },
      hashContent: realSha256,
      producerSync: createRemoteApplyProducerSync(() => repository),
      onRemoteApplied: (event) => remoteApplied.push(event),
    });

    return {
      vault,
      snapshot,
      observer,
      repository,
      observed,
      outbox,
      localActivity,
      remoteApplied,
      resolved,
      adapter,
      producerMappings: () => producerState.mappings,
      headFor: (fileId: string) => producerState.heads[fileId],
    };
  }

  it('seeds every pre-existing file to the outbox without recording any Activity', async () => {
    const h = makeHarness();
    const N = 5;
    for (let i = 0; i < N; i += 1) {
      h.vault.contents.set(`Notes/pre-${i}.md`, `content ${i}\n`);
    }

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: h.snapshot,
    });

    // Sync is intact: every pre-existing file is enumerated and enqueued.
    expect(result.created).toBe(N);
    expect(h.outbox).toHaveLength(N);
    expect(h.producerMappings()).toHaveLength(N);

    // The seed is silent: reconciliation records ZERO Activity entries.
    expect(h.localActivity).toHaveLength(0);

    // The owner's own revisions echoing back through the pull are no-ops, so the
    // remote-apply Activity hook never fires for the baseline either.
    for (const mapping of h.producerMappings()) {
      const revisionId = h.headFor(mapping.fileId);
      if (revisionId === undefined) continue;
      h.resolved.set(revisionId, {
        operation: 'create',
        kind: 'markdown',
        path: mapping.path,
        content: mapping.content,
        previousPath: null,
      } as unknown as DecodedRevisionPayload);
      const outcome = await h.adapter.applyRemote({
        serverSequence: 1,
        revision: {
          revisionId,
          fileId: mapping.fileId,
          contentHash: mapping.contentHash,
        },
      } as unknown as RemoteEvent);
      expect(outcome).toBe('noop');
    }
    expect(h.remoteApplied).toHaveLength(0);
  });

  it('records a subsequent live local edit as a normal Activity entry (positive control)', async () => {
    const h = makeHarness();
    h.vault.contents.set('Notes/pre-0.md', 'content 0\n');
    await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: h.snapshot,
    });
    expect(h.localActivity).toHaveLength(0);

    // A genuine edit after the seed flows through the live-listener wrapper.
    h.vault.contents.set('Notes/pre-0.md', 'content 0 edited\n');
    await h.observed(h.observer.observeModify('Notes/pre-0.md'));

    expect(h.localActivity).toHaveLength(1);
    expect(h.localActivity[0]?.kind).toBe('update');
  });
});
