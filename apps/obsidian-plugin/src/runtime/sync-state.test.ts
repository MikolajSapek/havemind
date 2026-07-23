import { beforeEach, describe, expect, it } from 'vitest';

import {
  DurableSyncState,
  FAILED_TO_QUEUE_PREFIX,
  QUARANTINED_ENVELOPE_BUDGET_BYTES,
  failedToQueueRevisionId,
  parseFailedToQueuePath,
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
      // 'AAAA' base64 decodes to 3 bytes — the size that drives push batching.
      { revisionId: 'rev-1', fileId: 'file-1', contentHash: 'hash-1', payloadBytes: 3 },
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

  it('degrades a malformed optional sub-field to its default while preserving core fields (MINOR 8)', async () => {
    const blob = {
      version: 1,
      cursor: 5,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      pathOwners: { 'Notes/A.md': 'file-1' },
      baseHashes: { 'file-1': 'hash-1' },
      // A malformed stash entry (missing required envelope fields) must NOT
      // nuke cursor/pathOwners/baseHashes — it degrades to an empty stash.
      quarantinedEnvelopes: { 'rev-1': { revisionId: 'rev-1' } },
    };
    const recovered = new DurableSyncState({ persist: new MemoryPersist(blob) });
    expect(await recovered.loadCursor()).toBe(5);
    expect(recovered.fileIdAtPath('Notes/A.md')).toBe('file-1');
    expect(recovered.baseHashFor('file-1')).toBe('hash-1');
    // The malformed stash degraded to empty, so its retry finds no envelope.
    expect(await recovered.requeueQuarantined('rev-1')).toBe(false);
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

  it('records, reads and forgets path ownership durably', async () => {
    expect(state.fileIdAtPath('Notes/a.md')).toBeNull();
    await state.recordPathOwner('file-1', 'Notes/a.md');
    expect(state.fileIdAtPath('Notes/a.md')).toBe('file-1');

    const reopened = new DurableSyncState({ persist });
    await reopened.loadCursor(); // warm cache
    expect(reopened.fileIdAtPath('Notes/a.md')).toBe('file-1');

    await reopened.forgetPath('Notes/a.md');
    expect(reopened.fileIdAtPath('Notes/a.md')).toBeNull();
  });

  it('rebinds a path to a new owner on re-record', async () => {
    await state.recordPathOwner('file-1', 'Notes/a.md');
    await state.recordPathOwner('file-2', 'Notes/a.md');
    expect(state.fileIdAtPath('Notes/a.md')).toBe('file-2');
  });

  it('treats a malformed pathOwners map as empty', async () => {
    const corrupt = new MemoryPersist({
      version: 1,
      cursor: 0,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      pathOwners: { 'Notes/a.md': 42 },
    });
    const recovered = new DurableSyncState({ persist: corrupt });
    await recovered.loadCursor();
    expect(recovered.fileIdAtPath('Notes/a.md')).toBeNull();
  });

  it('records, reads and forgets base hashes durably', async () => {
    expect(state.baseHashFor('file-1')).toBeNull();
    await state.recordBaseHash('file-1', 'base-hash-1');
    expect(state.baseHashFor('file-1')).toBe('base-hash-1');

    const reopened = new DurableSyncState({ persist });
    await reopened.loadCursor(); // warm cache
    expect(reopened.baseHashFor('file-1')).toBe('base-hash-1');

    await reopened.forgetBaseHash('file-1');
    expect(reopened.baseHashFor('file-1')).toBeNull();
  });

  it('treats a malformed baseHashes map as empty', async () => {
    const corrupt = new MemoryPersist({
      version: 1,
      cursor: 0,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      pathOwners: {},
      baseHashes: { 'file-1': 42 },
    });
    const recovered = new DurableSyncState({ persist: corrupt });
    await recovered.loadCursor();
    expect(recovered.baseHashFor('file-1')).toBeNull();
  });

  it('quarantines an outbox item durably, removing it from the outbox', async () => {
    await state.enqueue(envelope());
    await state.quarantineOutboxItem('rev-1', 'server-rejected');

    expect(await state.listOutbox()).toEqual([]);
    expect(await state.listQuarantine()).toEqual([
      { revisionId: 'rev-1', fileId: 'file-1', reason: 'server-rejected' },
    ]);

    // The dead-letter record and the emptied outbox both survive a restart.
    const reopened = new DurableSyncState({ persist });
    expect(await reopened.listOutbox()).toEqual([]);
    expect(await reopened.listQuarantine()).toEqual([
      { revisionId: 'rev-1', fileId: 'file-1', reason: 'server-rejected' },
    ]);
  });

  it('deduplicates an envelope re-enqueued with the same revision id', async () => {
    await state.enqueue(envelope());
    await state.enqueue(envelope({ contentHash: 'hash-2', payloadBase64: 'BBBB' }));
    const outbox = await state.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.contentHash).toBe('hash-2');
  });

  describe('send-queue visibility (SND-01)', () => {
    it('stamps and exposes outbox enqueue ages from an injected clock', async () => {
      const clock = new DurableSyncState({ persist, now: () => 5_000 });
      await clock.enqueue(envelope());
      expect(clock.outboxAges()).toEqual([{ revisionId: 'rev-1', enqueuedAt: 5_000 }]);
    });

    it('preserves the enqueue age across a restart', async () => {
      const clock = new DurableSyncState({ persist, now: () => 7_777 });
      await clock.enqueue(envelope());
      const reopened = new DurableSyncState({ persist });
      await reopened.loadCursor(); // warm the cache
      expect(reopened.outboxAges()).toEqual([{ revisionId: 'rev-1', enqueuedAt: 7_777 }]);
    });

    it('stashes the envelope on quarantine and requeues it on retry exactly once', async () => {
      await state.enqueue(envelope());
      await state.quarantineOutboxItem('rev-1', 'server-rejected');
      expect(await state.listOutbox()).toEqual([]);

      await state.requeueQuarantined('rev-1');
      const outbox = await state.listOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.revisionId).toBe('rev-1');
      expect(await state.listQuarantine()).toEqual([]);

      // A second retry is inert — the stash is gone, so no double-enqueue.
      await state.requeueQuarantined('rev-1');
      expect(await state.listOutbox()).toHaveLength(1);
    });

    it('discards a quarantined item permanently', async () => {
      await state.enqueue(envelope());
      await state.quarantineOutboxItem('rev-1', 'server-rejected');

      await state.discardQuarantined('rev-1');
      expect(await state.listQuarantine()).toEqual([]);

      // Retry after discard is a no-op — nothing re-enters the outbox.
      await state.requeueQuarantined('rev-1');
      expect(await state.listOutbox()).toEqual([]);
    });

    it('records a durable failed-to-queue entry surfaced in the quarantine (SND-02)', async () => {
      await state.recordFailedToQueue('Notes/A.md');

      const quarantine = await state.listQuarantine();
      expect(quarantine).toEqual([
        {
          revisionId: 'failed-to-queue:Notes/A.md',
          fileId: 'Notes/A.md',
          reason: 'failed-to-queue',
        },
      ]);
      // Surfaces synchronously to the send-queue panel provider too.
      expect(state.quarantineSnapshot()).toEqual(quarantine);

      // Idempotent per path: a second failure for the same file does not add a
      // duplicate row.
      await state.recordFailedToQueue('Notes/A.md');
      expect(await state.listQuarantine()).toHaveLength(1);

      // Durable across a restart, and discardable via the shared SND-01 path.
      const reopened = new DurableSyncState({ persist });
      expect(await reopened.listQuarantine()).toHaveLength(1);
      await reopened.discardQuarantined('failed-to-queue:Notes/A.md');
      expect(await reopened.listQuarantine()).toEqual([]);
    });

    it('round-trips a synthetic failed-to-queue revisionId (MAJOR 2 routing)', () => {
      const id = failedToQueueRevisionId('Notes/A.md');
      expect(id).toBe(`${FAILED_TO_QUEUE_PREFIX}Notes/A.md`);
      expect(parseFailedToQueuePath(id)).toBe('Notes/A.md');
      // A real (server-rejected) revisionId is not a failed-to-queue synthetic,
      // so the retry router falls through to the normal requeue path.
      expect(parseFailedToQueuePath('rev-1')).toBeNull();
      // The prefix alone (empty path) is not a valid synthetic id.
      expect(parseFailedToQueuePath(FAILED_TO_QUEUE_PREFIX)).toBeNull();
    });

    it('exports a positive stash byte budget default (MAJOR 4)', () => {
      expect(QUARANTINED_ENVELOPE_BUDGET_BYTES).toBeGreaterThan(0);
    });

    it('evicts the oldest stashed envelope over the byte budget while keeping every row (MAJOR 4)', async () => {
      // A small injected budget makes the overflow cheap to trigger. Each
      // payload decodes to 12 bytes (base64 length 16), so two exceed a 20-byte
      // budget and the oldest stash is evicted.
      const bounded = new DurableSyncState({
        persist,
        quarantinedEnvelopeBudgetBytes: 20,
      });
      const big = 'A'.repeat(16);
      await bounded.enqueue(envelope({ revisionId: 'rev-1', payloadBase64: big }));
      await bounded.enqueue(envelope({ revisionId: 'rev-2', payloadBase64: big }));
      await bounded.quarantineOutboxItem('rev-1', 'server-rejected');
      await bounded.quarantineOutboxItem('rev-2', 'server-rejected');

      // Both rows stay visible in the panel — nothing is silently dropped.
      const rows = await bounded.listQuarantine();
      expect(rows.map((r) => r.revisionId).sort()).toEqual(['rev-1', 'rev-2']);

      // The oldest stash was evicted to respect the budget, so its Retry is
      // inert at the state level (no stash) and the caller degrades it to a
      // re-commit from disk (MAJOR 2 path). The newest stash survives, so its
      // Retry still re-enqueues the exact bytes.
      expect(await bounded.requeueQuarantined('rev-1')).toBe(false);
      expect(await bounded.requeueQuarantined('rev-2')).toBe(true);
      // The evicted row remains after its inert retry — visibility is preserved.
      expect(
        (await bounded.listQuarantine()).some((r) => r.revisionId === 'rev-1'),
      ).toBe(true);
    });

    it('keeps every stashed envelope when within the byte budget (MAJOR 4)', async () => {
      await state.enqueue(envelope({ revisionId: 'rev-1', payloadBase64: 'AAAA' }));
      await state.enqueue(envelope({ revisionId: 'rev-2', payloadBase64: 'AAAA' }));
      await state.quarantineOutboxItem('rev-1', 'server-rejected');
      await state.quarantineOutboxItem('rev-2', 'server-rejected');
      // Both stashes survive, so both retries re-enqueue their exact bytes.
      expect(await state.requeueQuarantined('rev-1')).toBe(true);
      expect(await state.requeueQuarantined('rev-2')).toBe(true);
    });

    it('keeps listQuarantine shape unchanged (no envelope leak into the row)', async () => {
      await state.enqueue(envelope());
      await state.quarantineOutboxItem('rev-1', 'server-rejected');
      expect(await state.listQuarantine()).toEqual([
        { revisionId: 'rev-1', fileId: 'file-1', reason: 'server-rejected' },
      ]);
    });

    it('resolves a path back from a fileId owner', async () => {
      await state.recordPathOwner('file-1', 'Notes/A.md');
      expect(state.pathForFileId('file-1')).toBe('Notes/A.md');
      expect(state.pathForFileId('unknown')).toBeNull();
    });
  });
});
