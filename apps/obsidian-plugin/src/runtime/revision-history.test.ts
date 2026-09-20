import { describe, expect, it } from 'vitest';
import { ancestors, commonAncestor, RevisionHistory } from './revision-history';
import type { RemoteEvent } from '../sync/sync-runner';

function node(id: string, parents: string[] = [], sequence = 0): RemoteEvent {
  return { serverSequence: sequence, revision: { revisionId: id, fileId: 'file', contentHash: `hash-${id}`, parentRevisionIds: parents } };
}
function graph(...events: RemoteEvent[]): Map<string, RemoteEvent> {
  return new Map(events.map((event) => [event.revision.revisionId, event]));
}

describe('revision-bound ancestors', () => {
  it('uses the most recent common revision across repeated offline branches', () => {
    const history = graph(node('root'), node('a', ['root']), node('b', ['root']), node('merge', ['a', 'b']),
      node('left', ['merge']), node('left2', ['left']), node('right', ['merge']));
    expect(commonAncestor(history, 'left2', 'right')?.revision.revisionId).toBe('merge');
    expect(ancestors(history, 'left2').has('b')).toBe(true);
  });
  it('fails closed on ambiguous criss-cross ancestry and missing history', () => {
    const history = graph(node('root'), node('a', ['root']), node('b', ['root']),
      node('left', ['a', 'b']), node('right', ['b', 'a']));
    expect(commonAncestor(history, 'left', 'right')).toBeNull();
    expect(commonAncestor(graph(node('left', ['missing']), node('right', ['missing'])), 'left', 'right')).toBeNull();
  });
  it('loads paginated accepted history and includes pending descendants', async () => {
    const pulls: number[] = [];
    const history = new RevisionHistory({
      transport: { pull: async (after) => {
        pulls.push(after);
        return { cursor: 2, events: after === 0 ? [node('root', [], 1)] : after === 1 ? [node('remote', ['root'], 2)] : [] };
      } },
      resolveRevision: async () => ({ operation: 'update', path: 'a.md', previousPath: null, content: 'remote' }),
      state: { listOutbox: async () => [node('pending', ['remote']).revision], getEnvelope: async () => undefined } as never,
    });
    const revisions = await history.graph('file');
    expect(pulls).toEqual([0, 1]);
    expect(ancestors(revisions, 'pending').has('root')).toBe(true);
    expect((await history.heads('file')).map((event) => event.revision.revisionId)).toEqual(['remote']);
    await history.heads('file');
    expect(pulls).toEqual([0, 1]);
    await history.refresh();
    expect(pulls).toEqual([0, 1, 2]);
  });
  it('refreshes for an event arriving after the cycle snapshot', async () => {
    let available = [node('root', [], 1)];
    const history = new RevisionHistory({
      transport: { pull: async (after) => ({ cursor: available.length, events: available.filter((e) => e.serverSequence > after) }) },
      resolveRevision: async () => ({ operation: 'update', path: 'a.md', previousPath: null, content: 'text' }),
      state: { listOutbox: async () => [], getEnvelope: async () => undefined } as never,
    });
    await history.refresh();
    const incoming = node('new', ['root'], 2);
    available = [...available, incoming];
    await history.ensureEvent(incoming);
    expect((await history.heads('file')).map((e) => e.revision.revisionId)).toEqual(['new']);
  });
  it('rejects gaps and incomplete pages rather than inventing an ancestor', async () => {
    for (const events of [[], [node('skipped', [], 2)]]) {
      const history = new RevisionHistory({
        transport: { pull: async () => ({ cursor: 2, events }) },
        resolveRevision: async () => { throw new Error('must not fetch'); },
        state: { listOutbox: async () => [] } as never,
      });
      await expect(history.graph('file')).rejects.toThrow(/history/);
    }
  });
});
