import { describe, expect, it } from 'vitest';

import { reconcileHeads } from './head-reconciliation';
import type { RemoteEvent } from '../sync/sync-runner';

function head(revisionId: string, fileId: string): RemoteEvent {
  return { serverSequence: 1, revision: { revisionId, fileId, contentHash: `h-${revisionId}` } };
}

// P5: every sync cycle took the file lock, walked every open editor and
// re-filtered the whole outbox and event log for EVERY note, though only a
// file with more than one head (or a queued merge) can need reconciling.
describe('reconcileHeads', () => {
  it('leaves a file with one head and nothing queued alone, without locking or reading it', async () => {
    const touched: string[] = [];
    const mappings = [
      { fileId: 'f1', path: 'a.md', collisionKey: 'a.md', contentHash: 'h1' },
      { fileId: 'f2', path: 'b.md', collisionKey: 'b.md', contentHash: 'h2' },
    ];
    await reconcileHeads({
      history: {
        refresh: async () => undefined,
        allHeads: async () => [head('r1', 'f1'), head('r2', 'f2')],
        heads: async (fileId: string) => [head(`r-${fileId}`, fileId)],
      } as never,
      state: { listOutbox: async () => [] } as never,
      producer: {
        listMappings: async () => mappings,
        versionFor: async () => {
          touched.push('versionFor');
          return null;
        },
      } as never,
      files: {
        openBufferStates: async () => {
          touched.push('openBufferStates');
          return [];
        },
      } as never,
      lock: {
        runExclusive: async (_key: string, run: () => Promise<void>) => {
          touched.push('lock');
          await run();
        },
      } as never,
    });

    expect(touched).toEqual([]);
  });
});
