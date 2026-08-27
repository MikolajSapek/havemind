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
    // FIDELITY: real Obsidian throws when the immediate parent folder is
    // missing (it does not auto-create it). Modelling that throw is what makes
    // the missing-parent-folder field outage reproducible here.
    this.assertParentFolderExists(path);
    this.contents.set(path, content);
    this.onEvent('create', path);
  }

  private assertParentFolderExists(path: string): void {
    const separatorIndex = path.lastIndexOf('/');
    if (separatorIndex === -1) return;
    const parent = path.slice(0, separatorIndex);
    if (!this.folders.has(parent)) {
      throw new Error(`Folder does not exist: ${parent}`);
    }
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
    this.assertParentFolderExists(path);
    this.folders.add(path);
  }

  /** An edit made while Havemind was NOT observing (no producer event). */
  setUnobserved(path: string, content: string): void {
    this.contents.set(path, content);
  }
}

function makeMemoryPersist(): {
  load(): Promise<unknown>;
  loadBackup(): Promise<unknown>;
  save(state: PersistedSyncState): Promise<void>;
  preserveCorrupt(raw: unknown, timestamp: number): Promise<void>;
} {
  let stored: PersistedSyncState | null = null;
  let backup: PersistedSyncState | null = null;
  return {
    async load() {
      return stored;
    },
    async loadBackup() {
      return backup;
    },
    async save(state) {
      backup = stored;
      stored = state;
    },
    async preserveCorrupt() {
      /* no-op: this steady-state harness never seeds a corrupt blob */
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
      async exists(path) {
        return vault.contents.has(path);
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
    // Deterministic readable-conflict naming (MRG-02) for exact assertions.
    conflictNaming: {
      now: () => new Date(2026, 6, 22, 21, 56),
      resolveAuthorName: () => 'Peer',
    },
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

  /** Simulate the local user authoring a note (fires a create event). A real
   * local author already has the containing folder (they created the note in
   * it), so seed the parent-folder chain first, the double now throws on a
   * create into a missing folder, exactly like real Obsidian. */
  async function userCreate(
    path: string,
    content: string,
    fileId: string,
  ): Promise<void> {
    const separatorIndex = path.lastIndexOf('/');
    if (separatorIndex !== -1) {
      const segments = path.slice(0, separatorIndex).split('/');
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`;
        if (!vault.folders.has(prefix)) await vault.createFolder(prefix);
      }
    }
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
    expect(h.vault.contents.has('Havemind Conflicts/note (conflict Peer 2026-07-22 2156).md')).toBe(false);
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
    expect(h.vault.contents.get('Havemind Conflicts/note (conflict Peer 2026-07-22 2156).md')).toBe(
      'PEER-EDIT\n',
    );
  });

  it('(c) a concurrent peer revision with NO parentRevisionIds to a locally-edited shared file conflicts (never a silent overwrite)', async () => {
    // PRODUCTION REALITY: the live transport delivers pulled events with NO
    // parentRevisionIds (they are not surfaced through the pull path), so the
    // causal fast-forward check cannot fire. The only thing standing between a
    // concurrent peer edit and a silent overwrite is the on-disk-vs-base guard,
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

    // It must become a conflict artifact, never overwrite the local V2 edit.
    expect(outcome).toBe('conflict');
    expect(h.vault.contents.get('Notes/note.md')).toBe('V2\n');
    expect(h.vault.contents.get('Havemind Conflicts/note (conflict Peer 2026-07-22 2156).md')).toBe(
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

  it('(e) a remote create into a not-yet-existing folder materializes the folder and applies (5-day field outage repro)', async () => {
    // The exact field scenario: a freshly onboarded vault with no `Notatki`
    // folder pulls a remote create for `Notatki/Start pilotażu.md`. Before the
    // fix `vault.create` threw (missing parent), that throw bubbled to the pull
    // cycle, the cursor never advanced, and sync wedged on 'Offline' for 5 days.
    const h = makeHarness();
    h.setRemote('r1', {
      operation: 'create',
      path: 'Notatki/Start pilotażu.md',
      previousPath: null,
      content: 'S\n',
    });

    const outcome = await h.adapter.applyRemote(h.remoteEvent('r1', REMOTE_FILE));
    await h.drainEvents();

    expect(outcome).toBe('applied');
    expect(h.vault.contents.get('Notatki/Start pilotażu.md')).toBe('S\n');
    expect(h.vault.folders.has('Notatki')).toBe(true);
  });

  it('(e) a backlog of root + deeply-subfoldered creates all apply in sequence (the wedge is gone)', async () => {
    const h = makeHarness();
    const backlog: ReadonlyArray<readonly [string, string, string]> = [
      ['rr', 'file-root', 'Root.md'],
      ['rn', 'file-notatki', 'Notatki/Start.md'],
      ['rd', 'file-deep', 'Projekty/Havemind/Plan.md'],
    ];
    const outcomes: string[] = [];
    for (const [rev, file, path] of backlog) {
      h.setRemote(rev, {
        operation: 'create',
        path,
        previousPath: null,
        content: `${path}\n`,
      });
      outcomes.push(await h.adapter.applyRemote(h.remoteEvent(rev, file)));
      await h.drainEvents();
    }

    expect(outcomes).toEqual(['applied', 'applied', 'applied']);
    expect(h.vault.contents.get('Notatki/Start.md')).toBe('Notatki/Start.md\n');
    expect(h.vault.contents.get('Projekty/Havemind/Plan.md')).toBe(
      'Projekty/Havemind/Plan.md\n',
    );
    expect(h.vault.folders.has('Projekty')).toBe(true);
    expect(h.vault.folders.has('Projekty/Havemind')).toBe(true);
  });

  it('(e) an ancestor occupied by a FILE diverts that item to a conflict artifact; the next event still applies', async () => {
    const h = makeHarness();
    // A note literally named `Notatki` (no extension) occupies the would-be
    // folder path for the incoming `Notatki/Start.md`.
    await h.userCreate('Notatki', 'I AM A FILE\n', FILE_A);

    h.setRemote('r1', {
      operation: 'create',
      path: 'Notatki/Start.md',
      previousPath: null,
      content: 'S\n',
    });
    const blocked = await h.adapter.applyRemote(h.remoteEvent('r1', REMOTE_FILE));
    await h.drainEvents();

    // Per-item: diverted to a conflict artifact, the occupying file untouched.
    expect(blocked).toBe('conflict');
    expect(h.vault.contents.get('Notatki')).toBe('I AM A FILE\n');
    expect(h.vault.contents.get('Havemind Conflicts/Start (conflict Peer 2026-07-22 2156).md')).toBe(
      'S\n',
    );

    // The cycle continues: a following, unrelated event still applies cleanly.
    h.setRemote('r2', {
      operation: 'create',
      path: 'Other.md',
      previousPath: null,
      content: 'O\n',
    });
    const next = await h.adapter.applyRemote(h.remoteEvent('r2', 'file-other'));
    await h.drainEvents();

    expect(next).toBe('applied');
    expect(h.vault.contents.get('Other.md')).toBe('O\n');
  });

  it('(f) two devices with concurrent non-overlapping edits merge and converge (MRG-01)', async () => {
    // Two real apply adapters + producers over two vaults, exchanging revisions
    // through a hand-relayed wire, proving the merge round-trips to convergence
    // with no conflict artifacts and no ping-pong.
    const NOTE = 'Notes/note.md';
    const BASE = 'L1\nL2\nL3\nL4\nL5\n';
    const LOCAL_A = 'A1\nL2\nL3\nL4\nL5\n'; // A edits the first line
    const REMOTE_B = 'L1\nL2\nL3\nL4\nB5\n'; // B edits the last line
    const MERGED = 'A1\nL2\nL3\nL4\nB5\n'; // both edits combined

    // Relayed revision ids must be valid UUIDs, an adopted remote revision id
    // becomes the local head and is later validated as a revision parent.
    const REV_BASE = '10000000-0000-4000-8000-000000000000';
    const REV_B = '20000000-0000-4000-8000-000000000000';
    const REV_A = '30000000-0000-4000-8000-000000000000';
    const REV_BMERGE = '40000000-0000-4000-8000-000000000000';
    const REV_AMERGE = '50000000-0000-4000-8000-000000000000';

    const a = makeHarness();
    const b = makeHarness();

    const update = (content: string): DecodedRevisionPayload => ({
      operation: 'update',
      path: NOTE,
      previousPath: null,
      content,
    });

    // Both devices converge on the shared base BASE for FILE_A.
    await a.userCreate(NOTE, BASE, FILE_A);
    b.setRemote(REV_BASE, { ...update(BASE), operation: 'create' });
    await b.adapter.applyRemote(b.remoteEvent(REV_BASE, FILE_A));
    await b.drainEvents();
    expect(b.state.baseHashFor(FILE_A)).toBe(await realSha256(BASE));

    // Each device makes a concurrent, non-overlapping local edit and pushes it.
    await a.vault.modify({ path: NOTE }, LOCAL_A);
    await a.drainEvents();
    await b.vault.modify({ path: NOTE }, REMOTE_B);
    await b.drainEvents();

    // A pulls B's concurrent revision (no causal parent) → three-way merge.
    a.setRemote(REV_B, update(REMOTE_B));
    const aOutcome = await a.adapter.applyRemote(a.remoteEvent(REV_B, FILE_A));
    await a.drainEvents();
    expect(aOutcome).toBe('applied');
    expect(a.vault.contents.get(NOTE)).toBe(MERGED);

    // B pulls A's concurrent revision → the same merged result.
    b.setRemote(REV_A, update(LOCAL_A));
    const bOutcome = await b.adapter.applyRemote(b.remoteEvent(REV_A, FILE_A));
    await b.drainEvents();
    expect(bOutcome).toBe('applied');
    expect(b.vault.contents.get(NOTE)).toBe(MERGED);

    // The merged revision each device pushes round-trips to the peer and
    // converges as a no-op (content already equal), never a conflict, never a
    // ping-pong.
    a.setRemote(REV_BMERGE, update(MERGED));
    const aConverge = await a.adapter.applyRemote(a.remoteEvent(REV_BMERGE, FILE_A));
    await a.drainEvents();
    b.setRemote(REV_AMERGE, update(MERGED));
    const bConverge = await b.adapter.applyRemote(b.remoteEvent(REV_AMERGE, FILE_A));
    await b.drainEvents();

    expect(aConverge).toBe('noop');
    expect(bConverge).toBe('noop');
    // Both vaults hold the merged content and neither wrote a conflict artifact.
    expect(a.vault.contents.get(NOTE)).toBe(MERGED);
    expect(b.vault.contents.get(NOTE)).toBe(MERGED);
    expect([...a.vault.contents.keys()].some((p) => p.startsWith('Havemind Conflicts/'))).toBe(false);
    expect([...b.vault.contents.keys()].some((p) => p.startsWith('Havemind Conflicts/'))).toBe(false);
  });
});
