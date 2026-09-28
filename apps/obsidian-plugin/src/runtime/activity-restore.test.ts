import { describe, expect, it } from 'vitest';

import { restoreRevision, type RestoreDeps } from './activity-restore';

function vault(files: Record<string, string>) {
  const writes: Array<{ path: string; content: string; created: boolean }> = [];
  const port: RestoreDeps['vault'] = {
    getAbstractFileByPath: (path) => (path in files ? { path } : null),
    read: async (file) => files[(file as { path: string }).path] ?? '',
    modify: async (file, content) => {
      const path = (file as { path: string }).path;
      files[path] = content;
      writes.push({ path, content, created: false });
    },
    create: async (path, content) => {
      files[path] = content;
      writes.push({ path, content, created: true });
      return { path };
    },
  };
  return { files, writes, port };
}

const old = { fileId: 'f1', path: 'Notes/Old name.md', content: 'the text as it was' };

describe('restoreRevision', () => {
  it('writes the old content into the note at its current path', async () => {
    const v = vault({ 'Notes/New name.md': 'the text now' });
    const result = await restoreRevision(
      { revisionContent: async () => old, currentPath: () => 'Notes/New name.md', vault: v.port },
      'rev-1',
    );
    expect(result).toEqual({ outcome: 'restored', path: 'Notes/New name.md' });
    expect(v.files['Notes/New name.md']).toBe('the text as it was');
  });

  it('recreates a note that was deleted since', async () => {
    const v = vault({});
    const result = await restoreRevision(
      { revisionContent: async () => old, currentPath: () => null, vault: v.port },
      'rev-1',
    );
    expect(result.outcome).toBe('restored');
    expect(v.writes).toEqual([{ path: 'Notes/Old name.md', content: 'the text as it was', created: true }]);
  });

  it('writes nothing when the note already has that content', async () => {
    const v = vault({ 'Notes/Old name.md': 'the text as it was' });
    const result = await restoreRevision(
      { revisionContent: async () => old, currentPath: () => 'Notes/Old name.md', vault: v.port },
      'rev-1',
    );
    expect(result.outcome).toBe('unchanged');
    expect(v.writes).toEqual([]);
  });

  it('reports a version it cannot restore (deleted, attachment, unknown)', async () => {
    const v = vault({});
    const result = await restoreRevision(
      { revisionContent: async () => null, currentPath: () => null, vault: v.port },
      'rev-1',
    );
    expect(result.outcome).toBe('unavailable');
    expect(v.writes).toEqual([]);
  });
});
