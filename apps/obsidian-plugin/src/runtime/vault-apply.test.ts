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

  openBufferStates(fileId: string): readonly OpenBuffer[] {
    return this.buffers.get(fileId) ?? [];
  }

  fileIdAtPath(path: string): string | null {
    return this.owners.get(path) ?? null;
  }

  async writeByPath(path: string, text: string): Promise<void> {
    this.writes.push({ path, content: text });
  }

  async deleteByPath(path: string): Promise<void> {
    this.deletes.push(path);
  }

  async writeConflictArtifact(path: string, text: string): Promise<void> {
    this.conflicts.push({ path, content: text });
  }
}

function build(
  decoded: (event: RemoteEvent) => DecodedRevisionPayload,
): { adapter: VaultApplyAdapter; files: FakeFiles } {
  const files = new FakeFiles();
  const adapter = new VaultApplyAdapter({
    files,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (remote) => decoded(remote),
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

  it('records a conflict artifact for a divergent open buffer', async () => {
    const { adapter, files } = build(() => content('Notes/a.md', 'D\n'));
    await adapter.recordConflict(event('rev-9', 'file-9'));
    expect(files.writes).toEqual([]);
    expect(files.conflicts).toEqual([
      { path: 'Havemind Conflicts/file-9-rev-9.md', content: 'D\n' },
    ]);
  });
});
