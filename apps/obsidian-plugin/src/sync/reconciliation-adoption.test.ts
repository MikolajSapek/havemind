/**
 * Connect-time reconcile must adopt what the vault already holds.
 *
 * Reconcile enumerates the local vault and pushes anything it has no mapping
 * for. On a device joining a populated vault that is every file, so the pilot's
 * phone re-uploaded 31 notes the desktop had just sent: same bytes, new file
 * ids, 5.4 MB over the wire, and every shared note left with two identities.
 *
 * Given a server index, reconcile now asks `adoptOrCreate` first: a file whose
 * content the vault already holds is adopted, not created. Without an index
 * (the ordinary steady-state reconcile, and any device that cannot enumerate
 * the server) the behaviour is exactly as before.
 */

import { describe, expect, it } from 'vitest';

import {
  VaultChangeObserver,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { OutboxLocalChangeRepository } from './outbox-repository';
import { reconcileVaultState } from './reconciliation';
import type { ServerFileIndex } from './join-adoption';

const VAULT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

/** Canonical hash of the note text, matching what the observer computes. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function makeHarness(port: VaultSnapshotPort) {
  let producerState: {
    mappings: LocalFileMapping[];
    heads: Record<string, string>;
  } = { mappings: [], heads: {} };
  const pushed: string[] = [];
  let mintedFileIds = 0;

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
      pushed.push(envelope.revisionId);
    },
    generateRevisionId: () => globalThis.crypto.randomUUID(),
  });

  const observer = new VaultChangeObserver({
    clock: () => 1,
    generateFileId: () => {
      mintedFileIds += 1;
      // A real UUID: the revision header schema rejects anything else, so a
      // placeholder would make every create "skip" and hide the behaviour.
      return `90000000-0000-4000-8000-${String(mintedFileIds).padStart(12, '0')}`;
    },
    generateOperationId: () => globalThis.crypto.randomUUID(),
    repository,
    vault: port,
  });

  return {
    observer,
    repository,
    pushed,
    mintedCount: () => mintedFileIds,
    mappings: () => producerState.mappings,
    vault: observer,
  };
}

function snapshotPort(files: ReadonlyMap<string, string>): VaultSnapshotPort {
  return {
    async listSyncablePaths() {
      return [...files.keys()];
    },
    async readText(path) {
      return files.get(path) ?? '';
    },
    async readBinary() {
      return new Uint8Array(0);
    },
    async listAllPaths() {
      return [...files.keys()];
    },
    async exists(path) {
      return files.has(path);
    },
  };
}

function serverIndex(
  entries: ReadonlyArray<{ hash: string; fileId: string; path: string }>,
): ServerFileIndex {
  const byHash = new Map(
    entries.map((entry) => [entry.hash, { fileId: entry.fileId, path: entry.path }]),
  );
  const byPath = new Map(
    entries.map((entry) => [entry.path, { fileId: entry.fileId, hash: entry.hash }]),
  );
  return {
    byContentHash: (hash) => byHash.get(hash),
    byPath: (path) => byPath.get(path),
  };
}

describe('reconcile with a server index', () => {
  it('adopts a file the vault already holds instead of pushing it', async () => {
    const text = 'SHARED\n';
    const files = new Map([['Notes/shared.md', text]]);
    const port = snapshotPort(files);
    const h = makeHarness(port);

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: port,
      serverIndex: serverIndex([
        {
          hash: await sha256Hex(text),
          fileId: '80000000-0000-4000-8000-000000000001',
          path: 'Notes/shared.md',
        },
      ]),
    });

    expect(result.created).toBe(0);
    expect(result.adopted).toBe(1);
    expect(h.pushed).toEqual([]);
    // The local mapping takes the SERVER's identity, not a freshly minted one.
    expect(h.mappings()[0]?.fileId).toBe('80000000-0000-4000-8000-000000000001');
    expect(h.mintedCount()).toBe(0);
  });

  it('still pushes a note that exists only on this device', async () => {
    const shared = 'SHARED\n';
    const own = 'ONLY HERE\n';
    const files = new Map([
      ['Notes/shared.md', shared],
      ['Notes/own.md', own],
    ]);
    const port = snapshotPort(files);
    const h = makeHarness(port);

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: port,
      serverIndex: serverIndex([
        {
          hash: await sha256Hex(shared),
          fileId: '80000000-0000-4000-8000-000000000001',
          path: 'Notes/shared.md',
        },
      ]),
    });

    expect(result.adopted).toBe(1);
    expect(result.created).toBe(1);
    expect(h.pushed).toHaveLength(1);
  });

  it('behaves exactly as before when no index is supplied', async () => {
    // Steady-state reconcile, and any device that cannot enumerate the server.
    const text = 'SHARED\n';
    const files = new Map([['Notes/shared.md', text]]);
    const port = snapshotPort(files);
    const h = makeHarness(port);

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: port,
    });

    expect(result.created).toBe(1);
    expect(result.adopted).toBe(0);
    expect(h.pushed).toHaveLength(1);
  });

  it('adopts a whole vault without a single push', async () => {
    // The pilot's shape: the joining device holds a copy of everything.
    const contents = ['one\n', 'two\n', 'three\n'];
    const files = new Map(
      contents.map((text, index) => [`Notes/${index}.md`, text]),
    );
    const port = snapshotPort(files);
    const h = makeHarness(port);

    const entries = await Promise.all(
      contents.map(async (text, index) => ({
        hash: await sha256Hex(text),
        fileId: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        path: `Notes/${index}.md`,
      })),
    );

    const result = await reconcileVaultState({
      observer: h.observer,
      repository: h.repository,
      vault: port,
      serverIndex: serverIndex(entries),
    });

    expect(result.adopted).toBe(3);
    expect(result.created).toBe(0);
    expect(h.pushed).toEqual([]);
  });
});
