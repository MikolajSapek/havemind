import { describe, expect, it } from 'vitest';
import { hashPlaintext } from '@havemind/protocol';
import { DurableSyncState, type SyncStatePersistPort } from './sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';
import { SyncRunner, type PushItemResult, type PushRevision, type SyncTransport } from '../sync/sync-runner';

const FILE = '00000000-0000-4000-8000-000000000004';
function harness() {
  let raw: unknown = null;
  let producerState: ProducerState = { mappings: [], heads: {} };
  let n = 0;
  const persist: SyncStatePersistPort = {
    load: async () => raw, loadBackup: async () => null, preserveCorrupt: async () => {},
    save: async (v) => { raw = structuredClone(v); },
  };
  const state = new DurableSyncState({ persist });
  const producer = new OutboxLocalChangeRepository({
    identity: { vaultId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003' },
    recovery: state,
    store: { load: async () => producerState, save: async (v) => { producerState = structuredClone(v); } },
    enqueue: (e) => state.enqueue(e), hasAuthoredRevision: (id) => state.hasAuthoredRevision(id),
    quarantinedParents: (id) => state.quarantinedParents(id),
    generateRevisionId: () => `00000000-0000-4000-8000-${String(++n + 100).padStart(12, '0')}`,
  });
  return { state, producer, producerState: () => producerState };
}
async function edit(p: OutboxLocalChangeRepository, kind: 'create' | 'update', text: string) {
  const contentHash = await hashPlaintext(text);
  return p.commitLocalChange({
    removeFileId: null,
    upsertMapping: { fileId: FILE, path: 'n.md', collisionKey: 'n.md', contentHash },
    operation: { kind, fileId: FILE, path: 'n.md', content: text, contentHash, operationId: `op-${text}`,
      observedAt: 1, previousContentHash: null, previousPath: null, revisionId: null },
  });
}

/** Models the server's file-graph rules (revision-repository #assertFileGraphCommittable). */
function fakeServer(opts: { failFirstWith413: boolean }) {
  const committed = new Set<string>();
  let seq = 0;
  let fail = opts.failFirstWith413;
  const transport: SyncTransport = {
    async push(revs: readonly PushRevision[]): Promise<readonly PushItemResult[]> {
      if (fail) { fail = false; throw Object.assign(new Error('Server returned HTTP 413.'), { permanent: true }); }
      return revs.map((r) => {
        const parents = r.parentRevisionIds ?? [];
        if (parents.some((id) => !committed.has(id))) return { revisionId: r.revisionId, outcome: 'rejected', permanent: false, missingParent: true };
        committed.add(r.revisionId);
        return { revisionId: r.revisionId, outcome: 'accepted', receipt: { revisionId: r.revisionId, serverSequence: ++seq } };
      });
    },
    async pull() { return { cursor: 0, events: [] }; },
  };
  return { transport, committed };
}

/**
 * A quarantined revision never reaches the server, so a later edit must not
 * name it as a parent. Before this was fixed the producer head kept pointing
 * at the dead revision: every later edit of the file was refused as
 * missing-parent and quarantined in turn, and the file never synced again.
 */
describe('editing a file after one of its revisions was quarantined', () => {
  it('parents the next edit on the last revision the server can know', async () => {
    const h = harness();
    const server = fakeServer({ failFirstWith413: true });
    const runner = new SyncRunner({ transport: server.transport, state: h.state,
      vault: { openBuffers: async () => [], applyRemote: async () => 'applied', recordConflict: async () => {} },
      scheduler: () => undefined });

    const r1 = await edit(h.producer, 'create', 'v1');
    expect((await runner.trigger()).quarantined).toBe(1);

    const r2 = await edit(h.producer, 'update', 'v2');
    const second = await runner.trigger();

    expect(second.quarantined).toBe(0);
    expect(server.committed.has(r2 as string)).toBe(true);
    expect(server.committed.has(r1 as string)).toBe(false);

    const r3 = await edit(h.producer, 'update', 'v3');
    await runner.trigger();
    expect(server.committed.has(r3 as string)).toBe(true);
    expect((await h.state.listQuarantine()).map((q) => q.revisionId)).toEqual([r1]);
  });

  it('skips a chain of quarantined revisions back to the accepted one', async () => {
    const h = harness();
    const server = fakeServer({ failFirstWith413: false });
    const runner = new SyncRunner({ transport: server.transport, state: h.state,
      vault: { openBuffers: async () => [], applyRemote: async () => 'applied', recordConflict: async () => {} },
      scheduler: () => undefined });
    const accepted = await edit(h.producer, 'create', 'v1');
    await runner.trigger();
    const dead1 = await edit(h.producer, 'update', 'v2');
    await h.state.quarantineOutboxItem(dead1 as string, 'Server returned HTTP 413.');
    const dead2 = await edit(h.producer, 'update', 'v3');
    await h.state.quarantineOutboxItem(dead2 as string, 'missing-parent');

    const next = await edit(h.producer, 'update', 'v4');
    await runner.trigger();

    expect(server.committed.has(accepted as string)).toBe(true);
    expect(server.committed.has(next as string)).toBe(true);
  });
});
