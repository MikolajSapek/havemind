import { describe, expect, it } from 'vitest';

import {
  VaultApplyAdapter,
  type VaultFilePort,
} from './vault-apply';
import type { OpenBuffer, RemoteEvent } from '../sync/sync-runner';

function event(revisionId = 'rev-1', fileId = 'file-1'): RemoteEvent {
  return {
    serverSequence: 3,
    revision: { revisionId, fileId, contentHash: 'hash-1' },
  };
}

class FakeFiles implements VaultFilePort {
  writes: Array<{ fileId: string; content: string }> = [];
  conflicts: Array<{ path: string; content: string }> = [];
  buffers = new Map<string, readonly OpenBuffer[]>();

  openBufferStates(fileId: string): readonly OpenBuffer[] {
    return this.buffers.get(fileId) ?? [];
  }

  async writeByFileId(fileId: string, content: string): Promise<void> {
    this.writes.push({ fileId, content });
  }

  async writeConflictArtifact(path: string, content: string): Promise<void> {
    this.conflicts.push({ path, content });
  }
}

function build(): { adapter: VaultApplyAdapter; files: FakeFiles } {
  const files = new FakeFiles();
  const adapter = new VaultApplyAdapter({
    files,
    conflictFolder: 'Havemind Conflicts',
    resolveContent: async (remote) => `content:${remote.revision.revisionId}`,
  });
  return { adapter, files };
}

describe('VaultApplyAdapter', () => {
  it('exposes open buffer states from the vault port', async () => {
    const { adapter, files } = build();
    files.buffers.set('file-1', [{ baseHash: 'a', currentHash: 'a' }]);
    expect(await adapter.openBuffers('file-1')).toEqual([
      { baseHash: 'a', currentHash: 'a' },
    ]);
  });

  it('writes the resolved remote content to the live file on apply', async () => {
    const { adapter, files } = build();
    await adapter.applyRemote(event());
    expect(files.writes).toEqual([{ fileId: 'file-1', content: 'content:rev-1' }]);
    expect(files.conflicts).toEqual([]);
  });

  it('records a conflict artifact and never overwrites the live file', async () => {
    const { adapter, files } = build();
    await adapter.recordConflict(event('rev-9', 'file-9'));
    expect(files.writes).toEqual([]);
    expect(files.conflicts).toEqual([
      { path: 'Havemind Conflicts/file-9-rev-9.md', content: 'content:rev-9' },
    ]);
  });
});
