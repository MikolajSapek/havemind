import { beforeEach, describe, expect, it } from 'vitest';

import {
  DurableSyncState,
  type OutboxEnvelope,
  type SyncStatePersistPort,
} from './sync-state';
import type { RemoteEvent } from '../sync/sync-runner';

class MemoryPersist implements SyncStatePersistPort {
  saved: unknown = null;
  saveCalls = 0;

  constructor(initial: unknown = null) {
    this.saved = initial;
  }

  async load(): Promise<unknown> {
    return this.saved;
  }

  async save(state: unknown): Promise<void> {
    this.saveCalls += 1;
    // Emulate a real persistence layer's JSON round-trip.
    this.saved = JSON.parse(JSON.stringify(state)) as unknown;
  }
}

function envelope(overrides: Partial<OutboxEnvelope> = {}): OutboxEnvelope {
  return {
    operationId: 'op-1',
    revisionId: 'rev-1',
    fileId: 'file-1',
    contentHash: 'hash-1',
    idempotencyKey: 'idem-1',
    header: { revisionId: 'rev-1' },
    payloadBase64: 'AAAA',
    ...overrides,
  };
}

const remoteEvent = (sequence: number, revisionId: string): RemoteEvent => ({
  serverSequence: sequence,
  revision: { revisionId, fileId: 'file-1', contentHash: 'h' },
});

describe('DurableSyncState', () => {
  let persist: MemoryPersist;
  let state: DurableSyncState;

  beforeEach(() => {
    persist = new MemoryPersist();
    state = new DurableSyncState({ persist });
  });

  it('starts empty and defaults the cursor to zero', async () => {
    expect(await state.loadCursor()).toBe(0);
    expect(await state.listOutbox()).toEqual([]);
    expect(await state.isLocallyAuthored('rev-1')).toBe(false);
  });

  it('persists the cursor durably', async () => {
    await state.saveCursor(7);
    expect(await state.loadCursor()).toBe(7);

    const reopened = new DurableSyncState({ persist });
    expect(await reopened.loadCursor()).toBe(7);
  });

  it('enqueues envelopes and returns runner-shaped outbox rows', async () => {
    await state.enqueue(envelope());
    expect(await state.listOutbox()).toEqual([
      { revisionId: 'rev-1', fileId: 'file-1', contentHash: 'hash-1' },
    ]);
    expect(await state.getEnvelope('rev-1')).toEqual({
      header: { revisionId: 'rev-1' },
      idempotencyKey: 'idem-1',
      payloadBase64: 'AAAA',
    });
  });

  it('removes the outbox entry and remembers local authorship on receipt', async () => {
    await state.enqueue(envelope());
    await state.recordPushReceipt({ revisionId: 'rev-1', serverSequence: 5 });

    expect(await state.listOutbox()).toEqual([]);
    expect(await state.isLocallyAuthored('rev-1')).toBe(true);

    const reopened = new DurableSyncState({ persist });
    expect(await reopened.isLocallyAuthored('rev-1')).toBe(true);
  });

  it('stores and reloads deferred remote events', async () => {
    await state.saveDeferred([remoteEvent(3, 'rev-x')]);
    expect(await state.listDeferred()).toEqual([remoteEvent(3, 'rev-x')]);

    const reopened = new DurableSyncState({ persist });
    expect(await reopened.listDeferred()).toEqual([remoteEvent(3, 'rev-x')]);
  });

  it('never trusts a malformed persisted blob and falls back to empty', async () => {
    const corrupt = new MemoryPersist({ version: 99, cursor: 'nope' });
    const recovered = new DurableSyncState({ persist: corrupt });
    expect(await recovered.loadCursor()).toBe(0);
    expect(await recovered.listOutbox()).toEqual([]);
  });

  it.each([
    { version: 1, cursor: 0, outbox: [{ revisionId: 'x' }], locallyAuthored: [], deferred: [] },
    { version: 1, cursor: 0, outbox: [], locallyAuthored: [1], deferred: [] },
    { version: 1, cursor: 0, outbox: [], locallyAuthored: [], deferred: [{ serverSequence: 'x' }] },
    { version: 1, cursor: -1, outbox: [], locallyAuthored: [], deferred: [] },
    { version: 1, cursor: 0, outbox: 'no', locallyAuthored: [], deferred: [] },
  ])('falls back to empty for a structurally invalid blob %#', async (blob) => {
    const recovered = new DurableSyncState({ persist: new MemoryPersist(blob) });
    expect(await recovered.loadCursor()).toBe(0);
    expect(await recovered.listOutbox()).toEqual([]);
    expect(await recovered.listDeferred()).toEqual([]);
  });

  it('rehydrates a full valid blob including outbox and deferred', async () => {
    await state.enqueue(envelope());
    await state.saveDeferred([remoteEvent(2, 'r')]);
    const reopened = new DurableSyncState({ persist });
    expect((await reopened.listOutbox())[0]?.revisionId).toBe('rev-1');
    expect(await reopened.getEnvelope('rev-1')).not.toBeUndefined();
    expect(await reopened.getEnvelope('missing')).toBeUndefined();
    expect((await reopened.listDeferred()).length).toBe(1);
  });

  it('deduplicates an envelope re-enqueued with the same revision id', async () => {
    await state.enqueue(envelope());
    await state.enqueue(envelope({ contentHash: 'hash-2', payloadBase64: 'BBBB' }));
    const outbox = await state.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.contentHash).toBe('hash-2');
  });
});
