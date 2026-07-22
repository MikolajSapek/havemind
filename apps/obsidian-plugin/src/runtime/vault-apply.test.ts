import { describe, expect, it } from 'vitest';

import { hashBlob } from '@havemind/protocol';

import {
  ParentFolderOccupiedError,
  VaultApplyAdapter,
  type RemoteAppliedEvent,
  type VaultFilePort,
} from './vault-apply';
import type { DecodedRevisionPayload } from '@havemind/sync-core';
import type { OpenBuffer, RemoteEvent } from '../sync/sync-runner';

function event(
  revisionId = 'rev-1',
  fileId = 'file-1',
  parents?: readonly string[],
): RemoteEvent {
  return {
    serverSequence: 3,
    revision: {
      revisionId,
      fileId,
      contentHash: 'hash-1',
      ...(parents === undefined ? {} : { parentRevisionIds: parents }),
    },
  };
}

function content(path: string, text: string): DecodedRevisionPayload {
  return { operation: 'create', path, previousPath: null, content: text };
}

/** Builds a binary (F9) decoded payload carrying raw bytes, never text. */
function binaryContent(
  path: string,
  bytes: Uint8Array,
  operation: DecodedRevisionPayload['operation'] = 'create',
  previousPath: string | null = null,
): DecodedRevisionPayload {
  return {
    operation,
    path,
    previousPath,
    kind: 'binary',
    content: null,
    binaryContent: bytes,
  };
}

class FakeFiles implements VaultFilePort {
  writes: Array<{ path: string; content: string }> = [];
  deletes: string[] = [];
  conflicts: Array<{ path: string; content: string }> = [];
  /** Binary writes recorded by `writeBinaryByPath` (F9). */
  binaryWrites: Array<{ path: string; bytes: Uint8Array }> = [];
  /** Binary conflict artifacts recorded by `writeBinaryConflictArtifact` (F9). */
  binaryConflicts: Array<{ path: string; bytes: Uint8Array }> = [];
  buffers = new Map<string, readonly OpenBuffer[]>();
  owners = new Map<string, string>();
  /** Current on-disk content per path (absent → no file on disk). */
  onDisk = new Map<string, string>();
  /** Current on-disk RAW bytes per path (absent → no binary file on disk, F9). */
  binaryOnDisk = new Map<string, Uint8Array>();
  /** Recorded last-synced base content hash per fileId. */
  baseHashes = new Map<string, string>();
  /** Recorded last-synced base CONTENT per fileId (merge ancestor, MRG-01). */
  baseContents = new Map<string, string>();
  /** revisionId → conflict-artifact path (MRG-02 cascade guard). */
  conflictArtifactPaths = new Map<string, string>();
  /** Every path a conflict artifact has been written to (collision probe). */
  writtenConflictPaths = new Set<string>();
  /** Paths whose write throws ParentFolderOccupiedError (simulated occupancy). */
  parentFolderOccupied = new Set<string>();

  openBufferStates(fileId: string): readonly OpenBuffer[] {
    return this.buffers.get(fileId) ?? [];
  }

  fileIdAtPath(path: string): string | null {
    return this.owners.get(path) ?? null;
  }

  async readByPath(path: string): Promise<string | null> {
    return this.onDisk.get(path) ?? null;
  }

  async readBinaryByPath(path: string): Promise<Uint8Array | null> {
    return this.binaryOnDisk.get(path) ?? null;
  }

  async writeByPath(path: string, text: string): Promise<void> {
    if (this.parentFolderOccupied.has(path)) {
      throw new ParentFolderOccupiedError(path);
    }
    this.writes.push({ path, content: text });
    this.onDisk.set(path, text);
  }

  async writeBinaryByPath(path: string, bytes: Uint8Array): Promise<void> {
    if (this.parentFolderOccupied.has(path)) {
      throw new ParentFolderOccupiedError(path);
    }
    this.binaryWrites.push({ path, bytes });
    this.binaryOnDisk.set(path, bytes);
  }

  async deleteByPath(path: string): Promise<void> {
    this.deletes.push(path);
    this.onDisk.delete(path);
    this.binaryOnDisk.delete(path);
  }

  async writeConflictArtifact(path: string, text: string): Promise<void> {
    this.conflicts.push({ path, content: text });
    this.writtenConflictPaths.add(path);
  }

  async writeBinaryConflictArtifact(path: string, bytes: Uint8Array): Promise<void> {
    this.binaryConflicts.push({ path, bytes });
    this.writtenConflictPaths.add(path);
  }

  baseContentFor(fileId: string): string | null {
    return this.baseContents.get(fileId) ?? null;
  }

  async recordBaseContent(fileId: string, content: string): Promise<void> {
    this.baseContents.set(fileId, content);
  }

  async forgetBaseContent(fileId: string): Promise<void> {
    this.baseContents.delete(fileId);
  }

  async conflictArtifactExists(path: string): Promise<boolean> {
    return this.writtenConflictPaths.has(path);
  }

  conflictArtifactPathFor(revisionId: string): string | null {
    return this.conflictArtifactPaths.get(revisionId) ?? null;
  }

  async recordConflictArtifactPath(revisionId: string, path: string): Promise<void> {
    this.conflictArtifactPaths.set(revisionId, path);
  }

  async recordPathOwner(fileId: string, path: string): Promise<void> {
    this.owners.set(path, fileId);
  }

  async forgetPath(path: string): Promise<void> {
    this.owners.delete(path);
  }

  baseHashFor(fileId: string): string | null {
    return this.baseHashes.get(fileId) ?? null;
  }

  async recordBaseHash(fileId: string, hash: string): Promise<void> {
    this.baseHashes.set(fileId, hash);
  }

  async forgetBaseHash(fileId: string): Promise<void> {
    this.baseHashes.delete(fileId);
  }
}

/** Deterministic, dependency-free digest so base equality is testable. */
async function fakeHash(content: string): Promise<string> {
  return `h:${content}`;
}

function build(
  decoded: (event: RemoteEvent) => DecodedRevisionPayload,
  localHead?: string | null,
): { adapter: VaultApplyAdapter; files: FakeFiles } {
  const files = new FakeFiles();
  const adapter = new VaultApplyAdapter({
    files,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (remote) => decoded(remote),
    hashContent: fakeHash,
    // Deterministic readable-conflict naming (MRG-02): a fixed local-time clock
    // and a resolved author so every conflict-copy path is exactly assertable.
    conflictNaming: {
      now: () => new Date(2026, 6, 22, 21, 56),
      resolveAuthorName: () => 'Windows',
    },
    // When a caller supplies a local head, expose it through the producer-sync
    // bridge so the adapter's causal apply-vs-conflict decision can run.
    ...(localHead === undefined
      ? {}
      : {
          producerSync: {
            onRemoteWrite: async () => undefined,
            onRemoteDelete: async () => undefined,
            localHeadFor: async () => localHead,
          },
        }),
  });
  return { adapter, files };
}

describe('VaultApplyAdapter', () => {
  it('exposes open buffer states from the vault port', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'A\n'));
    files.buffers.set('file-1', [{ baseHash: 'a', currentHash: 'a' }]);
    expect(await adapter.openBuffers('file-1')).toEqual([
      { baseHash: 'a', currentHash: 'a' },
    ]);
  });

  it('creates a remote-only file at the decoded path', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'A\n'));
    await adapter.applyRemote(event());
    expect(files.writes).toEqual([{ path: 'Notes/a.md', content: 'A\n' }]);
    expect(files.conflicts).toEqual([]);
  });

  it('overwrites the same file when it already owns the path', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'B\n'));
    files.owners.set('Notes/a.md', 'file-1');
    await adapter.applyRemote(event('rev-2', 'file-1'));
    expect(files.writes).toEqual([{ path: 'Notes/a.md', content: 'B\n' }]);
    expect(files.conflicts).toEqual([]);
  });

  it('routes a path collision to Havemind Conflicts and never overwrites', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'C\n'));
    files.owners.set('Notes/a.md', 'other-file');
    await adapter.applyRemote(event('rev-9', 'file-1'));
    expect(files.writes).toEqual([]);
    expect(files.conflicts).toEqual([
      { path: 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md', content: 'C\n' },
    ]);
  });

  it('deletes only a file the tombstone actually owns', async () => {
    const { adapter, files } = build(() => ({
      operation: 'delete',
      path: 'Notes/a.md',
      previousPath: null,
      content: null,
    }));
    files.owners.set('Notes/a.md', 'file-1');
    await adapter.applyRemote(event('rev-3', 'file-1'));
    expect(files.deletes).toEqual(['Notes/a.md']);
  });

  it('skips a tombstone whose path is owned by a different file', async () => {
    const { adapter, files } = build(() => ({
      operation: 'delete',
      path: 'Notes/a.md',
      previousPath: null,
      content: null,
    }));
    files.owners.set('Notes/a.md', 'other-file');
    await adapter.applyRemote(event('rev-3', 'file-1'));
    expect(files.deletes).toEqual([]);
  });

  it('materializes a rename by moving the owned previous path', async () => {
    const { adapter, files } = build(() => ({
      operation: 'rename',
      path: 'Notes/b.md',
      previousPath: 'Notes/a.md',
      content: 'A\n',
    }));
    files.owners.set('Notes/a.md', 'file-1');
    await adapter.applyRemote(event('rev-4', 'file-1'));
    expect(files.deletes).toEqual(['Notes/a.md']);
    expect(files.writes).toEqual([{ path: 'Notes/b.md', content: 'A\n' }]);
  });

  it('records ownership on create so the next revision updates in place', async () => {
    let text = 'A\n';
    const files = new FakeFiles();
    const adapter = new VaultApplyAdapter({
      files,
      conflictFolder: 'Havemind Conflicts',
      resolveRevision: async () => content('Notes/a.md', text),
      hashContent: fakeHash,
      // The second revision is a fast-forward built on the first (rev-1), so the
      // in-place update stays a clean apply under the causal decision.
      producerSync: {
        onRemoteWrite: async () => undefined,
        onRemoteDelete: async () => undefined,
        localHeadFor: async () => 'rev-1',
      },
    });

    await adapter.applyRemote(event('rev-1', 'file-1'));
    expect(files.owners.get('Notes/a.md')).toBe('file-1');

    text = 'A2\n';
    await adapter.applyRemote(event('rev-2', 'file-1', ['rev-1']));
    expect(files.writes).toEqual([
      { path: 'Notes/a.md', content: 'A\n' },
      { path: 'Notes/a.md', content: 'A2\n' },
    ]);
    expect(files.conflicts).toEqual([]);
  });

  it('forgets ownership when a file is deleted', async () => {
    const { adapter, files } = build(() => ({
      operation: 'delete',
      path: 'Notes/a.md',
      previousPath: null,
      content: null,
    }));
    files.owners.set('Notes/a.md', 'file-1');
    await adapter.applyRemote(event('rev-3', 'file-1'));
    expect(files.owners.has('Notes/a.md')).toBe(false);
  });

  it('does not record ownership when a collision is diverted to conflicts', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'C\n'));
    files.owners.set('Notes/a.md', 'other-file');
    await adapter.applyRemote(event('rev-9', 'file-1'));
    // The foreign owner is untouched — Havemind never claims the path.
    expect(files.owners.get('Notes/a.md')).toBe('other-file');
  });

  it('records a conflict artifact for a divergent open buffer', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'D\n'));
    await adapter.recordConflict(event('rev-9', 'file-9'));
    expect(files.writes).toEqual([]);
    expect(files.conflicts).toEqual([
      { path: 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md', content: 'D\n' },
    ]);
  });

  describe('on-disk overwrite guard (rule 3)', () => {
    it('applies and advances the base when on-disk content equals the base (causal fast-forward)', async () => {
      // On-disk equals the last synced base (no local divergence) AND the
      // incoming revision descends from this device's head → a clean
      // fast-forward the peer built on our version, so apply in place.
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'), 'head-1');
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'OLD\n');
      files.baseHashes.set('file-1', await fakeHash('OLD\n'));

      const outcome = await adapter.applyRemote(event('rev-2', 'file-1', ['head-1']));

      expect(outcome).toBe('applied');
      expect(files.writes).toEqual([{ path: 'Notes/a.md', content: 'REMOTE\n' }]);
      expect(files.conflicts).toEqual([]);
      expect(files.baseHashes.get('file-1')).toBe(await fakeHash('REMOTE\n'));
    });

    it('never overwrites on-disk content diverged from base: routes to conflict', async () => {
      // The exact blocker: owner and guest both edited a shared file while it was
      // closed. The guest pulls the owner revision — no open buffer — but the
      // on-disk content diverges from the last synced base and differs from the
      // incoming content. It must become a conflict artifact, never a write.
      const { adapter, files } = build(() => content('Notes/a.md', 'OWNER-EDIT\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'GUEST-EDIT\n');
      files.baseHashes.set('file-1', await fakeHash('SHARED-BASE\n'));

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        { path: 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md', content: 'OWNER-EDIT\n' },
      ]);
      // The guest's on-disk edit is untouched.
      expect(files.onDisk.get('Notes/a.md')).toBe('GUEST-EDIT\n');
    });

    it('never overwrites a diverged file with no recorded base', async () => {
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'LOCAL-ONLY-EDIT\n');
      // No base recorded: we cannot prove the local file is clean → conflict.

      const outcome = await adapter.applyRemote(event('rev-3', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toHaveLength(1);
    });

    it('skips a destructive write when on-disk already equals the incoming content', async () => {
      const { adapter, files } = build(() => content('Notes/a.md', 'CONVERGED\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'CONVERGED\n');

      const outcome = await adapter.applyRemote(event('rev-4', 'file-1'));

      expect(outcome).toBe('noop');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([]);
      // The base advances so a later clean revision applies in place.
      expect(files.baseHashes.get('file-1')).toBe(await fakeHash('CONVERGED\n'));
    });

    it('materializes a remote-only file with no on-disk content and seeds the base', async () => {
      const { adapter, files } = build(() => content('Notes/new.md', 'A\n'));

      const outcome = await adapter.applyRemote(event('rev-1', 'file-1'));

      expect(outcome).toBe('applied');
      expect(files.writes).toEqual([{ path: 'Notes/new.md', content: 'A\n' }]);
      expect(files.baseHashes.get('file-1')).toBe(await fakeHash('A\n'));
    });

    it('reports onRemoteApplied for a genuinely applied write, never for noop/conflict', async () => {
      const applied: unknown[] = [];
      const files = new FakeFiles();
      const adapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/a.md', 'REMOTE\n'),
        hashContent: fakeHash,
        onRemoteApplied: (event) => applied.push(event),
      });

      // 1) A clean remote-only create: 'applied' → hook fires.
      await adapter.applyRemote(event('rev-1', 'file-1'));
      expect(applied).toEqual([
        {
          revisionId: 'rev-1',
          fileId: 'file-1',
          path: 'Notes/a.md',
          operation: 'create',
        },
      ]);

      // 2) Converged on-disk content: 'noop' → hook does NOT fire again.
      files.owners.set('Notes/b.md', 'file-2');
      files.onDisk.set('Notes/b.md', 'REMOTE\n');
      const noopAdapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/b.md', 'REMOTE\n'),
        hashContent: fakeHash,
        onRemoteApplied: (event) => applied.push(event),
      });
      const noopOutcome = await noopAdapter.applyRemote(event('rev-2', 'file-2'));
      expect(noopOutcome).toBe('noop');
      expect(applied).toHaveLength(1);

      // 3) A genuine divergence: 'conflict' → hook does NOT fire.
      files.owners.set('Notes/c.md', 'file-3');
      files.onDisk.set('Notes/c.md', 'LOCAL-DIVERGED\n');
      const conflictAdapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/c.md', 'REMOTE\n'),
        hashContent: fakeHash,
        onRemoteApplied: (event) => applied.push(event),
      });
      const conflictOutcome = await conflictAdapter.applyRemote(
        event('rev-3', 'file-3'),
      );
      expect(conflictOutcome).toBe('conflict');
      expect(applied).toHaveLength(1);
    });

    it('reports onRemoteApplied for a delete that actually removed an owned file', async () => {
      const applied: unknown[] = [];
      const files = new FakeFiles();
      const withHook = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => ({
          operation: 'delete',
          path: 'Notes/a.md',
          previousPath: null,
          content: null,
        }),
        hashContent: fakeHash,
        onRemoteApplied: (event) => applied.push(event),
      });

      files.owners.set('Notes/a.md', 'file-1');
      await withHook.applyRemote(event('rev-3', 'file-1'));
      expect(applied).toEqual([
        {
          revisionId: 'rev-3',
          fileId: 'file-1',
          path: 'Notes/a.md',
          operation: 'delete',
        },
      ]);
    });

    it('never reports onRemoteApplied for a skipped tombstone (path owned by another file)', async () => {
      const applied: unknown[] = [];
      const files = new FakeFiles();
      const withHook = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => ({
          operation: 'delete',
          path: 'Notes/a.md',
          previousPath: null,
          content: null,
        }),
        hashContent: fakeHash,
        onRemoteApplied: (event) => applied.push(event),
      });
      files.owners.set('Notes/a.md', 'other-file');

      await withHook.applyRemote(event('rev-3', 'file-1'));

      expect(applied).toEqual([]);
    });

    it('forgets the base hash when a tombstone deletes an owned file', async () => {
      const { adapter, files } = build(() => ({
        operation: 'delete',
        path: 'Notes/a.md',
        previousPath: null,
        content: null,
      }));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'A\n');
      files.baseHashes.set('file-1', await fakeHash('A\n'));

      await adapter.applyRemote(event('rev-3', 'file-1'));

      expect(files.baseHashes.has('file-1')).toBe(false);
    });
  });

  describe('causal apply-vs-conflict for a shared file (rule 3)', () => {
    // The 7b22b61 regression: on-disk equals the base (because the local push
    // seeded the base to the just-authored content), so a concurrent peer edit
    // whose revision does NOT descend from this device's head slipped through
    // the base-equality guard and silently overwrote the local edit. Causality
    // must gate this branch: a fast-forward applies, a concurrent divergence
    // conflicts — never a silent overwrite.

    it('CONCURRENT: a shared-file revision that does not descend from the local head becomes a conflict, never overwriting on-disk', async () => {
      // Both devices converged at H0 (head R0). This device edited P→HA and
      // pushed RA (base seeded to HA, local head → RA). The peer concurrently
      // edited P→HB and pushed RB whose parent is R0 (it never saw RA). On pull,
      // on-disk (HA) equals the base (HA) — but RB does NOT descend from RA, so
      // it is a concurrent divergence and MUST conflict, preserving HA on disk.
      const { adapter, files } = build(() => content('Notes/a.md', 'HB\n'), 'RA');
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'HA\n');
      files.baseHashes.set('file-1', await fakeHash('HA\n'));

      const outcome = await adapter.applyRemote(event('RB', 'file-1', ['R0']));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        { path: 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md', content: 'HB\n' },
      ]);
      // The local edit is never silently overwritten (rule 3).
      expect(files.onDisk.get('Notes/a.md')).toBe('HA\n');
    });

    it('SEQUENTIAL fast-forward: a shared-file revision whose parent is the local head applies in place with no conflict', async () => {
      // This device is at H0 (head R0). The peer built RB directly on R0 (it had
      // our version), so RB is a fast-forward: apply in place, no false conflict.
      const { adapter, files } = build(() => content('Notes/a.md', 'HB\n'), 'R0');
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'H0\n');
      files.baseHashes.set('file-1', await fakeHash('H0\n'));

      const outcome = await adapter.applyRemote(event('RB', 'file-1', ['R0']));

      expect(outcome).toBe('applied');
      expect(files.writes).toEqual([{ path: 'Notes/a.md', content: 'HB\n' }]);
      expect(files.conflicts).toEqual([]);
    });

    it('CONCURRENT with no known local head: fails safe to a conflict, never an overwrite', async () => {
      // Without a resolvable local head the causal decision cannot prove a
      // fast-forward, so a shared file whose on-disk equals the base but differs
      // from the incoming content must fail safe (conflict), never overwrite.
      const { adapter, files } = build(() => content('Notes/a.md', 'HB\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'HA\n');
      files.baseHashes.set('file-1', await fakeHash('HA\n'));

      const outcome = await adapter.applyRemote(event('RB', 'file-1', ['R0']));

      expect(outcome).toBe('conflict');
      expect(files.onDisk.get('Notes/a.md')).toBe('HA\n');
    });
  });

  describe('content-addressed reconciliation on connect (F3)', () => {
    it('adopts the remote fileId when a foreign-owned path holds byte-identical content', async () => {
      // Both devices already held this note and each minted an independent random
      // fileId for it. When the peer's revision arrives, the path is "owned" by a
      // fileId that is not the incoming one, but the on-disk content is identical —
      // it is genuinely the same file, so adopt the remote fileId in place.
      const { adapter, files } = build(() => content('Notes/Shared.md', 'SHARED\n'));
      files.owners.set('Notes/Shared.md', 'device-b-random');
      files.onDisk.set('Notes/Shared.md', 'SHARED\n');

      const outcome = await adapter.applyRemote(event('rev-a', 'file-a'));

      expect(outcome).toBe('noop');
      expect(files.conflicts).toEqual([]);
      expect(files.writes).toEqual([]);
      // The remote fileId is adopted for the path and the shared base is seeded.
      expect(files.owners.get('Notes/Shared.md')).toBe('file-a');
      expect(files.baseHashes.get('file-a')).toBe(await fakeHash('SHARED\n'));
    });

    it('writes a conflict artifact when a foreign-owned path holds diverged content', async () => {
      // Same canonical path, but the local content genuinely differs from the
      // incoming revision — this is the F2 conflict path, never a silent overwrite.
      const { adapter, files } = build(() => content('Notes/Shared.md', 'A-EDIT\n'));
      files.owners.set('Notes/Shared.md', 'device-b-random');
      files.onDisk.set('Notes/Shared.md', 'B-EDIT\n');

      const outcome = await adapter.applyRemote(event('rev-a', 'file-a'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        { path: 'Havemind Conflicts/Shared (conflict Windows 2026-07-22 2156).md', content: 'A-EDIT\n' },
      ]);
      // Neither the local content nor the foreign ownership is touched.
      expect(files.onDisk.get('Notes/Shared.md')).toBe('B-EDIT\n');
      expect(files.owners.get('Notes/Shared.md')).toBe('device-b-random');
      expect(files.baseHashes.has('file-a')).toBe(false);
    });

    it('forgets the superseded local fileId\'s head/base on adopt, leaving no orphan', async () => {
      // Path 'Notes/Shared.md' was previously owned (and pushed) by this
      // device's own random fileId 'file-b-local' with a recorded base. The
      // peer's revision arrives under a DIFFERENT fileId 'file-a' for the same,
      // byte-identical content — the F3 adopt branch. After adopting, exactly
      // one fileId ('file-a') must own the path, and the superseded fileId's
      // apply-side base hash AND producer-side head must both be gone — no
      // orphaned heads[file-b-local]/baseHashes[file-b-local] left behind.
      const producerDeletes: Array<{ fileId: string; path: string }> = [];
      const producerWrites: Array<{ fileId: string; path: string }> = [];
      const files = new FakeFiles();
      files.owners.set('Notes/Shared.md', 'file-b-local');
      files.onDisk.set('Notes/Shared.md', 'SHARED\n');
      files.baseHashes.set('file-b-local', await fakeHash('SHARED\n'));

      const adapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/Shared.md', 'SHARED\n'),
        hashContent: fakeHash,
        producerSync: {
          async onRemoteWrite(input) {
            producerWrites.push({ fileId: input.fileId, path: input.path });
          },
          async onRemoteDelete(input) {
            producerDeletes.push({ fileId: input.fileId, path: input.path });
          },
        },
      });

      const outcome = await adapter.applyRemote(event('rev-a', 'file-a'));

      expect(outcome).toBe('noop');
      // Exactly one fileId owns the path now.
      expect(files.owners.get('Notes/Shared.md')).toBe('file-a');
      expect(files.baseHashes.get('file-a')).toBe(await fakeHash('SHARED\n'));
      // No orphaned base hash left for the superseded fileId.
      expect(files.baseHashes.has('file-b-local')).toBe(false);
      // The superseded fileId's producer mapping/head was forgotten BEFORE the
      // new fileId was adopted (order matters — see the implementation note).
      expect(producerDeletes).toEqual([
        { fileId: 'file-b-local', path: 'Notes/Shared.md' },
      ]);
      expect(producerWrites).toEqual([
        { fileId: 'file-a', path: 'Notes/Shared.md' },
      ]);
    });
  });

  describe('rename divergence guard (rule 3, FIX 3)', () => {
    function rename(
      previousPath: string,
      path: string,
      text: string,
    ): DecodedRevisionPayload {
      return { operation: 'rename', path, previousPath, content: text };
    }

    it('renames in place when the old path matches the recorded base', async () => {
      const { adapter, files } = build(() =>
        rename('Notes/a.md', 'Notes/b.md', 'RENAMED\n'),
      );
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'BASE\n');
      files.baseHashes.set('file-1', await fakeHash('BASE\n'));

      const outcome = await adapter.applyRemote(event('rev-r', 'file-1'));

      expect(outcome).toBe('applied');
      expect(files.deletes).toEqual(['Notes/a.md']);
      expect(files.writes).toEqual([{ path: 'Notes/b.md', content: 'RENAMED\n' }]);
      expect(files.conflicts).toEqual([]);
    });

    it('routes to a conflict and never deletes when the old path diverged from base', async () => {
      // The peer renamed the file; this device edited the OLD path while closed.
      // Deleting it would silently lose that local edit → conflict artifact.
      const { adapter, files } = build(() =>
        rename('Notes/a.md', 'Notes/b.md', 'RENAMED\n'),
      );
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'LOCAL-EDIT\n');
      files.baseHashes.set('file-1', await fakeHash('BASE\n'));

      const outcome = await adapter.applyRemote(event('rev-r', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.deletes).toEqual([]);
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        { path: 'Havemind Conflicts/b (conflict Windows 2026-07-22 2156).md', content: 'RENAMED\n' },
      ]);
      // The local edit at the old path is untouched.
      expect(files.onDisk.get('Notes/a.md')).toBe('LOCAL-EDIT\n');
    });

    it('routes to a conflict when the old path has content but no recorded base', async () => {
      const { adapter, files } = build(() =>
        rename('Notes/a.md', 'Notes/b.md', 'RENAMED\n'),
      );
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'UNPROVEN\n');
      // No base recorded → cannot prove the old path is clean → conflict.

      const outcome = await adapter.applyRemote(event('rev-r', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.deletes).toEqual([]);
      expect(files.onDisk.get('Notes/a.md')).toBe('UNPROVEN\n');
    });
  });

  describe('producer-sync lockstep (re-entrancy guard, FIX 2)', () => {
    function withSync(
      decoded: (event: RemoteEvent) => DecodedRevisionPayload,
    ): {
      adapter: VaultApplyAdapter;
      files: FakeFiles;
      writes: Array<{ fileId: string; path: string; content: string; revisionId: string }>;
      deletes: Array<{ fileId: string; path: string }>;
    } {
      const files = new FakeFiles();
      const writes: Array<{
        fileId: string;
        path: string;
        content: string;
        revisionId: string;
      }> = [];
      const deletes: Array<{ fileId: string; path: string }> = [];
      const adapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async (remote) => decoded(remote),
        hashContent: fakeHash,
        producerSync: {
          async onRemoteWrite(input) {
            writes.push({
              fileId: input.fileId,
              path: input.path,
              content: input.content,
              revisionId: input.revisionId,
            });
          },
          async onRemoteDelete(input) {
            deletes.push({ fileId: input.fileId, path: input.path });
          },
        },
      });
      return { adapter, files, writes, deletes };
    }

    it('adopts the incoming fileId into the producer on an applied create', async () => {
      const { adapter, writes } = withSync(() => content('Notes/new.md', 'A\n'));
      await adapter.applyRemote(event('rev-1', 'remote-file'));
      expect(writes).toEqual([
        {
          fileId: 'remote-file',
          path: 'Notes/new.md',
          content: 'A\n',
          revisionId: 'rev-1',
        },
      ]);
    });

    it('forgets the producer mapping before an applied delete', async () => {
      const { adapter, files, deletes } = withSync(() => ({
        operation: 'delete',
        path: 'Notes/a.md',
        previousPath: null,
        content: null,
      }));
      files.owners.set('Notes/a.md', 'remote-file');
      await adapter.applyRemote(event('rev-3', 'remote-file'));
      expect(deletes).toEqual([{ fileId: 'remote-file', path: 'Notes/a.md' }]);
    });
  });

  describe('binary attachments (F9)', () => {
    it('materializes a binary create byte-identical on disk, including 0x00/0xFF/0x80', async () => {
      const bytes = new Uint8Array([0x00, 0xff, 0x80, 1, 2, 3]);
      const { adapter, files } = build(() =>
        binaryContent('Attachments/img.png', bytes),
      );

      const outcome = await adapter.applyRemote(event('rev-1', 'file-1'));

      expect(outcome).toBe('applied');
      expect(files.binaryWrites).toHaveLength(1);
      expect(files.binaryWrites[0]?.path).toBe('Attachments/img.png');
      // Byte-exact: every byte, including the boundary/high values, round-trips
      // unchanged (never canonicalised — that would corrupt a binary file).
      expect(files.binaryWrites[0]?.bytes).toEqual(bytes);
      expect(files.conflicts).toEqual([]);
      expect(files.writes).toEqual([]);
      // The base is hashed over the RAW bytes via `hashBlob`, never `hashContent`.
      expect(files.baseHashes.get('file-1')).toBe(await hashBlob(bytes));
    });

    it('routes a diverged on-disk binary to a conflict artifact and never overwrites the live file', async () => {
      // The exact binary analogue of the markdown on-disk overwrite guard: the
      // live file's bytes diverged from the last synced base and differ from
      // the incoming bytes too, so both must survive via a conflict artifact.
      const incoming = new Uint8Array([9, 9, 9]);
      const onDiskBytes = new Uint8Array([1, 2, 3]);
      const baseBytes = new Uint8Array([5, 5, 5]);
      const { adapter, files } = build(() =>
        binaryContent('Attachments/img.png', incoming),
      );
      files.owners.set('Attachments/img.png', 'file-1');
      files.binaryOnDisk.set('Attachments/img.png', onDiskBytes);
      files.baseHashes.set('file-1', await hashBlob(baseBytes));

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toEqual([
        { path: 'Havemind Conflicts/img (conflict Windows 2026-07-22 2156).png', bytes: incoming },
      ]);
      // The live, diverged file is never touched.
      expect(files.binaryOnDisk.get('Attachments/img.png')).toEqual(onDiskBytes);
    });

    it('skips a destructive binary write when on-disk bytes already equal the incoming bytes (convergence)', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { adapter, files } = build(() =>
        binaryContent('Attachments/img.png', bytes),
      );
      files.owners.set('Attachments/img.png', 'file-1');
      files.binaryOnDisk.set('Attachments/img.png', new Uint8Array(bytes));

      const outcome = await adapter.applyRemote(event('rev-4', 'file-1'));

      expect(outcome).toBe('noop');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toEqual([]);
      // The base still advances so a later clean revision applies in place.
      expect(files.baseHashes.get('file-1')).toBe(await hashBlob(bytes));
    });
  });

  describe('automatic three-way merge on divergence (MRG-01)', () => {
    /** Seeds a shared markdown base (hash + ancestor content) for `file-1`. */
    async function seedBase(files: FakeFiles, ancestor: string): Promise<void> {
      files.owners.set('Notes/a.md', 'file-1');
      files.baseHashes.set('file-1', await fakeHash(ancestor));
      files.baseContents.set('file-1', ancestor);
    }

    it('merges non-overlapping edits in place, writes no conflict artifact', async () => {
      const ancestor = 'A\nB\nC\nD\nE\n';
      const { adapter, files } = build(() =>
        content('Notes/a.md', 'A\nB\nC\nD\nE1\n'),
      );
      await seedBase(files, ancestor);
      files.onDisk.set('Notes/a.md', 'A1\nB\nC\nD\nE\n');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('applied');
      expect(files.writes).toEqual([
        { path: 'Notes/a.md', content: 'A1\nB\nC\nD\nE1\n' },
      ]);
      expect(files.conflicts).toEqual([]);
      // A successful merge IS a convergence event: the base advances to it.
      expect(files.baseHashes.get('file-1')).toBe(
        await fakeHash('A1\nB\nC\nD\nE1\n'),
      );
      expect(files.baseContents.get('file-1')).toBe('A1\nB\nC\nD\nE1\n');
    });

    it('applies a remote edit over an unchanged local file via merge (local == ancestor)', async () => {
      // On-disk still equals the base but the incoming revision is not a provable
      // fast-forward (no local head). The merge collapses to the remote change
      // since the local side is unchanged — a clean apply, not a conflict.
      const ancestor = 'A\nB\nC\n';
      const { adapter, files } = build(() => content('Notes/a.md', 'A\nB2\nC\n'));
      await seedBase(files, ancestor);
      files.onDisk.set('Notes/a.md', 'A\nB\nC\n');

      const outcome = await adapter.applyRemote(event('RB', 'file-1', ['R0']));

      expect(outcome).toBe('applied');
      expect(files.writes).toEqual([{ path: 'Notes/a.md', content: 'A\nB2\nC\n' }]);
      expect(files.conflicts).toEqual([]);
    });

    it('falls back to a conflict copy when the hunks genuinely overlap', async () => {
      const ancestor = 'A\nB\nC\n';
      const { adapter, files } = build(() => content('Notes/a.md', 'A\nB-theirs\nC\n'));
      await seedBase(files, ancestor);
      files.onDisk.set('Notes/a.md', 'A\nB-mine\nC\n');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        {
          path: 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md',
          content: 'A\nB-theirs\nC\n',
        },
      ]);
      // The local content is never touched (rule 3).
      expect(files.onDisk.get('Notes/a.md')).toBe('A\nB-mine\nC\n');
    });

    it('falls back to a conflict copy when the ancestor content is not locally persisted', async () => {
      // Base HASH is recorded but the base CONTENT is not, so no merge can run.
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'LOCAL\n');
      files.baseHashes.set('file-1', await fakeHash('BASE\n'));

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toHaveLength(1);
    });

    it('never merges a binary divergence, even with a recorded base', async () => {
      const incoming = new Uint8Array([9, 9, 9]);
      const { adapter, files } = build(() =>
        binaryContent('Attachments/img.png', incoming),
      );
      files.owners.set('Attachments/img.png', 'file-1');
      files.binaryOnDisk.set('Attachments/img.png', new Uint8Array([1, 2, 3]));
      files.baseHashes.set('file-1', await hashBlob(new Uint8Array([5, 5, 5])));
      files.baseContents.set('file-1', 'irrelevant');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toEqual([
        {
          path: 'Havemind Conflicts/img (conflict Windows 2026-07-22 2156).png',
          bytes: incoming,
        },
      ]);
    });

    it('falls back to a conflict when the stored ancestor no longer matches the base hash', async () => {
      // Base hash points at one content, but the persisted ancestor is stale —
      // inconsistent state, so no merge is attempted (fail safe).
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'LOCAL\n');
      files.baseHashes.set('file-1', await fakeHash('TRUE-BASE\n'));
      files.baseContents.set('file-1', 'STALE-BASE\n'); // hashes to a different value

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toHaveLength(1);
    });

    it('falls back to a conflict when there is no recorded base hash at all', async () => {
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'LOCAL\n');
      files.baseContents.set('file-1', 'ANCESTOR\n'); // content present, base hash absent

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.conflicts).toHaveLength(1);
    });
  });

  describe('readable conflict filenames and cascade safety (MRG-02)', () => {
    it('reuses the same artifact path when the same revision is re-delivered', async () => {
      const { adapter, files } = build(() => content('Notes/a.md', 'C\n'));
      files.owners.set('Notes/a.md', 'other-file');

      await adapter.applyRemote(event('rev-9', 'file-1'));
      await adapter.applyRemote(event('rev-9', 'file-1'));

      // Two writes, but to the SAME path — no timestamped cascade.
      expect(files.conflicts).toHaveLength(2);
      expect(files.conflicts[0]?.path).toBe(
        'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md',
      );
      expect(files.conflicts[1]?.path).toBe(files.conflicts[0]?.path);
      expect(files.writtenConflictPaths.size).toBe(1);
    });

    it('uses the fallback author label when no resolver is provided', async () => {
      const files = new FakeFiles();
      const adapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/a.md', 'C\n'),
        hashContent: fakeHash,
        conflictNaming: { now: () => new Date(2026, 6, 22, 21, 56) },
      });
      files.owners.set('Notes/a.md', 'other-file');

      await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(files.conflicts[0]?.path).toBe(
        'Havemind Conflicts/a (conflict peer 2026-07-22 2156).md',
      );
    });

    it('appends a counter when two different revisions collide on the same name', async () => {
      const { adapter, files } = build((remote) =>
        content('Notes/a.md', `content-${remote.revision.revisionId}\n`),
      );
      files.owners.set('Notes/a.md', 'other-file');

      await adapter.applyRemote(event('rev-1', 'file-1'));
      await adapter.applyRemote(event('rev-2', 'file-2'));

      expect(files.conflicts[0]?.path).toBe(
        'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md',
      );
      expect(files.conflicts[1]?.path).toBe(
        'Havemind Conflicts/a 2 (conflict Windows 2026-07-22 2156).md',
      );
    });

    it('diverts a markdown create to a conflict copy when a parent folder is occupied', async () => {
      const { adapter, files } = build(() => content('Notatki/Start.md', 'S\n'));
      files.parentFolderOccupied.add('Notatki/Start.md');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([
        {
          path: 'Havemind Conflicts/Start (conflict Windows 2026-07-22 2156).md',
          content: 'S\n',
        },
      ]);
    });

    it('conflicts a binary revision whose on-disk bytes equal the base but is not a causal fast-forward', async () => {
      const incoming = new Uint8Array([9, 9, 9]);
      const baseBytes = new Uint8Array([5, 5, 5]);
      // No local head supplied → causality cannot be proven, so a divergent
      // binary revision fails safe to a conflict copy (never overwrites).
      const { adapter, files } = build(() =>
        binaryContent('Assets/pic.png', incoming),
      );
      files.owners.set('Assets/pic.png', 'file-1');
      files.binaryOnDisk.set('Assets/pic.png', new Uint8Array(baseBytes));
      files.baseHashes.set('file-1', await hashBlob(baseBytes));

      const outcome = await adapter.applyRemote(
        event('rev-9', 'file-1', ['R0']),
      );

      expect(outcome).toBe('conflict');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toHaveLength(1);
    });

    it('adopts a foreign-owned binary path when the on-disk bytes are byte-identical', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { adapter, files } = build(() =>
        binaryContent('Assets/pic.png', bytes),
      );
      files.owners.set('Assets/pic.png', 'device-b-random');
      files.binaryOnDisk.set('Assets/pic.png', new Uint8Array(bytes));

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('noop');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toEqual([]);
      expect(files.owners.get('Assets/pic.png')).toBe('file-1');
    });

    it('conflicts a foreign-owned binary path that holds diverged bytes', async () => {
      const incoming = new Uint8Array([9, 9, 9]);
      const { adapter, files } = build(() =>
        binaryContent('Assets/pic.png', incoming),
      );
      files.owners.set('Assets/pic.png', 'device-b-random');
      files.binaryOnDisk.set('Assets/pic.png', new Uint8Array([1, 2, 3]));

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toHaveLength(1);
      expect(files.owners.get('Assets/pic.png')).toBe('device-b-random');
    });

    it('diverts a binary create to a conflict copy when a parent folder is occupied', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { adapter, files } = build(() =>
        binaryContent('Assets/pic.png', bytes),
      );
      files.parentFolderOccupied.add('Assets/pic.png');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('conflict');
      expect(files.binaryWrites).toEqual([]);
      expect(files.binaryConflicts).toEqual([
        {
          path: 'Havemind Conflicts/pic (conflict Windows 2026-07-22 2156).png',
          bytes,
        },
      ]);
    });
  });

  describe('base-content lifecycle (F3) and convergent merge (F4)', () => {
    it('forgets the base content on a remote delete (no data.json leak)', async () => {
      const { adapter, files } = build(() => ({
        operation: 'delete',
        path: 'Notes/a.md',
        previousPath: null,
        content: null,
      }));
      files.owners.set('Notes/a.md', 'file-1');
      files.baseHashes.set('file-1', await fakeHash('ANCESTOR\n'));
      files.baseContents.set('file-1', 'ANCESTOR\n');

      await adapter.applyRemote(event('rev-3', 'file-1'));

      expect(files.deletes).toEqual(['Notes/a.md']);
      expect(files.baseHashes.has('file-1')).toBe(false);
      expect(files.baseContents.has('file-1')).toBe(false);
    });

    it('forgets the superseded owner base content on F3 adoption', async () => {
      // Two devices independently minted a fileId for the same note. The incoming
      // revision (file-1) is byte-identical to on-disk, so the old owner is
      // superseded — its base hash AND base content must both be forgotten.
      const { adapter, files } = build(() => content('Notes/a.md', 'SAME\n'));
      files.owners.set('Notes/a.md', 'old-file');
      files.onDisk.set('Notes/a.md', 'SAME\n');
      files.baseHashes.set('old-file', await fakeHash('SAME\n'));
      files.baseContents.set('old-file', 'SAME\n');

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('noop');
      expect(files.baseHashes.has('old-file')).toBe(false);
      expect(files.baseContents.has('old-file')).toBe(false);
    });

    it('short-circuits to noop when the merge result equals on-disk (no write, no activity, base advanced)', async () => {
      // Remote revision equals the shared ancestor (no remote change); local has
      // diverged. The three-way merge collapses to the local content == on-disk,
      // so there is nothing to write and nothing to attribute to the peer.
      const ancestor = 'A\nB\nC\n';
      const local = 'A\nB2\nC\n';
      const applied: RemoteAppliedEvent[] = [];
      const files = new FakeFiles();
      const adapter = new VaultApplyAdapter({
        files,
        conflictFolder: 'Havemind Conflicts',
        resolveRevision: async () => content('Notes/a.md', ancestor),
        hashContent: fakeHash,
        onRemoteApplied: (e) => applied.push(e),
      });
      files.owners.set('Notes/a.md', 'file-1');
      files.baseHashes.set('file-1', await fakeHash(ancestor));
      files.baseContents.set('file-1', ancestor);
      files.onDisk.set('Notes/a.md', local);

      const outcome = await adapter.applyRemote(event('rev-9', 'file-1'));

      expect(outcome).toBe('noop');
      expect(files.writes).toEqual([]);
      expect(files.conflicts).toEqual([]);
      expect(applied).toEqual([]);
      // The base still advances to the (already on-disk) merged state.
      expect(files.baseHashes.get('file-1')).toBe(await fakeHash(local));
      expect(files.baseContents.get('file-1')).toBe(local);
      // The on-disk content is untouched.
      expect(files.onDisk.get('Notes/a.md')).toBe(local);
    });
  });
});
