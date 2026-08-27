/**
 * Randomized two-device convergence armour for the steady-state sync loop.
 *
 * Sibling to `steady-state-sync.integration.test.ts`: it wires the SAME real
 * stack (VaultChangeObserver + OutboxLocalChangeRepository producer, and
 * VaultApplyAdapter + createVaultFilePort apply side over a shared
 * DurableSyncState) for TWO devices, then drives a deterministic
 * pseudo-random script of create/update/rename/delete across markdown files in
 * sub-folders plus one binary attachment, with batched, interleaved relays in
 * alternating drain order. After a full drain to a fixpoint it asserts the
 * cross-device invariants that isolated unit tests cannot: byte-identical
 * vaults, no spurious conflict artifacts, no dangling producer/base state for
 * deleted files, and fully drained outboxes.
 *
 * DETERMINISM: the script uses a seeded mulberry32 PRNG derived from a fixed
 * SEED constant, never Math.random and never the wall clock, so a failure is
 * reproducible and minimisable. Three seeds are run.
 *
 * CONVERGENCE SOUNDNESS (why the byte-identity invariant is legitimate):
 * Havemind's three-way merge (MRG-01) is a base-snapshot merge whose ancestor
 * is each device's AGREED base, and that base advances ONLY on remote apply /
 * convergence, never on a local push (rule 3, anti-silent-overwrite). So a
 * merge is guaranteed clean only when both edits (a) touch disjoint line
 * regions AND (b) branch from the SAME base-aligned content. A single-sided
 * edit would leave the author's base stale, and a later merge would count the
 * peer's inherited line as a change and spuriously conflict, a property of the
 * base model, not a defect. This script therefore exercises merges ONLY via
 * symmetric edit ROUNDS: each markdown file is partitioned into a device-A line
 * and a device-B line around a stable anchor, and an "edit round" has BOTH
 * devices edit their own line concurrently from the file's current converged,
 * base-aligned content. A completed round realigns both bases to the merged
 * result, so the next round is sound too. Rounds only start on an idle
 * (fully-drained) file. The binary attachment is single-writer (its base never
 * self-advances). Renames and deletes run only from full quiescence and relay
 * to a fixpoint. Under these rules every merge is clean, so ANY conflict
 * artifact is itself a real defect (the conflict-cascade class), which the
 * test asserts against. Genuine overlapping edits legitimately produce conflict
 * copies that leave the main files divergent until a human resolves them
 * (MRG-03); that path's CONTENT validity is covered by the separate
 * forced-overlap test at the end, which does NOT assert main-file byte-identity.
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

const CONFLICT_FOLDER = 'Havemind Conflicts';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). Seeded from a fixed constant, no
// Math.random, no wall clock. Documented per the task brief.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isConflictPath(path: string): boolean {
  return path.startsWith(`${CONFLICT_FOLDER}/`);
}

/** Narrowing helper (the project forbids non-null assertions). */
function required<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

// ---------------------------------------------------------------------------
// In-memory vault backing both the producer's reads and the apply writes, with
// binary-attachment support added on top of the markdown store.
// ---------------------------------------------------------------------------
class InMemoryVault {
  readonly contents = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  onEvent: (kind: 'create' | 'modify' | 'delete', path: string) => void =
    () => undefined;

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.folders.has(path)) {
      const folder = new TFolder();
      folder.path = path;
      return folder;
    }
    if (this.contents.has(path) || this.binaries.has(path)) {
      const file = new TFile();
      file.path = path;
      return file;
    }
    return null;
  }

  async read(file: { path: string }): Promise<string> {
    return this.contents.get(file.path) ?? '';
  }

  async readBinary(file: { path: string }): Promise<Uint8Array> {
    return this.binaries.get(file.path) ?? new Uint8Array(0);
  }

  private assertParentFolderExists(path: string): void {
    const separatorIndex = path.lastIndexOf('/');
    if (separatorIndex === -1) return;
    const parent = path.slice(0, separatorIndex);
    if (!this.folders.has(parent)) {
      throw new Error(`Folder does not exist: ${parent}`);
    }
  }

  async create(path: string, content: string): Promise<void> {
    if (this.contents.has(path)) throw new Error(`File already exists: ${path}`);
    this.assertParentFolderExists(path);
    this.contents.set(path, content);
    this.onEvent('create', path);
  }

  async modify(file: { path: string }, content: string): Promise<void> {
    this.contents.set(file.path, content);
    this.onEvent('modify', file.path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.assertParentFolderExists(path);
    this.binaries.set(path, new Uint8Array(data));
    this.onEvent('create', path);
  }

  async modifyBinary(file: { path: string }, data: ArrayBuffer): Promise<void> {
    this.binaries.set(file.path, new Uint8Array(data));
    this.onEvent('modify', file.path);
  }

  async delete(file: { path: string }): Promise<void> {
    this.contents.delete(file.path);
    this.binaries.delete(file.path);
    this.onEvent('delete', file.path);
  }

  async createFolder(path: string): Promise<void> {
    this.assertParentFolderExists(path);
    this.folders.add(path);
  }

  ensureFolderChain(path: string): void {
    const separatorIndex = path.lastIndexOf('/');
    if (separatorIndex === -1) return;
    const segments = path.slice(0, separatorIndex).split('/');
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      if (!this.folders.has(prefix)) this.folders.add(prefix);
    }
  }

  syncablePaths(): string[] {
    return [...this.contents.keys(), ...this.binaries.keys()];
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

/** A single produced revision on the wire, carrying everything the peer needs. */
interface WireItem {
  readonly revisionId: string;
  readonly fileId: string;
  readonly operation: DecodedRevisionPayload['operation'];
  readonly path: string;
  readonly previousPath: string | null;
  readonly contentKind: 'markdown' | 'binary';
  readonly content: string | null;
}

type DeviceTag = 'A' | 'B';

function makeDevice(tag: DeviceTag) {
  const revPrefix = tag === 'A' ? 'aaaaaaaa' : 'bbbbbbbb';
  const vault = new InMemoryVault();
  const state = new DurableSyncState({ persist: makeMemoryPersist() });

  let producerState: {
    mappings: LocalFileMapping[];
    heads: Record<string, string>;
  } = { mappings: [], heads: {} };

  const localActivity: LocalChangeOperation[] = [];
  const outbox: string[] = [];
  let revisionCounter = 0;
  let opCounter = 0;
  const fileIdQueue: string[] = [];

  const repository = new OutboxLocalChangeRepository({
    identity: { vaultId: VAULT_ID, memberId: MEMBER_ID, deviceId: `${revPrefix.slice(0, 4)}0000-0000-4000-8000-000000000001` },
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
      return `${revPrefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    },
    onLocalMaterialized: (materialization) =>
      applyLocalMaterialization(state, materialization),
    onLocalForgotten: (forget) => forgetLocalMaterialization(state, forget),
  });

  const observer = new VaultChangeObserver({
    clock: () => 1,
    generateFileId: () => fileIdQueue.shift() ?? `${revPrefix}-dead-4000-8000-000000000000`,
    generateOperationId: () => `${tag}-op-${(opCounter += 1)}`,
    repository,
    vault: {
      async listSyncablePaths() {
        return vault.syncablePaths();
      },
      async readText(path) {
        return vault.contents.get(path) ?? '';
      },
      async readBinary(path) {
        return vault.binaries.get(path) ?? new Uint8Array(0);
      },
      async listAllPaths() {
        return vault.syncablePaths();
      },
      async exists(path) {
        return vault.contents.has(path) || vault.binaries.has(path);
      },
    },
  });

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
  const port = createVaultFilePort({ vault: vault as unknown as never, state });
  const adapter = new VaultApplyAdapter({
    files: port,
    conflictFolder: CONFLICT_FOLDER,
    resolveRevision: async (event: RemoteEvent) => {
      const payload = resolved.get(event.revision.revisionId);
      if (payload === undefined) throw new Error('no payload for revision');
      return payload;
    },
    hashContent: realSha256,
    producerSync: createRemoteApplyProducerSync(() => repository),
    conflictNaming: {
      now: () => new Date(2026, 6, 22, 21, 56),
      resolveAuthorName: () => 'Peer',
    },
  });

  async function drainEvents(): Promise<void> {
    // Drain to a true fixpoint: applying a revision fires reflected vault events
    // that the observer chains on its internal tail, and a merge re-push adds a
    // further cascade. A fixed number of passes leaves that cascade partially
    // flushed under heavier microtask scheduling (e.g. the full suite), which
    // would non-deterministically drop a harvested re-push and surface as a
    // spurious late conflict. Loop until awaiting reveals no new observations.
    let previous = -1;
    while (pending.length !== previous) {
      previous = pending.length;
      await Promise.all(pending);
    }
  }

  function remoteEvent(revisionId: string, fileId: string): RemoteEvent {
    // No parentRevisionIds, production pulls do not surface parentage, so the
    // on-disk-vs-base guard is the only overwrite protection (the real regime).
    return {
      serverSequence: 1,
      revision: { revisionId, fileId, contentHash: `ch-${revisionId}` },
    };
  }

  /** New producer revisions since the last harvest, as wire items. */
  function harvestOutbound(fromIndex: number): WireItem[] {
    const items: WireItem[] = [];
    for (let i = fromIndex; i < localActivity.length; i += 1) {
      const op = localActivity[i];
      if (op === undefined || op.revisionId === null) continue;
      items.push({
        revisionId: op.revisionId,
        fileId: op.fileId,
        operation: op.kind,
        path: op.path,
        previousPath: op.previousPath,
        contentKind: op.contentKind ?? 'markdown',
        content: op.content,
      });
    }
    return items;
  }

  return {
    tag,
    vault,
    state,
    adapter,
    observer,
    fileIdQueue,
    drainEvents,
    remoteEvent,
    harvestOutbound,
    activityLength: () => localActivity.length,
    outboxLength: () => outbox.length,
    setRemote: (revisionId: string, payload: DecodedRevisionPayload) =>
      resolved.set(revisionId, payload),
    localHead: (fileId: string): string | undefined => producerState.heads[fileId],
    producerMappings: () => producerState.mappings,
  };
}

type Device = ReturnType<typeof makeDevice>;

// ---------------------------------------------------------------------------
// File model: a device-A line and a device-B line separated by a stable anchor.
// ---------------------------------------------------------------------------
function bodyFor(title: string, aValue: number, bValue: number): string {
  return `# ${title}\nA:${aValue}\n---\nB:${bValue}\n`;
}

interface FileModel {
  fileId: string;
  path: string;
  kind: 'markdown' | 'binary';
  aValue: number;
  bValue: number;
  title: string;
  bytes?: Uint8Array;
}

const MARKDOWN_PATHS = [
  'Root.md',
  'Notatki/Daily.md',
  'Notatki/Ideas.md',
  'Projekty/Havemind/Plan.md',
] as const;
const BINARY_PATH = 'Attachments/pic.png';
const RENAME_ALTS: Record<string, string> = {
  'Notatki/Ideas.md': 'Notatki/Ideas-renamed.md',
  'Projekty/Havemind/Plan.md': 'Projekty/Havemind/Roadmap.md',
};

function runScenario(seed: number, ops: number): { run: () => Promise<void> } {
  const rng = mulberry32(seed);
  const a = makeDevice('A');
  const b = makeDevice('B');

  // The wire: FIFO of produced-but-undelivered revisions per device, and a
  // per-fileId count of everything still in flight (quiescence signal).
  const wire: Record<DeviceTag, WireItem[]> = { A: [], B: [] };
  const inFlight = new Map<string, number>();
  const models = new Map<string, FileModel>(); // keyed by current path
  const modelsByFileId = new Map<string, FileModel>();
  const deleted = new Map<string, { fileId: string; path: string }>();
  // Every path ever created or renamed-to. A path is used at most once over the
  // whole run: no recreate-after-delete and no re-use of a rename target. This
  // keeps fileId ownership unambiguous, so renames and deletes always converge
  // cleanly (a reused path would revive stale ownership and force a conflict).
  const usedPaths = new Set<string>();
  let fileIdCounter = 0;
  let bytesCounter = 0;
  let drainToggle = false;
  // Self-verification coverage so a future refactor cannot make the test pass
  // vacuously (e.g. never actually merging).
  const cov = { creates: 0, rounds: 0, renames: 0, deletes: 0, binaryUpdates: 0, mergeApplies: 0 };

  function bump(fileId: string, delta: number): void {
    inFlight.set(fileId, (inFlight.get(fileId) ?? 0) + delta);
  }
  function anyVaultHas(path: string): boolean {
    return (
      a.vault.contents.has(path) ||
      a.vault.binaries.has(path) ||
      b.vault.contents.has(path) ||
      b.vault.binaries.has(path)
    );
  }
  function existsOnBoth(path: string): boolean {
    const inA = a.vault.contents.has(path) || a.vault.binaries.has(path);
    const inB = b.vault.contents.has(path) || b.vault.binaries.has(path);
    return inA && inB;
  }
  function globallyQuiescent(): boolean {
    return wire.A.length === 0 && wire.B.length === 0;
  }

  function enqueueOutbound(dev: Device, items: WireItem[]): void {
    for (const item of items) {
      wire[dev.tag].push(item);
      bump(item.fileId, 1);
    }
  }

  async function deliverOne(from: Device, to: Device): Promise<void> {
    const item = wire[from.tag].shift();
    if (item === undefined) return;
    const payload: DecodedRevisionPayload =
      item.contentKind === 'binary'
        ? {
            operation: item.operation,
            path: item.path,
            previousPath: item.previousPath,
            kind: 'binary',
            content: null,
            binaryContent: base64ToBytes(item.content ?? ''),
          }
        : {
            operation: item.operation,
            path: item.path,
            previousPath: item.previousPath,
            content: item.content ?? '',
          };
    to.setRemote(item.revisionId, payload);
    const before = to.activityLength();
    const outcome = await to.adapter.applyRemote(to.remoteEvent(item.revisionId, item.fileId));
    await to.drainEvents();
    // A concurrent round's edits both land on a diverged receiver, so an
    // 'applied' update delivery is exactly a successful three-way merge.
    if (outcome === 'applied' && item.operation === 'update') cov.mergeApplies += 1;
    bump(item.fileId, -1);
    // A genuine merge on `to` re-pushes the merged content: capture it so it
    // relays back and both sides converge on identical bytes.
    enqueueOutbound(to, to.harvestOutbound(before));
  }

  async function deliverBatch(from: Device, to: Device, size: number): Promise<void> {
    for (let i = 0; i < size && wire[from.tag].length > 0; i += 1) {
      await deliverOne(from, to);
    }
  }

  async function fullDrain(): Promise<void> {
    for (let guard = 0; guard < 500; guard += 1) {
      if (globallyQuiescent()) break;
      // Alternate direction each pass so ordering is exercised both ways.
      if (drainToggle) {
        await deliverBatch(a, b, wire.A.length);
        await deliverBatch(b, a, wire.B.length);
      } else {
        await deliverBatch(b, a, wire.B.length);
        await deliverBatch(a, b, wire.A.length);
      }
      drainToggle = !drainToggle;
    }
    expect(globallyQuiescent()).toBe(true);
  }

  function creatorOf(path: string): DeviceTag {
    // Deterministic single-creator per path avoids concurrent create-vs-create
    // on the same path (which would legitimately diverge).
    const index = [...MARKDOWN_PATHS, BINARY_PATH].indexOf(path);
    return index % 2 === 0 ? 'A' : 'B';
  }

  async function doCreate(dev: Device, path: string): Promise<void> {
    if (models.has(path) || anyVaultHas(path) || usedPaths.has(path)) return;
    if (creatorOf(path) !== dev.tag) return;
    usedPaths.add(path);
    const fileId = `f0000000-0000-4000-8000-${String((fileIdCounter += 1)).padStart(12, '0')}`;
    const before = dev.activityLength();
    if (path === BINARY_PATH) {
      dev.vault.ensureFolderChain(path);
      dev.fileIdQueue.push(fileId);
      const bytes = new Uint8Array([1, 2, 3, (bytesCounter += 1) & 0xff]);
      await dev.vault.createBinary(path, bytes.buffer);
      await dev.drainEvents();
      const model: FileModel = {
        fileId,
        path,
        kind: 'binary',
        aValue: 0,
        bValue: 0,
        title: 'pic',
        bytes,
      };
      models.set(path, model);
      modelsByFileId.set(fileId, model);
    } else {
      dev.vault.ensureFolderChain(path);
      dev.fileIdQueue.push(fileId);
      const title = path.replace(/\W+/g, '_');
      await dev.vault.create(path, bodyFor(title, 0, 0));
      await dev.drainEvents();
      const model: FileModel = {
        fileId,
        path,
        kind: 'markdown',
        aValue: 0,
        bValue: 0,
        title,
      };
      models.set(path, model);
      modelsByFileId.set(fileId, model);
    }
    deleted.delete(fileId);
    enqueueOutbound(dev, dev.harvestOutbound(before));
    cov.creates += 1;
  }

  /**
   * A markdown "edit round": BOTH devices edit the file concurrently, each in
   * its OWN line region (A the A-line, B the B-line, separated by a stable
   * anchor), branching from the file's current converged content. This is the
   * ONLY sound way to exercise the three-way merge here: the merge ancestor is
   * each device's AGREED base (which, by rule 3, advances only on remote apply /
   * convergence, never on a local push), so edits are only guaranteed disjoint
   * relative to that base when both branch from the SAME aligned base. A
   * completed round realigns both bases to the merged result, so the next round
   * is sound too. A single-sided edit would leave the author's base stale and a
   * later merge would spuriously conflict, that is a base-model property, not a
   * defect, so the script never issues one.
   *
   * Only runs when the file is idle (its previous round fully drained), which is
   * exactly when both devices sit at the same converged, base-aligned content.
   */
  async function doEditRound(model: FileModel): Promise<void> {
    if (model.kind !== 'markdown') return;
    if ((inFlight.get(model.fileId) ?? 0) !== 0) return;
    if (!existsOnBoth(model.path)) return;
    model.aValue += 1;
    model.bValue += 1;
    const aBefore = a.activityLength();
    await a.vault.modify({ path: model.path }, bodyFor(model.title, model.aValue, model.bValue - 1));
    await a.drainEvents();
    enqueueOutbound(a, a.harvestOutbound(aBefore));
    const bBefore = b.activityLength();
    await b.vault.modify({ path: model.path }, bodyFor(model.title, model.aValue - 1, model.bValue));
    await b.drainEvents();
    enqueueOutbound(b, b.harvestOutbound(bBefore));
    cov.rounds += 1;
  }

  /**
   * Binary update, single-writer (the creator) from full quiescence. Binary has
   * no line merge, and the writer's base never advances on its own push, so a
   * second writer would deadlock into a genuine byte conflict. One writer +
   * quiescence keeps binary sync byte-clean (the peer only ever fast-forwards).
   */
  async function doBinaryUpdate(model: FileModel): Promise<void> {
    if (model.kind !== 'binary') return;
    if (!globallyQuiescent() || !existsOnBoth(model.path)) return;
    const dev = model.path === BINARY_PATH ? a : b; // creator of the binary
    const bytes = new Uint8Array([1, 2, 3, (bytesCounter += 1) & 0xff, 10]);
    const before = dev.activityLength();
    await dev.vault.modifyBinary({ path: model.path }, bytes.buffer);
    await dev.drainEvents();
    model.bytes = bytes;
    enqueueOutbound(dev, dev.harvestOutbound(before));
    cov.binaryUpdates += 1;
  }

  async function doRename(dev: Device, model: FileModel): Promise<void> {
    const next = RENAME_ALTS[model.path];
    if (
      next === undefined ||
      models.has(next) ||
      usedPaths.has(next) ||
      model.kind !== 'markdown'
    ) {
      return;
    }
    usedPaths.add(next);
    await fullDrain(); // renames run from a fully quiesced state.
    const prev = model.path;
    const content = dev.vault.contents.get(prev);
    if (content === undefined) return;
    dev.vault.ensureFolderChain(next);
    dev.vault.contents.set(next, content);
    dev.vault.contents.delete(prev);
    // A rename is driven by calling observeRename directly (Obsidian fires a
    // dedicated rename event, not modify+delete), so it bypasses the create/
    // modify/delete `observed()` wrapper that feeds localActivity. Capture the
    // returned op directly and turn it into the wire item.
    const op = await dev.observer.observeRename(prev, next);
    await dev.drainEvents();
    models.delete(prev);
    model.path = next;
    models.set(next, model);
    if (op !== null && op.revisionId !== null) {
      const item: WireItem = {
        revisionId: op.revisionId,
        fileId: op.fileId,
        operation: op.kind,
        path: op.path,
        previousPath: op.previousPath,
        contentKind: op.contentKind ?? 'markdown',
        content: op.content,
      };
      enqueueOutbound(dev, [item]);
      cov.renames += 1;
    }
    // Relay the rename so BOTH vaults (and `models`) reflect the move before the
    // next op, a rename is a quiescent sync point, so draining after is clean.
    await fullDrain();
  }

  async function doDelete(dev: Device, model: FileModel): Promise<void> {
    await fullDrain(); // deletes run from a fully quiesced state.
    const before = dev.activityLength();
    await dev.vault.delete({ path: model.path });
    await dev.drainEvents();
    const produced = dev.harvestOutbound(before);
    enqueueOutbound(dev, produced);
    models.delete(model.path);
    modelsByFileId.delete(model.fileId);
    deleted.set(model.fileId, { fileId: model.fileId, path: model.path });
    cov.deletes += 1;
    // Relay the tombstone so BOTH vaults drop the file before the next op,
    // otherwise a later create/rename on the peer would collide with the stale
    // copy the peer has not yet removed.
    await fullDrain();
  }

  function pickModel(kind: 'markdown' | 'any'): FileModel | undefined {
    // Ground-truth guard: only operate on files that genuinely exist on BOTH
    // vaults, so the script can never drive an edit against a phantom model.
    const candidates = [...models.values()].filter(
      (m) => (kind === 'any' || m.kind === 'markdown') && existsOnBoth(m.path),
    );
    if (candidates.length === 0) return undefined;
    return candidates[Math.floor(rng() * candidates.length)];
  }

  return { run };

  async function run(): Promise<void> {
    let edits = 0;
    let guard = 0;
    while (edits < ops && guard < ops * 40) {
      guard += 1;
      const r = rng();
      // Interleave relays with edits to create concurrency and batching.
      if (!globallyQuiescent() && r < 0.4) {
        const size = 1 + Math.floor(rng() * 5);
        if (drainToggle) await deliverBatch(a, b, size);
        else await deliverBatch(b, a, size);
        drainToggle = !drainToggle;
        continue;
      }

      const dev = rng() < 0.5 ? a : b;
      const action = rng();
      const beforeActivity = a.activityLength() + b.activityLength();

      if (action < 0.35) {
        // create (single deterministic creator per path)
        const path = [...MARKDOWN_PATHS, BINARY_PATH][
          Math.floor(rng() * (MARKDOWN_PATHS.length + 1))
        ] as string;
        await doCreate(dev, path);
      } else if (action < 0.8) {
        // edit: markdown files get a symmetric concurrent round; the binary
        // gets a single-writer update.
        const model = pickModel('any');
        if (model?.kind === 'binary') await doBinaryUpdate(model);
        else if (model !== undefined) await doEditRound(model);
      } else if (action < 0.9) {
        const model = pickModel('markdown');
        if (model !== undefined) await doRename(dev, model);
      } else {
        const model = pickModel('markdown');
        if (model !== undefined) await doDelete(dev, model);
      }

      if (a.activityLength() + b.activityLength() > beforeActivity) edits += 1;
    }

    await fullDrain();

    // -------- Coverage: the script must actually exercise the merge path (and
    // create/round activity), otherwise a future refactor could make it pass
    // vacuously. A concurrent round always makes the second-arriving edit merge.
    expect(cov.creates).toBeGreaterThanOrEqual(2);
    expect(cov.rounds).toBeGreaterThan(0);
    expect(cov.mergeApplies).toBeGreaterThan(0);

    // -------- Invariant (1): both vaults byte-identical for every synced path.
    const pathsA = new Set(a.vault.syncablePaths().filter((p) => !isConflictPath(p)));
    const pathsB = new Set(b.vault.syncablePaths().filter((p) => !isConflictPath(p)));
    expect([...pathsA].sort()).toEqual([...pathsB].sort());
    for (const path of pathsA) {
      if (a.vault.binaries.has(path) || b.vault.binaries.has(path)) {
        const ba = a.vault.binaries.get(path);
        const bb = b.vault.binaries.get(path);
        expect(ba).toBeDefined();
        expect(bb).toBeDefined();
        expect(bytesEqual(ba as Uint8Array, bb as Uint8Array)).toBe(true);
      } else {
        expect(a.vault.contents.get(path)).toBe(b.vault.contents.get(path));
      }
    }

    // -------- Invariant (2), vacuous form: clean region-disjoint concurrency
    // must NEVER produce a conflict artifact (the conflict-cascade guard).
    expect(a.vault.syncablePaths().some(isConflictPath)).toBe(false);
    expect(b.vault.syncablePaths().some(isConflictPath)).toBe(false);

    // -------- Invariant (3): no dangling producer head / base state for a file
    // that was deleted and not recreated, on EITHER device.
    for (const { fileId, path } of deleted.values()) {
      if (modelsByFileId.has(fileId)) continue; // recreated with a fresh id.
      for (const dev of [a, b]) {
        expect(dev.state.baseHashFor(fileId)).toBeNull();
        expect(dev.state.baseContentFor(fileId)).toBeNull();
        expect(dev.state.fileIdAtPath(path)).toBeNull();
        expect(dev.localHead(fileId)).toBeUndefined();
        expect(dev.producerMappings().some((m) => m.fileId === fileId)).toBe(false);
      }
    }

    // -------- Invariant (4): outboxes fully relayed (nothing left in flight).
    expect(wire.A).toHaveLength(0);
    expect(wire.B).toHaveLength(0);
    for (const [, count] of inFlight) expect(count).toBeLessThanOrEqual(0);
  }
}

describe('randomized two-device convergence (integration)', () => {
  for (const seed of [0x5eed_0001, 0x5eed_0002, 0x5eed_0003]) {
    it(`converges byte-identically over 60 randomized ops (seed 0x${seed.toString(16)})`, async () => {
      await runScenario(seed, 60).run();
    });
  }

  it('a genuine overlapping edit yields conflict copies whose content is valid (no invention/loss)', async () => {
    // This scenario deliberately overlaps (both edit the SAME line) so a
    // conflict copy MUST appear. It validates conflict-copy CONTENT, every
    // copy holds a version one side actually produced, and per device the union
    // {main, copy} covers both versions, and does NOT assert byte-identity of
    // the main files, which legitimately differ until a human resolves them.
    const a = makeDevice('A');
    const b = makeDevice('B');
    const PATH = 'Shared.md';
    const FILE = 'f0000000-0000-4000-8000-000000000001';
    const BASE = '# t\nline\nend\n';
    const A_VERSION = '# t\nAAA\nend\n';
    const B_VERSION = '# t\nBBB\nend\n';

    // A authors the base; B adopts it as a create.
    a.fileIdQueue.push(FILE);
    await a.vault.create(PATH, BASE);
    await a.drainEvents();
    const baseRev = required(a.harvestOutbound(0)[0], 'base revision not produced');
    b.setRemote(baseRev.revisionId, {
      operation: 'create',
      path: PATH,
      previousPath: null,
      content: BASE,
    });
    await b.adapter.applyRemote(b.remoteEvent(baseRev.revisionId, FILE));
    await b.drainEvents();
    expect(b.state.baseHashFor(FILE)).toBe(await realSha256(BASE));

    // Concurrent, OVERLAPPING edits to the same line.
    const aBefore = a.activityLength();
    await a.vault.modify({ path: PATH }, A_VERSION);
    await a.drainEvents();
    const aEdit = required(a.harvestOutbound(aBefore)[0], 'A edit not produced');
    const bBefore = b.activityLength();
    await b.vault.modify({ path: PATH }, B_VERSION);
    await b.drainEvents();
    const bEdit = required(b.harvestOutbound(bBefore)[0], 'B edit not produced');

    // Relay each side's edit to the other.
    b.setRemote(aEdit.revisionId, { operation: 'update', path: PATH, previousPath: null, content: aEdit.content ?? '' });
    const bOutcome = await b.adapter.applyRemote(b.remoteEvent(aEdit.revisionId, FILE));
    await b.drainEvents();
    a.setRemote(bEdit.revisionId, { operation: 'update', path: PATH, previousPath: null, content: bEdit.content ?? '' });
    const aOutcome = await a.adapter.applyRemote(a.remoteEvent(bEdit.revisionId, FILE));
    await a.drainEvents();

    expect(aOutcome).toBe('conflict');
    expect(bOutcome).toBe('conflict');

    const versions = new Set([A_VERSION, B_VERSION]);
    for (const dev of [a, b]) {
      const conflictPaths = dev.vault.syncablePaths().filter(isConflictPath);
      expect(conflictPaths).toHaveLength(1);
      const copy = required(
        dev.vault.contents.get(required(conflictPaths[0], 'no conflict path')),
        'conflict copy content missing',
      );
      // Every conflict copy holds a version one side actually produced.
      expect(versions.has(copy)).toBe(true);
      const main = required(dev.vault.contents.get(PATH), 'main content missing');
      // Per device the surviving set {main, copy} is exactly both versions:
      // nothing invented, nothing lost.
      expect(new Set([main, copy])).toEqual(versions);
    }
  });
});
