import { describe, expect, it } from 'vitest';

import { VaultApplyAdapter, type VaultFilePort } from './vault-apply';
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

class FakeFiles implements VaultFilePort {
  writes: Array<{ path: string; content: string }> = [];
  deletes: string[] = [];
  conflicts: Array<{ path: string; content: string }> = [];
  buffers = new Map<string, readonly OpenBuffer[]>();
  owners = new Map<string, string>();
  /** Current on-disk content per path (absent → no file on disk). */
  onDisk = new Map<string, string>();
  /** Recorded last-synced base content hash per fileId. */
  baseHashes = new Map<string, string>();

  openBufferStates(fileId: string): readonly OpenBuffer[] {
    return this.buffers.get(fileId) ?? [];
  }

  fileIdAtPath(path: string): string | null {
    return this.owners.get(path) ?? null;
  }

  async readByPath(path: string): Promise<string | null> {
    return this.onDisk.get(path) ?? null;
  }

  async writeByPath(path: string, text: string): Promise<void> {
    this.writes.push({ path, content: text });
    this.onDisk.set(path, text);
  }

  async deleteByPath(path: string): Promise<void> {
    this.deletes.push(path);
    this.onDisk.delete(path);
  }

  async writeConflictArtifact(path: string, text: string): Promise<void> {
    this.conflicts.push({ path, content: text });
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
      { path: 'Havemind Conflicts/file-1-rev-9.md', content: 'C\n' },
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
      { path: 'Havemind Conflicts/file-9-rev-9.md', content: 'D\n' },
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
        { path: 'Havemind Conflicts/file-1-rev-9.md', content: 'OWNER-EDIT\n' },
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
        { path: 'Havemind Conflicts/file-1-RB.md', content: 'HB\n' },
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
        { path: 'Havemind Conflicts/file-a-rev-a.md', content: 'A-EDIT\n' },
      ]);
      // Neither the local content nor the foreign ownership is touched.
      expect(files.onDisk.get('Notes/Shared.md')).toBe('B-EDIT\n');
      expect(files.owners.get('Notes/Shared.md')).toBe('device-b-random');
      expect(files.baseHashes.has('file-a')).toBe(false);
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
        { path: 'Havemind Conflicts/file-1-rev-r.md', content: 'RENAMED\n' },
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
});
