import { describe, expect, it } from 'vitest';

import { VaultApplyAdapter, type VaultFilePort } from './vault-apply';
import type { DecodedRevisionPayload } from '@havemind/sync-core';
import type { OpenBuffer, RemoteEvent } from '../sync/sync-runner';

function event(revisionId = 'rev-1', fileId = 'file-1'): RemoteEvent {
  return {
    serverSequence: 3,
    revision: { revisionId, fileId, contentHash: 'hash-1' },
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
): { adapter: VaultApplyAdapter; files: FakeFiles } {
  const files = new FakeFiles();
  const adapter = new VaultApplyAdapter({
    files,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (remote) => decoded(remote),
    hashContent: fakeHash,
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
    });

    await adapter.applyRemote(event('rev-1', 'file-1'));
    expect(files.owners.get('Notes/a.md')).toBe('file-1');

    text = 'A2\n';
    await adapter.applyRemote(event('rev-2', 'file-1'));
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
    it('applies and advances the base when on-disk content equals the base', async () => {
      const { adapter, files } = build(() => content('Notes/a.md', 'REMOTE\n'));
      files.owners.set('Notes/a.md', 'file-1');
      files.onDisk.set('Notes/a.md', 'OLD\n');
      files.baseHashes.set('file-1', await fakeHash('OLD\n'));

      const outcome = await adapter.applyRemote(event('rev-2', 'file-1'));

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
});
