/**
 * Integration coverage for the two-person steady state that isolated unit tests
 * miss: it drives the REAL push producer (VaultChangeObserver +
 * OutboxLocalChangeRepository) and the REAL apply adapter (VaultApplyAdapter +
 * createVaultFilePort) against ONE shared in-memory vault and ONE shared
 * DurableSyncState, with apply writes firing the same vault events the producer
 * observes. This exercises the fileId↔path↔base unification (FIX 1), the
 * re-entrancy lockstep (FIX 2) and the idempotent conflict artifact (FIX 4).
 */

import { describe, expect, it } from 'vitest';

import { TFile, TFolder } from 'obsidian';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalChangeOperation,
  type LocalFileMapping,
} from '../obsidian/vault-adapter';
import { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import { createVaultFilePort } from './obsidian-adapters';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from './local-base-lifecycle';
import { createRemoteApplyProducerSync } from './remote-apply-coordinator';
import { DurableSyncState, type PersistedSyncState } from './sync-state';
import { VaultApplyAdapter } from './vault-apply';
import type { RemoteEvent } from '../sync/sync-runner';

const VAULT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const REMOTE_FILE = '55555555-5555-4555-8555-555555555555';

async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** A single vault backing both the producer's reads and the apply writes. */
class InMemoryVault {
  readonly contents = new Map<string, string>();
  readonly folders = new Set<string>();
  onEvent: (kind: 'create' | 'modify' | 'delete', path: string) => void =
    () => undefined;

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    // Real Obsidian distinguishes files from folders by class identity
    // (`instanceof TFolder`), which `createVaultFilePort`'s conflict-folder
    // guard relies on to recover when a non-folder occupies the reserved
    // path. Return real TFile/TFolder instances (not a bare `{ path }`
    // object) so this double matches that contract.
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
    if (this.contents.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    this.contents.set(path, content);
    this.onEvent('create', path);
  }

  async modify(file: { path: string }, content: string): Promise<void> {
    this.contents.set(file.path, content);
    this.onEvent('modify', file.path);
  }

  async delete(file: { path: string }): Promise<void> {
    this.contents.delete(file.path);
    this.onEvent('delete', file.path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  /** An edit made while Havemind was NOT observing (no producer event). */
  setUnobserved(path: string, content: string): void {
    this.contents.set(path, content);
  }
}

function makeMemoryPersist(): {
  load(): Promise<unknown>;
  save(state: PersistedSyncState): Promise<void>;
} {
  let stored: PersistedSyncState | null = null;
  return {
    async load() {
      return stored;
    },
    async save(state) {
      stored = state;
    },
  };
}

function makeHarness() {
  const vault = new InMemoryVault();
  const state = new DurableSyncState({ persist: makeMemoryPersist() });

  // Producer store (in-memory).
  let producerState: {
    mappings: LocalFileMapping[];
    heads: Record<string, string>;
  } = { mappings: [], heads: {} };

  const outbox: string[] = [];
  const localActivity: LocalChangeOperation[] = [];
  let mintedFileIds = 0;
  let revisionCounter = 0;
  const fileIdQueue: string[] = [];

  const repository = new OutboxLocalChangeRepository({
    identity: {
      vaultId: VAULT_ID,
      memberId: MEMBER_ID,
      deviceId: DEVICE_ID,
    },
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
    generateRevisionId: () => {
      const n = (revisionCounter += 1);
      return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    },
    // The SAME base-lifecycle logic production wires (obsidian-adapters.ts), so
    // this integration test can never go false-green against a differently-
    // modelled base: seed on first authorship only, never advance on a push.
    onLocalMaterialized: (materialization) =>
      applyLocalMaterialization(state, materialization),
    onLocalForgotten: (forget) => forgetLocalMaterialization(state, forget),
  });

  const observer = new VaultChangeObserver({
    clock: () => 1,
    generateFileId: () => {
      mintedFileIds += 1;
      return fileIdQueue.shift() ?? `minted-${mintedFileIds}`;
    },
    generateOperationId: () => `op-${mintedFileIds}-${outbox.length}`,
    repository,
    vault: {
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
    },
  });

  // The producer's `observed` wrapper: record genuine local changes as activity.
  const pending: Promise<unknown>[] = [];
  const observed = (task: Promise<LocalChangeOperation | null>): void => {
    pending.push(
      task.then((op) => {
        if (op !== null) localActivity.push(op);
        return op;
      }),
    );
  };
  vault.onEvent = (kind, path) => {
    if (kind === 'create') observed(observer.observeCreate(path));
    else if (kind === 'modify') observed(observer.observeModify(path));
    else observed(observer.observeDelete(path));
  };

  const resolved = new Map<string, DecodedRevisionPayload>();
  const port = createVaultFilePort({
    vault: vault as unknown as never,
    state,
  });
  const adapter = new VaultApplyAdapter({
    files: port,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (event: RemoteEvent) => {
      const payload = resolved.get(event.revision.revisionId);
      if (payload === undefined) throw new Error('no payload for revision');
      return payload;
    },
    hashContent: realSha256,
    producerSync: createRemoteApplyProducerSync(() => repository),
  });

  async function drainEvents(): Promise<void> {
    // Two passes: the observer queues each event on its internal tail promise.
    await Promise.all(pending);
    await Promise.all(pending);
  }

  function remoteEvent(
    revisionId: string,
    fileId: string,
    parents?: readonly string[],
  ): RemoteEvent {
    return {
      serverSequence: 1,
      revision: {
        revisionId,
        fileId,
        contentHash: `ch-${revisionId}`,
        ...(parents === undefined ? {} : { parentRevisionIds: parents }),
      },
    };
  }

  /** The producer's current head revisionId for a file (for causal parenting). */
  function localHead(fileId: string): string | undefined {
    return producerState.heads[fileId];
  }

  function setRemote(
    revisionId: string,
    payload: DecodedRevisionPayload,
  ): void {
    resolved.set(revisionId, payload);
  }

  /** Simulate the local user authoring a note (fires a create event). */
  async function userCreate(
    path: string,
    content: string,
    fileId: string,
  ): Promise<void> {
    fileIdQueue.push(fileId);
    await vault.create(path, content);
    await drainEvents();
  }

  return {
    vault,
    state,
    adapter,
    outbox,
    localActivity,
    drainEvents,
    remoteEvent,
    setRemote,
    userCreate,
    localHead,
    mintedCount: () => mintedFileIds,
    producerMappings: () => producerState.mappings,
  };
}

describe('two-person steady-state sync (integration)', () => {
  it('(a) a peer edit to a locally-authored file updates IN PLACE with a matching base', async () => {
    const h = makeHarness();
    await h.userCreate('Notes/note.md', 'V1\n', FILE_A);

    // The producer authored the file, so the SHARED apply store now owns it.
    expect(h.state.fileIdAtPath('Notes/note.md')).toBe(FILE_A);
    expect(h.state.baseHashFor(FILE_A)).toBe(await realSha256('V1\n'));
    expect(h.outbox).toHaveLength(1);

    // The peer (which adopted FILE_A) sends an edit building on V1.
    h.setRemote('r2', {
      operation: 'update',
      path: 'Notes/note.md',
      previousPath: null,
      content: 'V2\n',
    });
    const outcome = await h.adapter.applyRemote(h.remoteEvent('r2', FILE_A));
    await h.drainEvents();

    expect(outcome).toBe('applied');
    expect(h.vault.contents.get('Notes/note.md')).toBe('V2\n');
    // No conflict artifact, and the reflected vault event was NOT re-pushed.
    expect(h.vault.contents.has(`Havemind Conflicts/${FILE_A}-r2.md`)).toBe(false);
    expect(h.outbox).toHaveLength(1);
  });

  it('(a) a peer edit to a locally-DIVERGED authored file becomes a conflict (no silent overwrite)', async () => {
    const h = makeHarness();
    await h.userCreate('Notes/note.md', 'V1\n', FILE_A);

    // The user edits the note while Havemind is not observing (base stays V1).
    h.vault.setUnobserved('Notes/note.md', 'LOCAL-EDIT\n');

    h.setRemote('r3', {
      operation: 'update',
      path: 'Notes/note.md',
      previousPath: null,
      content: 'PEER-EDIT\n',
    });
    const outcome = await h.adapter.applyRemote(h.remoteEvent('r3', FILE_A));
    await h.drainEvents();

    expect(outcome).toBe('conflict');
    // The local edit is preserved on disk; the peer edit lands in a conflict.
    expect(h.vault.contents.get('Notes/note.md')).toBe('LOCAL-EDIT\n');
    expect(h.vault.contents.get(`Havemind Conflicts/${FILE_A}-r3.md`)).toBe(
      'PEER-EDIT\n',
    );
  });

  it('(c) a concurrent peer revision with NO parentRevisionIds to a locally-edited shared file conflicts (never a silent overwrite)', async () => {
    // PRODUCTION REALITY: the live transport delivers pulled events with NO
    // parentRevisionIds (they are not surfaced through the pull path), so the
    // causal fast-forward check cannot fire. The only thing standing between a
    // concurrent peer edit and a silent overwrite is the on-disk-vs-base guard —
    // which is only safe if the base was NOT advanced by this device's own push.
    const h = makeHarness();
    await h.userCreate('Notes/note.md', 'V1\n', FILE_A);
    expect(h.state.baseHashFor(FILE_A)).toBe(await realSha256('V1\n'));

    // The local user edits the note (observed): a genuine local push. The base
    // must stay at the last MUTUALLY AGREED content (V1), never advance to V2.
    await h.vault.modify({ path: 'Notes/note.md' }, 'V2\n');
    await h.drainEvents();
    expect(h.vault.contents.get('Notes/note.md')).toBe('V2\n');
    expect(h.state.baseHashFor(FILE_A)).toBe(await realSha256('V1\n'));

    // A CONCURRENT peer revision (built on V1, never having seen V2) arrives with
    // NO parents, exactly as the real transport delivers it.
    h.setRemote('r5', {
      operation: 'update',
      path: 'Notes/note.md',
      previousPath: null,
      content: 'PEER\n',
    });
    const outcome = await h.adapter.applyRemote(h.remoteEvent('r5', FILE_A));
    await h.drainEvents();

    // It must become a conflict artifact — never overwrite the local V2 edit.
    expect(outcome).toBe('conflict');
    expect(h.vault.contents.get('Notes/note.md')).toBe('V2\n');
    expect(h.vault.contents.get(`Havemind Conflicts/${FILE_A}-r5.md`)).toBe(
      'PEER\n',
    );
  });

  it('(b) a remote-only create adopts the incoming fileId and is never re-pushed or re-attributed', async () => {
    const h = makeHarness();

    h.setRemote('r1', {
      operation: 'create',
      path: 'Notes/peer.md',
      previousPath: null,
      content: 'PEER\n',
    });
    const outcome = await h.adapter.applyRemote(h.remoteEvent('r1', REMOTE_FILE));
    await h.drainEvents();

    expect(outcome).toBe('applied');
    expect(h.vault.contents.get('Notes/peer.md')).toBe('PEER\n');

    // Re-entrancy guard: the reflected 'create' event minted NO new fileId, was
    // NOT re-pushed, and was NOT recorded as local activity.
    expect(h.mintedCount()).toBe(0);
    expect(h.outbox).toEqual([]);
    expect(h.localActivity).toEqual([]);

    // The producer adopted the incoming fileId for the path (no duplicate id).
    const mappings = h.producerMappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.fileId).toBe(REMOTE_FILE);
    expect(mappings[0]?.path).toBe('Notes/peer.md');
    expect(h.state.fileIdAtPath('Notes/peer.md')).toBe(REMOTE_FILE);
  });

  it('(d) writing the same conflict artifact twice (or over a pre-existing file) does not throw', async () => {
    const h = makeHarness();
    // createVaultFilePort is the port under test here.
    const port = createVaultFilePort({
      vault: h.vault as unknown as never,
      state: h.state,
    });

    const path = 'Havemind Conflicts/fileX-revY.md';
    await expect(port.writeConflictArtifact(path, 'C1\n')).resolves.toBeUndefined();
    // A second delivery / crash-replay must overwrite, never throw (which the
    // runner would misread as offline and wedge the whole pull loop).
    await expect(port.writeConflictArtifact(path, 'C2\n')).resolves.toBeUndefined();
    expect(h.vault.contents.get(path)).toBe('C2\n');
  });
});
