import { describe, expect, it } from 'vitest';
import { hashPlaintext } from '@havemind/protocol';
import { DurableSyncState, type OutboxEnvelope, type PersistedSyncState, type SyncStatePersistPort } from './sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';
import type { ProducerRecovery } from './producer-recovery';

function setup() {
  let raw: unknown = null;
  let failSync = false;
  let failSaveWhen: (value: PersistedSyncState) => boolean = () => false;
  let counter = 0;
  const corrupt: unknown[] = [];
  const payloads = new Map<string, string>();
  const persist: SyncStatePersistPort = {
    load: async () => raw, loadBackup: async () => null,
    preserveCorrupt: async (value) => { corrupt.push(value); },
    save: async (value) => { if (failSync || failSaveWhen(value)) throw new Error('disk full'); raw = structuredClone(value); },
  };
  const state = () => new DurableSyncState({ persist, payloadStore: {
    putPayload: async (id, bytes) => { payloads.set(id, bytes); },
    getPayload: async (id) => payloads.get(id), deletePayload: async (id) => { payloads.delete(id); },
    listPayloadIds: async () => [...payloads.keys()],
  } });
  const producer = (sync: DurableSyncState) => new OutboxLocalChangeRepository({
    identity: { vaultId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003' },
    // Production wiring (A1): the producer lives inside the sync state document.
    recovery: sync, store: { load: () => sync.loadProducer(), save: (value) => sync.saveProducer(value) },
    hasAuthoredRevision: (id) => sync.hasAuthoredRevision(id),
    generateRevisionId: () => `00000000-0000-4000-8000-${String(++counter + 100).padStart(12, '0')}`,
  });
  return { state, producer, persist, payloads, corrupt,
    raw: () => raw as PersistedSyncState, setRaw: (value: unknown) => { raw = value; },
    producerState: () => state().loadProducer(),
    setProducer: (sync: DurableSyncState, value: ProducerState) => sync.saveProducer(value),
    failSaveWhen: (predicate: (value: PersistedSyncState) => boolean) => { failSaveWhen = predicate; },
    failSync: (value: boolean) => { failSync = value; },
  };
}
const mapping = { fileId: '00000000-0000-4000-8000-000000000004', path: 'note.md', collisionKey: 'note.md', content: 'base\n', contentHash: 'base-hash' };
const env = (id: string, parents: string[] = []): OutboxEnvelope => ({
  revisionId: id, fileId: '00000000-0000-4000-8000-000000000004', contentHash: 'payload-hash', header: { parentRevisionIds: parents },
  idempotencyKey: id, operationId: id, payloadBase64: btoa(`original bytes ${id}`),
});
const journal = (id: string, retired: string[]): ProducerRecovery => ({
  id, kind: 'resolution', fileIds: ['00000000-0000-4000-8000-000000000004'], discardRevisionIds: retired,
  state: { mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': 'accepted' } },
});

describe('durable producer recovery', () => {
  const createOp = (operationId: string, previousContentHash: string | null = null) => ({
    kind: 'create' as const, fileId: mapping.fileId, path: mapping.path, content: mapping.content,
    contentHash: mapping.contentHash, operationId, observedAt: 1, previousContentHash, previousPath: null, revisionId: null,
  });

  it('a failed single save leaves no queue entry, mapping, owner or base, in memory or on reload', async () => {
    const h = setup(); const state = h.state();
    h.failSync(true);
    await expect(h.producer(state).commitLocalChange({ upsertMapping: mapping, removeFileId: null, operation: createOp('crash') }))
      .rejects.toThrow('disk full');
    for (const view of [state, h.state()]) {
      expect(await view.listOutbox()).toEqual([]);
      expect((await view.loadProducer()).mappings).toEqual([]);
      expect(await view.pendingProducerRecoveries()).toEqual([]);
    }
    expect(h.raw()).toBeNull();
    h.failSync(false);
    expect(await state.hasAuthoredRevision('anything')).toBe(false);
    expect(state.fileIdAtPath(mapping.path)).toBeNull();
    expect(state.baseHashFor(mapping.fileId)).toBeNull();
    expect(state.baseContentFor(mapping.fileId)).toBeNull();
  });

  it('retries a commit whose single save failed without minting a duplicate identity', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    const { content, ...metadata } = mapping;
    h.failSync(true);
    await expect(producer.commitLocalChange({ upsertMapping: metadata, removeFileId: null, operation: createOp('first') }))
      .rejects.toThrow('disk full');
    h.failSync(false);
    await producer.commitLocalChange({ upsertMapping: metadata, removeFileId: null, operation: createOp('retry') });
    const restarted = h.producer(h.state());
    expect(await restarted.listMappings()).toEqual([expect.objectContaining({ fileId: mapping.fileId, contentHash: mapping.contentHash })]);
    expect((await restarted.listMappings())[0]).not.toHaveProperty('content');
    const queue = await h.state().listOutbox();
    expect(queue).toHaveLength(1);
    expect((await h.producerState()).heads[mapping.fileId]).toBe(queue[0]?.revisionId);
    expect(h.raw().pathOwners[mapping.path]).toBe(mapping.fileId);
    expect(h.raw().baseHashes[mapping.fileId]).toBe(mapping.contentHash);
    expect(h.raw().baseContents[mapping.fileId]).toBe(content);
    expect(await h.state().pendingProducerRecoveries()).toEqual([]);
  });

  it('stages replacement, originals and mapping intent atomically, then replays after restart', async () => {
    const h = setup(); const state = h.state();
    await state.enqueue(env('old'));
    await h.setProducer(state, { mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': 'old' } });
    expect(await state.startProducerRecovery(journal('repair', ['old']), env('new', ['accepted']))).toBe(true);
    const reopened = h.state(); await h.producer(reopened).recover();
    expect((await h.producerState()).heads['00000000-0000-4000-8000-000000000004']).toBe('accepted');
    expect((await reopened.listOutbox()).map((e) => e.revisionId)).toEqual(['new']);
    expect(await reopened.isLocallyAuthored('old')).toBe(false);
    expect(h.raw().reconciliationBackups?.repair?.[0]?.payloadBase64).toBe(env('old').payloadBase64);
    expect(await reopened.pendingProducerRecoveries()).toEqual([]);
    // The backup keeps the bytes inline, so the stored copy is swept (S1).
    expect(h.payloads.has('old')).toBe(false);
  });

  it('failed staging leaves the original queue and bytes intact in memory and on reload', async () => {
    const h = setup(); const state = h.state(); await state.enqueue(env('old'));
    h.failSync(true);
    await expect(state.startProducerRecovery(journal('repair', ['old']), env('new'))).rejects.toThrow('disk full');
    expect((await state.listOutbox()).map((e) => e.revisionId)).toEqual(['old']);
    h.failSync(false);
    expect((await h.state().listOutbox()).map((e) => e.revisionId)).toEqual(['old']);
  });

  it('retains intent when the recovery write fails and retries without clobbering another file', async () => {
    const h = setup(); const state = h.state(); await state.enqueue(env('old'));
    await state.startProducerRecovery(journal('repair', ['old']), env('new'));
    const other = { ...mapping, fileId: 'other', path: 'other.md', collisionKey: 'other.md' };
    await h.setProducer(state, { mappings: [other], heads: { other: 'other-head' } });
    h.failSync(true);
    await expect(h.producer(state).recover()).rejects.toThrow('disk full');
    expect(await state.pendingProducerRecoveries()).toHaveLength(1);
    expect((await h.state().loadProducer()).heads).toEqual({ other: 'other-head' });
    h.failSync(false); await h.producer(h.state()).recover();
    expect((await h.producerState()).heads).toEqual({ '00000000-0000-4000-8000-000000000004': 'accepted', other: 'other-head' });
    expect(h.raw().reconciliationBackups?.repair).toHaveLength(1);
  });

  it('finishes a legacy resolution record in one write: producer, owner and base present, journal empty', async () => {
    const h = setup(); await h.state().saveCursor(0);
    h.setRaw({ ...h.raw(), producerRecovery: [journal('legacy', [])] });
    let saves = 0;
    h.failSaveWhen(() => { saves += 1; return false; });
    await h.producer(h.state()).recover();
    expect(saves).toBe(1);
    const { content, ...metadata } = mapping;
    const done = h.raw();
    expect(done.producer?.mappings).toEqual([metadata]);
    expect(done.producer?.heads[mapping.fileId]).toBe('accepted');
    expect(done.pathOwners[mapping.path]).toBe(mapping.fileId);
    expect(done.baseHashes[mapping.fileId]).toBe(mapping.contentHash);
    expect(done.baseContents[mapping.fileId]).toBe(content);
    expect(done.producerRecovery ?? []).toEqual([]);
    expect(await h.state().pendingProducerRecoveries()).toEqual([]);
  });

  it('a failed legacy-record write keeps the record pending and a retry finishes it', async () => {
    const h = setup(); await h.state().saveCursor(0);
    h.setRaw({ ...h.raw(), producerRecovery: [journal('legacy', [])] });
    h.failSync(true);
    await expect(h.producer(h.state()).recover()).rejects.toThrow('disk full');
    expect((await h.state().loadProducer()).mappings).toEqual([]);
    expect(await h.state().pendingProducerRecoveries()).toHaveLength(1);
    h.failSync(false); await h.producer(h.state()).recover();
    expect((await h.producerState()).heads[mapping.fileId]).toBe('accepted');
    expect(await h.state().pendingProducerRecoveries()).toEqual([]);
  });

  it.each(['queued', 'quarantined'])('never orphans a %s child', async (kind) => {
    const h = setup(); const state = h.state();
    await state.enqueue(env('old')); await state.enqueue(env('child', ['old']));
    if (kind === 'quarantined') await state.quarantineOutboxItem('child', 'test');
    expect(await state.startProducerRecovery(journal('repair', ['old']), env('new'))).toBe(false);
    expect((await state.listOutbox()).some((e) => e.revisionId === 'old')).toBe(true);
  });

  it.each([false, true])('rolls back a one-parent auto merge after a failed write (restart=%s)', async (restart) => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    await h.setProducer(state, { mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': '00000000-0000-4000-8000-000000000005' } });
    await state.recordPushReceipt({ revisionId: '00000000-0000-4000-8000-000000000005', serverSequence: 1 });
    const rollback = await producer.checkpointApply('00000000-0000-4000-8000-000000000004', ['note.md']);
    const merged = { ...mapping, content: 'merged\n', contentHash: await hashPlaintext('merged') };
    expect(await producer.commitMergedChange({ mapping: merged, remoteRevisionId: '00000000-0000-4000-8000-000000000006', remoteParentRevisionIds: ['00000000-0000-4000-8000-000000000005'] })).toBe(true);
    const id = (await h.producerState()).heads['00000000-0000-4000-8000-000000000004'] as string;
    expect((await state.listOutbox())[0]?.parentRevisionIds).toEqual(['00000000-0000-4000-8000-000000000006']);
    if (restart) await h.producer(h.state()).recover(); else await rollback();
    expect((await h.producerState()).heads['00000000-0000-4000-8000-000000000004']).toBe('00000000-0000-4000-8000-000000000005');
    expect(await h.state().listOutbox()).toEqual([]);
    expect(Object.values(h.raw().reconciliationBackups ?? {}).flat().map((e) => e.revisionId)).toContain(id);
  });

  it('completes a successful apply without cancelling its queued merge on restart', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    await h.setProducer(state, { mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': '00000000-0000-4000-8000-000000000005' } });
    await state.recordPushReceipt({ revisionId: '00000000-0000-4000-8000-000000000005', serverSequence: 1 });
    const rollback = await producer.checkpointApply('00000000-0000-4000-8000-000000000004', ['note.md']);
    await producer.commitMergedChange({ mapping, remoteRevisionId: '00000000-0000-4000-8000-000000000006', remoteParentRevisionIds: ['00000000-0000-4000-8000-000000000005'] });
    const id = (await h.producerState()).heads['00000000-0000-4000-8000-000000000004'];
    await rollback.complete?.(); await h.producer(h.state()).recover();
    expect((await h.producerState()).heads['00000000-0000-4000-8000-000000000004']).toBe(id);
    expect(await h.state().listOutbox()).toHaveLength(1);
  });

  it('restores shared ownership and merge bases when an interrupted apply is rolled back', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    await h.setProducer(state, { mappings: [mapping], heads: { [mapping.fileId]: 'before' } });
    await state.recordPathOwner(mapping.fileId, mapping.path);
    await state.recordBaseHash(mapping.fileId, 'before-hash');
    await state.recordBaseContent(mapping.fileId, 'before-content');
    await producer.checkpointApply(mapping.fileId, [mapping.path]);
    await state.saveProducer({ mappings: [{ ...mapping, path: 'moved.md', collisionKey: 'moved.md' }], heads: { [mapping.fileId]: 'during' } });
    await state.recordPathOwner(mapping.fileId, 'moved.md');
    await state.recordBaseHash(mapping.fileId, 'not-materialized');
    await state.recordBaseContent(mapping.fileId, 'not-materialized');
    await h.producer(h.state()).recover();
    expect((await h.producerState()).heads[mapping.fileId]).toBe('before');
    expect((await h.producerState()).mappings.map((m) => m.path)).toEqual([mapping.path]);
    expect(h.raw().pathOwners[mapping.path]).toBe(mapping.fileId);
    expect(h.raw().pathOwners['moved.md']).toBeUndefined();
    expect(h.raw().baseHashes[mapping.fileId]).toBe('before-hash');
    expect(h.raw().baseContents[mapping.fileId]).toBe('before-content');
  });

  it.each(['rename', 'delete'] as const)('a failed local %s leaves ownership, base, mapping and queue untouched, and a retry applies it', async (kind) => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    const { content, ...metadata } = mapping;
    await producer.commitLocalChange({ upsertMapping: metadata, removeFileId: null, operation: createOp('seed') });
    const next = { ...mapping, path: 'renamed.md', collisionKey: 'renamed.md', content: 'edited\n', contentHash: 'edited-hash' };
    const { content: nextContent, ...nextMetadata } = next;
    const change = {
      upsertMapping: kind === 'delete' ? null : nextMetadata, removeFileId: kind === 'delete' ? mapping.fileId : null,
      operation: { kind, fileId: mapping.fileId, path: kind === 'delete' ? mapping.path : next.path,
        content: kind === 'delete' ? null : nextContent, contentHash: kind === 'delete' ? null : next.contentHash,
        operationId: 'interrupted', observedAt: 1,
        previousContentHash: mapping.contentHash, previousPath: kind === 'rename' ? mapping.path : null, revisionId: null },
    };
    h.failSync(true);
    await expect(producer.commitLocalChange(change)).rejects.toThrow('disk full');
    h.failSync(false);
    for (const view of [state, h.state()]) {
      expect(await view.listOutbox()).toHaveLength(1);
      expect((await view.loadProducer()).mappings.map((m) => m.path)).toEqual([mapping.path]);
      expect(view.fileIdAtPath(mapping.path)).toBe(mapping.fileId);
      expect(view.baseHashFor(mapping.fileId)).toBe(mapping.contentHash);
    }
    await h.producer(h.state()).commitLocalChange(change);
    expect(h.raw().pathOwners[mapping.path]).toBeUndefined();
    if (kind === 'rename') {
      expect(h.raw().pathOwners[next.path]).toBe(mapping.fileId);
      // A local edit never advances an existing base.
      expect(h.raw().baseHashes[mapping.fileId]).toBe(mapping.contentHash);
      expect(h.raw().baseContents[mapping.fileId]).toBe(content);
    } else {
      expect(h.raw().baseHashes[mapping.fileId]).toBeUndefined();
      expect(h.raw().baseContents[mapping.fileId]).toBeUndefined();
      expect((await h.producerState()).mappings).toEqual([]);
    }
    expect(await h.state().listOutbox()).toHaveLength(2);
  });

  it('fails closed on malformed recovery data without overwriting original state', async () => {
    const h = setup(); await h.state().saveCursor(0);
    const damaged = { ...h.raw(), producerRecovery: [{ id: 'lost-details' }] };
    h.setRaw(damaged);
    await expect(h.state().listOutbox()).rejects.toThrow('Invalid producer recovery');
    expect(h.raw()).toEqual(damaged); expect(h.corrupt).toHaveLength(1);
  });
});
