import { describe, expect, it, vi } from 'vitest';
import { ancestors, commonAncestor, RevisionHistory, type RevisionHistoryStore } from './revision-history';
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

// P13: the payload cache kept every payload fetched during a connection,
// attachments included, so memory only ever grew on a phone.
describe('revision payload cache', () => {
  function history(resolve: (event: RemoteEvent) => Promise<unknown>): RevisionHistory {
    return new RevisionHistory({
      transport: { pull: async () => ({ cursor: 0, events: [] }) },
      resolveRevision: resolve as never,
      state: { listOutbox: async () => [], getEnvelope: async () => undefined } as never,
    });
  }

  it('never keeps an attachment payload in memory', async () => {
    let fetches = 0;
    const subject = history(async () => {
      fetches += 1;
      return { kind: 'binary', operation: 'update', path: 'a.pdf', previousPath: null, content: null, binaryContent: new Uint8Array(8) };
    });
    await subject.payload(node('pdf'));
    await subject.payload(node('pdf'));
    expect(fetches).toBe(2);
  });

  it('reads a queued attachment without building a full-size intermediate string', async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const payloadBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1, operation: 'update', kind: 'binary', path: 'a.pdf',
      contentBase64: Buffer.from(bytes).toString('base64'), blobByteHash: 'b'.repeat(64),
    })).toString('base64');
    const subject = new RevisionHistory({
      transport: { pull: async () => ({ cursor: 0, events: [] }) },
      resolveRevision: async () => { throw new Error('a queued payload is read locally'); },
      state: { listOutbox: async () => [], getEnvelope: async () => ({ payloadBase64 }) } as never,
    });
    const atobSpy = vi.spyOn(globalThis, 'atob');

    const payload = await subject.payload(node('queued'));

    const longest = Math.max(...atobSpy.mock.calls.map(([text]) => text.length));
    atobSpy.mockRestore();
    expect(payload.binaryContent).toEqual(bytes);
    expect(longest).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps recent note payloads, within a bound', async () => {
    const fetched: string[] = [];
    const subject = history(async (event) => {
      fetched.push(event.revision.revisionId);
      return { operation: 'update', path: 'a.md', previousPath: null, content: 'text' };
    });
    await subject.payload(node('first'));
    await subject.payload(node('first'));
    expect(fetched).toEqual(['first']);
    for (let index = 0; index < 1_000; index += 1) await subject.payload(node(`n${index}`));
    await subject.payload(node('first'));
    expect(fetched.filter((id) => id === 'first')).toHaveLength(2);
  });
});

// P13: every connection rebuilt the accepted graph by paging the whole event
// log from cursor 0, so start cost grew with every edit ever made.
describe('persisted revision history', () => {
  type Log = { epoch?: string; events: RemoteEvent[] };
  function server(log: Log, pulls: number[]) {
    return { pull: async (after: number) => {
      pulls.push(after);
      if (after > log.events.length) throw new Error('Server returned HTTP 409.');
      return { cursor: log.events.length, ...(log.epoch === undefined ? {} : { epoch: log.epoch }),
        events: log.events.filter((event) => event.serverSequence > after) };
    } };
  }
  function memoryStore(initial: unknown = null) {
    const saves: Array<{ cursor: number; persisted: number }> = [];
    let stored: unknown = initial;
    const store: RevisionHistoryStore = {
      load: async () => stored,
      save: async (history, persisted) => {
        saves.push({ cursor: history.cursor, persisted });
        stored = structuredClone({ epoch: history.epoch, cursor: history.cursor, events: history.events });
      },
    };
    return { store, saves };
  }
  function connect(log: Log, pulls: number[], store: RevisionHistoryStore): RevisionHistory {
    return new RevisionHistory({
      transport: server(log, pulls), store,
      resolveRevision: async () => { throw new Error('must not fetch'); },
      state: { listOutbox: async () => [], getEnvelope: async () => undefined } as never,
    });
  }
  const ids = (events: RemoteEvent[]) => events.map((event) => event.revision.revisionId);

  it('resumes a new connection from the stored cursor instead of 0', async () => {
    const log: Log = { epoch: 'e1', events: [node('root', [], 1), node('a', ['root'], 2), node('b', ['a'], 3)] };
    const memory = memoryStore();
    const firstPulls: number[] = [];
    await connect(log, firstPulls, memory.store).refresh();
    expect(firstPulls).toEqual([0]);
    expect(memory.saves).toEqual([{ cursor: 3, persisted: 0 }]);

    log.events.push(node('c', ['b'], 4));
    const pulls: number[] = [];
    const second = connect(log, pulls, memory.store);
    expect(ids(await second.heads('file'))).toEqual(['c']);
    // One overlapping event anchors the stored history to the server's log.
    expect(pulls).toEqual([2]);
    expect((await second.graph('file')).has('root')).toBe(true);
    expect(memory.saves.at(-1)).toEqual({ cursor: 4, persisted: 3 });
  });

  it('does not save again when nothing new arrived', async () => {
    const log: Log = { events: [node('root', [], 1)] };
    const memory = memoryStore();
    const history = connect(log, [], memory.store);
    await history.refresh();
    await history.refresh();
    expect(memory.saves).toHaveLength(1);
  });

  it('reloads from 0 when a restored server reports a lower cursor', async () => {
    const original = (): Log => ({ events: [node('root', [], 1), node('a', ['root'], 2), node('b', ['a'], 3)] });
    for (const restored of [
      { events: [node('root', [], 1), node('x', ['root'], 2)] },
      { events: [node('root', [], 1)] },
    ]) {
      const memory = memoryStore();
      await connect(original(), [], memory.store).refresh();
      const pulls: number[] = [];
      const history = connect(restored, pulls, memory.store);
      expect(ids(await history.allHeads())).toEqual([ids(restored.events).at(-1)]);
      expect(pulls).toEqual([2, 0]);
      expect(memory.saves.at(-1)).toEqual({ cursor: restored.events.length, persisted: 0 });
    }
  });

  it('reloads from 0 when the server epoch changed or its log was rewritten', async () => {
    const original = [node('root', [], 1), node('a', ['root'], 2)];
    for (const next of [
      { epoch: 'e2', events: [...original, node('b', ['a'], 3)] },
      { epoch: 'e1', events: [node('root', [], 1), node('other', ['root'], 2), node('b2', ['other'], 3)] },
    ]) {
      const memory = memoryStore();
      await connect({ epoch: 'e1', events: original }, [], memory.store).refresh();
      const pulls: number[] = [];
      const history = connect(next, pulls, memory.store);
      expect(ids(await history.allHeads())).toEqual([ids(next.events).at(-1)]);
      expect(pulls).toEqual([1, 0]);
      expect([...(await history.graph('file')).keys()]).toEqual(ids(next.events));
    }
  });

  it('reloads from 0 when the stored history is corrupt', async () => {
    const log: Log = { events: [node('root', [], 1), node('a', ['root'], 2)] };
    for (const corrupt of [
      'not an object',
      { epoch: null, cursor: 2, events: [node('root', [], 1)] },
      { epoch: null, cursor: 2, events: [node('root', [], 1), node('a', ['root'], 3)] },
      { epoch: null, cursor: 5, events: [] },
      { epoch: null, cursor: 1, events: [{ serverSequence: 1, revision: { revisionId: 7 } }] },
    ]) {
      const memory = memoryStore(corrupt);
      const pulls: number[] = [];
      expect(ids(await connect(log, pulls, memory.store).allHeads())).toEqual(['a']);
      expect(pulls).toEqual([0]);
      expect(memory.saves).toEqual([{ cursor: 2, persisted: 0 }]);
    }
    const failing = memoryStore();
    failing.store.load = async () => { throw new Error('IndexedDB unavailable'); };
    const pulls: number[] = [];
    expect(ids(await connect(log, pulls, failing.store).allHeads())).toEqual(['a']);
    expect(pulls).toEqual([0]);
  });

  it('keeps the stored history when the server is unreachable at start', async () => {
    const log: Log = { events: [node('root', [], 1), node('a', ['root'], 2)] };
    const memory = memoryStore();
    await connect(log, [], memory.store).refresh();
    let offline = true;
    const pulls: number[] = [];
    const history = new RevisionHistory({
      transport: { pull: async (after) => {
        pulls.push(after);
        if (offline) throw new Error('offline');
        return server(log, []).pull(after);
      } },
      store: memory.store,
      resolveRevision: async () => { throw new Error('must not fetch'); },
      state: { listOutbox: async () => [], getEnvelope: async () => undefined } as never,
    });
    await expect(history.refresh()).rejects.toThrow('offline');
    offline = false;
    await history.refresh();
    expect(pulls.at(-1)).toBe(1);
    expect(memory.saves).toHaveLength(1);
  });

  it('still syncs when saving the history fails, and rewrites it whole next time', async () => {
    const log: Log = { events: [node('root', [], 1)] };
    const memory = memoryStore();
    const save = memory.store.save;
    memory.store.save = async () => { throw new Error('quota'); };
    const history = connect(log, [], memory.store);
    await history.refresh();
    memory.store.save = save;
    log.events.push(node('a', ['root'], 2));
    await history.refresh();
    expect(memory.saves).toEqual([{ cursor: 2, persisted: 0 }]);
  });
});

describe('RevisionHistory.event', () => {
  it('finds an accepted revision by id, loading the history first', async () => {
    const history = new RevisionHistory({
      transport: { pull: async (after) => ({ cursor: 1, events: after === 0 ? [node('root', [], 1)] : [] }) },
      resolveRevision: async () => ({ operation: 'update', path: 'a.md', previousPath: null, content: 'x' }),
      state: { listOutbox: async () => [], getEnvelope: async () => undefined } as never,
    });
    expect((await history.event('root'))?.revision.revisionId).toBe('root');
    expect(await history.event('missing')).toBeUndefined();
  });
});
