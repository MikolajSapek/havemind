import { describe, expect, it } from 'vitest';
import { hashPlaintext } from '@havemind/protocol';
import { DurableSyncState, type OutboxEnvelope, type PersistedSyncState, type SyncStatePersistPort } from './sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';
import type { ProducerRecovery } from './producer-recovery';
import { applyLocalMaterialization, forgetLocalMaterialization } from './local-base-lifecycle';

function setup() {
  let raw: unknown = null;
  let producerState: ProducerState = { mappings: [], heads: {} };
  let failSync = false;
  let failSaveWhen: (value: PersistedSyncState) => boolean = () => false;
  let failProducer = false;
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
  } });
  const producer = (sync: DurableSyncState) => new OutboxLocalChangeRepository({
    identity: { vaultId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003' },
    recovery: sync, store: { load: async () => producerState, save: async (value) => {
      if (failProducer) throw new Error('producer save failed'); producerState = structuredClone(value);
    } },
    onLocalMaterialized: (m) => applyLocalMaterialization(sync, m),
    onLocalForgotten: (m) => forgetLocalMaterialization(sync, m),
    enqueue: (e) => sync.enqueue(e), hasAuthoredRevision: (id) => sync.hasAuthoredRevision(id),
    generateRevisionId: () => `00000000-0000-4000-8000-${String(++counter + 100).padStart(12, '0')}`,
  });
  return { state, producer, persist, payloads, corrupt,
    raw: () => raw as PersistedSyncState, setRaw: (value: unknown) => { raw = value; },
    producerState: () => producerState, setProducer: (value: ProducerState) => { producerState = value; },
    failSaveWhen: (predicate: (value: PersistedSyncState) => boolean) => { failSaveWhen = predicate; },
    failSync: (value: boolean) => { failSync = value; }, failProducer: (value: boolean) => { failProducer = value; },
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
  it('stages replacement, originals and mapping intent atomically, then replays after restart', async () => {
    const h = setup(); const state = h.state();
    await state.enqueue(env('old'));
    h.setProducer({ mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': 'old' } });
    expect(await state.startProducerRecovery(journal('repair', ['old']), env('new', ['accepted']))).toBe(true);
    const reopened = h.state(); await h.producer(reopened).recover();
    expect(h.producerState().heads['00000000-0000-4000-8000-000000000004']).toBe('accepted');
    expect((await reopened.listOutbox()).map((e) => e.revisionId)).toEqual(['new']);
    expect(await reopened.isLocallyAuthored('old')).toBe(false);
    expect(h.raw().reconciliationBackups?.repair?.[0]?.payloadBase64).toBe(env('old').payloadBase64);
    expect(await reopened.pendingProducerRecoveries()).toEqual([]);
    expect(h.payloads.get('old')).toBe(env('old').payloadBase64);
  });

  it('failed staging leaves the original queue and bytes intact in memory and on reload', async () => {
    const h = setup(); const state = h.state(); await state.enqueue(env('old'));
    h.failSync(true);
    await expect(state.startProducerRecovery(journal('repair', ['old']), env('new'))).rejects.toThrow('disk full');
    expect((await state.listOutbox()).map((e) => e.revisionId)).toEqual(['old']);
    h.failSync(false);
    expect((await h.state().listOutbox()).map((e) => e.revisionId)).toEqual(['old']);
  });

  it('retains intent when producer save fails and retries without clobbering another file', async () => {
    const h = setup(); const state = h.state(); await state.enqueue(env('old'));
    await state.startProducerRecovery(journal('repair', ['old']), env('new'));
    const other = { ...mapping, fileId: 'other', path: 'other.md', collisionKey: 'other.md' };
    h.setProducer({ mappings: [other], heads: { other: 'other-head' } });
    h.failProducer(true);
    await expect(h.producer(state).recover()).rejects.toThrow('producer save failed');
    expect(await state.pendingProducerRecoveries()).toHaveLength(1);
    h.failProducer(false); await h.producer(h.state()).recover();
    expect(h.producerState().heads).toEqual({ '00000000-0000-4000-8000-000000000004': 'accepted', other: 'other-head' });
    expect(h.raw().reconciliationBackups?.repair).toHaveLength(1);
  });

  it('replays after mapping save but before clearing the journal', async () => {
    const h = setup(); const state = h.state();
    await state.startProducerRecovery(journal('repair', []));
    h.failSaveWhen((value) => value.producerRecovery?.length === 0);
    await expect(h.producer(state).recover()).rejects.toThrow('disk full');
    expect(h.producerState().heads['00000000-0000-4000-8000-000000000004']).toBe('accepted');
    h.failSaveWhen(() => false); const reopened = h.state(); await h.producer(reopened).recover();
    expect(await reopened.pendingProducerRecoveries()).toEqual([]);
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
    h.setProducer({ mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': '00000000-0000-4000-8000-000000000005' } });
    await state.recordPushReceipt({ revisionId: '00000000-0000-4000-8000-000000000005', serverSequence: 1 });
    const rollback = await producer.checkpointApply('00000000-0000-4000-8000-000000000004', ['note.md']);
    const merged = { ...mapping, content: 'merged\n', contentHash: await hashPlaintext('merged') };
    expect(await producer.commitMergedChange({ mapping: merged, remoteRevisionId: '00000000-0000-4000-8000-000000000006', remoteParentRevisionIds: ['00000000-0000-4000-8000-000000000005'] })).toBe(true);
    const id = h.producerState().heads['00000000-0000-4000-8000-000000000004'] as string;
    expect((await state.listOutbox())[0]?.parentRevisionIds).toEqual(['00000000-0000-4000-8000-000000000006']);
    if (restart) await h.producer(h.state()).recover(); else await rollback();
    expect(h.producerState().heads['00000000-0000-4000-8000-000000000004']).toBe('00000000-0000-4000-8000-000000000005');
    expect(await h.state().listOutbox()).toEqual([]);
    expect(Object.values(h.raw().reconciliationBackups ?? {}).flat().map((e) => e.revisionId)).toContain(id);
  });

  it('completes a successful apply without cancelling its queued merge on restart', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    h.setProducer({ mappings: [mapping], heads: { '00000000-0000-4000-8000-000000000004': '00000000-0000-4000-8000-000000000005' } });
    await state.recordPushReceipt({ revisionId: '00000000-0000-4000-8000-000000000005', serverSequence: 1 });
    const rollback = await producer.checkpointApply('00000000-0000-4000-8000-000000000004', ['note.md']);
    await producer.commitMergedChange({ mapping, remoteRevisionId: '00000000-0000-4000-8000-000000000006', remoteParentRevisionIds: ['00000000-0000-4000-8000-000000000005'] });
    const id = h.producerState().heads['00000000-0000-4000-8000-000000000004'];
    await rollback.complete?.(); await h.producer(h.state()).recover();
    expect(h.producerState().heads['00000000-0000-4000-8000-000000000004']).toBe(id);
    expect(await h.state().listOutbox()).toHaveLength(1);
  });

  it('restores shared ownership and merge bases when an interrupted apply is rolled back', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    h.setProducer({ mappings: [mapping], heads: { [mapping.fileId]: 'before' } });
    await state.recordPathOwner(mapping.fileId, mapping.path);
    await state.recordBaseHash(mapping.fileId, 'before-hash');
    await state.recordBaseContent(mapping.fileId, 'before-content');
    await producer.checkpointApply(mapping.fileId, [mapping.path]);
    await state.recordBaseHash(mapping.fileId, 'not-materialized');
    await state.recordBaseContent(mapping.fileId, 'not-materialized');
    await h.producer(h.state()).recover();
    expect(h.raw().baseHashes[mapping.fileId]).toBe('before-hash');
    expect(h.raw().baseContents[mapping.fileId]).toBe('before-content');
  });

  it('recovers a queued local create before another scan can mint a duplicate identity', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    h.failProducer(true);
    await expect(producer.commitLocalChange({ upsertMapping: mapping, removeFileId: null, operation: {
      kind: 'create', fileId: mapping.fileId, path: mapping.path, content: mapping.content,
      contentHash: mapping.contentHash, operationId: 'local-create', observedAt: 1,
      previousContent: null, previousContentHash: null, previousPath: null, revisionId: null,
    } })).rejects.toThrow('producer save failed');
    h.failProducer(false);
    const restarted = h.producer(h.state());
    expect(await restarted.listMappings()).toEqual([mapping]);
    expect(await h.state().listOutbox()).toHaveLength(1);
    expect(h.producerState().heads[mapping.fileId]).toBe((await h.state().listOutbox())[0]?.revisionId);
    expect(h.raw().pathOwners[mapping.path]).toBe(mapping.fileId);
    expect(h.raw().baseContents[mapping.fileId]).toBe(mapping.content);
  });

  it.each(['rename', 'delete'] as const)('replays shared ownership after an interrupted local %s', async (kind) => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    const oldHead = '00000000-0000-4000-8000-000000000005';
    h.setProducer({ mappings: [mapping], heads: { [mapping.fileId]: oldHead } });
    await applyLocalMaterialization(state, { ...mapping, previousPath: null });
    const next = { ...mapping, path: 'renamed.md', collisionKey: 'renamed.md', content: 'edited\n', contentHash: 'edited-hash' };
    h.failProducer(true);
    await expect(producer.commitLocalChange({
      upsertMapping: kind === 'delete' ? null : next, removeFileId: kind === 'delete' ? mapping.fileId : null,
      operation: { kind, fileId: mapping.fileId, path: kind === 'delete' ? mapping.path : next.path,
        content: kind === 'delete' ? null : next.content, contentHash: kind === 'delete' ? null : next.contentHash,
        operationId: 'interrupted', observedAt: 1, previousContent: mapping.content,
        previousContentHash: mapping.contentHash, previousPath: kind === 'rename' ? mapping.path : null, revisionId: null },
    })).rejects.toThrow('producer save failed');
    h.failProducer(false);
    await h.producer(h.state()).recover();
    expect(h.raw().pathOwners[mapping.path]).toBeUndefined();
    if (kind === 'rename') {
      expect(h.raw().pathOwners[next.path]).toBe(mapping.fileId);
      expect(h.raw().baseHashes[mapping.fileId]).toBe(mapping.contentHash);
      expect(h.raw().baseContents[mapping.fileId]).toBe(mapping.content);
    } else {
      expect(h.raw().baseHashes[mapping.fileId]).toBeUndefined();
      expect(h.raw().baseContents[mapping.fileId]).toBeUndefined();
    }
    expect(await h.state().listOutbox()).toHaveLength(1);
  });

  it('finishes a base-content save interrupted after the base hash was seeded', async () => {
    const h = setup(); const state = h.state(); const producer = h.producer(state);
    h.failSaveWhen((value) => value.baseContents[mapping.fileId] !== undefined);
    await expect(producer.commitLocalChange({ upsertMapping: mapping, removeFileId: null, operation: {
      kind: 'create', fileId: mapping.fileId, path: mapping.path, content: mapping.content,
      contentHash: mapping.contentHash, operationId: 'local-create', observedAt: 1,
      previousContent: null, previousContentHash: null, previousPath: null, revisionId: null,
    } })).rejects.toThrow('disk full');
    h.failSaveWhen(() => false);
    await h.producer(h.state()).recover();
    expect(h.raw().baseContents[mapping.fileId]).toBe(mapping.content);
    expect(await h.state().pendingProducerRecoveries()).toEqual([]);
  });

  it('fails closed on malformed recovery data without overwriting original state', async () => {
    const h = setup(); await h.state().saveCursor(0);
    const damaged = { ...h.raw(), producerRecovery: [{ id: 'lost-details' }] };
    h.setRaw(damaged);
    await expect(h.state().listOutbox()).rejects.toThrow('Invalid producer recovery');
    expect(h.raw()).toEqual(damaged); expect(h.corrupt).toHaveLength(1);
  });
});
