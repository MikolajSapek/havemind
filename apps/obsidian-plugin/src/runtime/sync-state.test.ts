import { beforeEach, describe, expect, it } from 'vitest';

import {
  DurableSyncState,
  FAILED_TO_QUEUE_PREFIX,
  PAYLOAD_MISSING_REASON,
  QUARANTINED_ENVELOPE_BUDGET_BYTES,
  failedToQueueRevisionId,
  parseFailedToQueuePath,
  type OutboxEnvelope,
  type OutboxPayloadStore,
  type PersistedSyncState,
  type SyncStatePersistPort,
} from './sync-state';
import type { RemoteEvent } from '../sync/sync-runner';

class MemoryPersist implements SyncStatePersistPort {
  saved: unknown = null;
  backup: unknown = null;
  corrupt: Array<{ raw: unknown; timestamp: number }> = [];
  saveCalls = 0;

  constructor(initial: unknown = null) {
    this.saved = initial;
  }

  async load(): Promise<unknown> {
    return this.saved;
  }

  async loadBackup(): Promise<unknown> {
    return this.backup;
  }

  async save(state: unknown): Promise<void> {
    this.saveCalls += 1;
    // Model the port's promote step: the prior primary becomes the single
    // backup, the new state becomes the primary. Emulate a real persistence
    // layer's JSON round-trip.
    this.backup = this.saved;
    this.saved = JSON.parse(JSON.stringify(state)) as unknown;
  }

  async preserveCorrupt(raw: unknown, timestamp: number): Promise<void> {
    this.corrupt.push({
      raw: JSON.parse(JSON.stringify(raw)) as unknown,
      timestamp,
    });
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

  it.each(['equivalent', 'different bytes', 'different parents', 'queued child', 'quarantined child', 'single parent'])('retires only a proven equivalent merge: %s', async (scenario) => {
    await state.enqueue(envelope({
      revisionId: 'local-merge', contentHash: 'merged-hash',
      header: { parentRevisionIds: scenario === 'single parent' ? ['left'] : ['left', 'right'] },
    }));
    if (scenario === 'queued child' || scenario === 'quarantined child') await state.enqueue(envelope({
      revisionId: 'child', header: { parentRevisionIds: ['local-merge'] },
    }));
    if (scenario === 'quarantined child') await state.quarantineOutboxItem('child', 'test');
    await state.retireEquivalentMerges({
      serverSequence: 4,
      revision: {
        revisionId: 'accepted-merge', fileId: 'file-1',
        contentHash: scenario === 'different bytes' ? 'other-hash' : 'merged-hash',
        parentRevisionIds: scenario === 'different parents' ? ['left', 'other'] : ['left', 'right'],
      },
    });
    const reloaded = new DurableSyncState({ persist });
    expect((await reloaded.listOutbox()).some((item) => item.revisionId === 'local-merge'))
      .toBe(scenario !== 'equivalent');
    expect(await reloaded.isLocallyAuthored('local-merge')).toBe(false);
    // The server holds the same text, so a retired merge keeps no inline copy.
    expect((persist.saved as PersistedSyncState).reconciliationBackups?.['accepted-merge']).toBeUndefined();
  });

  describe('reconciliation backups', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 1_800_000_000_000;

    it('stamps a backup made by a resolution with the time it was made', async () => {
      const timed = new DurableSyncState({ persist, now: () => NOW });
      await timed.enqueue(envelope({ revisionId: 'pending' }));
      await timed.startProducerRecovery({
        id: 'resolution-1', kind: 'resolution', fileIds: ['file-1'],
        state: { mappings: [], heads: {} }, discardRevisionIds: ['pending'],
      });
      const backup = (persist.saved as PersistedSyncState).reconciliationBackups?.['resolution-1'];
      expect(backup?.map((e) => [e.revisionId, e.backedUpAt])).toEqual([['pending', NOW]]);
    });

    it('drops backups older than seven days on load and keeps the rest of the state', async () => {
      await state.saveCursor(7);
      const kept = envelope({ revisionId: 'six-days', backedUpAt: NOW - 6 * DAY });
      const raw = {
        ...(persist.saved as PersistedSyncState),
        reconciliationBackups: {
          recent: [kept, envelope({ revisionId: 'eight-days', backedUpAt: NOW - 8 * DAY })],
          legacy: [envelope({ revisionId: 'enqueued-long-ago', enqueuedAt: NOW - 8 * DAY })],
          undated: [envelope({ revisionId: 'no-time' })],
        },
      };
      persist.saved = raw;

      const reloaded = new DurableSyncState({ persist, now: () => NOW });
      expect(await reloaded.loadCursor()).toBe(7);

      expect(persist.saved).toEqual({ ...raw, reconciliationBackups: { recent: [kept] } });
    });

    it('does not rewrite the state when no backup has aged out', async () => {
      await state.saveCursor(3);
      persist.saved = {
        ...(persist.saved as PersistedSyncState),
        reconciliationBackups: { recent: [envelope({ backedUpAt: NOW - DAY })] },
      };
      const calls = persist.saveCalls;
      await new DurableSyncState({ persist, now: () => NOW }).loadCursor();
      expect(persist.saveCalls).toBe(calls);
    });
  });

  it('starts empty and defaults the cursor to zero', async () => {
    expect(await state.loadCursor()).toBe(0);
    expect(await state.listOutbox()).toEqual([]);
    expect(await state.isLocallyAuthored('rev-1')).toBe(false);
  });

  it('does not advance the in-memory cursor after a failed durable save', async () => {
    await state.saveCursor(1);
    const save = persist.save.bind(persist);
    persist.save = async () => { throw new Error('disk full'); };
    await expect(state.saveCursor(2)).rejects.toThrow('disk full');
    expect(await state.loadCursor()).toBe(1);
    persist.save = save;
    expect(await new DurableSyncState({ persist }).loadCursor()).toBe(1);
  });

  it('does not drop an enqueue that races a concurrent cold-cache load (BLOCKER)', async () => {
    // Two concurrent operations both find a cold cache and each fire `load`.
    // Before the dedup fix the later-resolving load re-parsed the persisted blob
    // and clobbered the cache mutation the enqueue had already made, a silent
    // dropped push at connect (rule 3). Gate the load so both callers enter
    // `ensureLoaded` while the cache is still null, then release.
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let loadCalls = 0;
    const racingPersist: SyncStatePersistPort = {
      async load() {
        loadCalls += 1;
        await loadGate;
        return null;
      },
      async loadBackup() {
        return null;
      },
      async save() {
        /* no-op */
      },
      async preserveCorrupt() {
        /* no-op */
      },
    };
    const racing = new DurableSyncState({ persist: racingPersist });

    const enqueueP = racing.enqueue(envelope({ revisionId: 'rev-race' }));
    const listP = racing.listOutbox();
    releaseLoad();
    await Promise.all([enqueueP, listP]);

    // A single shared in-flight load, and the enqueued revision survives.
    expect(loadCalls).toBe(1);
    expect(await racing.listOutbox()).toEqual([
      expect.objectContaining({ revisionId: 'rev-race' }),
    ]);
  });

  it('does not lose a concurrent read-modify-write when two critical sections race the warm cache (rule 3)', async () => {
    // Faithfully models the production race behind the randomized-convergence
    // flake: the apply path advances a file's base hash AND base content while
    // the reflected observe-modify records path ownership for the SAME file
    // concurrently. Each mutation is a read-modify-write of the shared in-memory
    // cache (`{...state, field}` spread). On a warm cache `ensureLoaded` reads
    // synchronously, so two sections launched without an intervening await both
    // capture the SAME snapshot and the later `mutate` clobbers the earlier one's
    // write, dropping, e.g., the base content while keeping the base hash, which
    // later makes the three-way merge (needing the ancestor content) fail and
    // spawn a SPURIOUS conflict copy. All three writes must survive together.
    await state.loadCursor(); // warm the cache so both sections race on it

    const applyTail = (async () => {
      await state.recordBaseHash('file-1', 'base-hash');
      await state.recordBaseContent('file-1', 'base-body');
    })();
    const reflected = state.recordPathOwner('file-1', 'Notes/a.md');
    await Promise.all([applyTail, reflected]);

    expect(state.baseHashFor('file-1')).toBe('base-hash');
    expect(state.baseContentFor('file-1')).toBe('base-body');
    expect(state.fileIdAtPath('Notes/a.md')).toBe('file-1');
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
      // 'AAAA' base64 decodes to 3 bytes, the size that drives push batching.
      { revisionId: 'rev-1', fileId: 'file-1', contentHash: 'hash-1', payloadBytes: 3 },
    ]);
    expect(await state.getEnvelope('rev-1')).toEqual({
      header: { revisionId: 'rev-1' },
      idempotencyKey: 'idem-1',
      payloadBase64: 'AAAA',
    });
  });

  it('surfaces a revision’s parent ids from its header so the runner can resolve lineage', async () => {
    await state.enqueue(
      envelope({
        revisionId: 'rev-child',
        header: { revisionId: 'rev-child', parentRevisionIds: ['rev-parent'] },
      }),
    );
    expect(await state.listOutbox()).toEqual([
      {
        revisionId: 'rev-child',
        fileId: 'file-1',
        contentHash: 'hash-1',
        payloadBytes: 3,
        parentRevisionIds: ['rev-parent'],
      },
    ]);
  });

  it('removes the outbox entry and remembers local authorship on receipt', async () => {
    await state.enqueue(envelope());
    await state.recordPushReceipt({ revisionId: 'rev-1', serverSequence: 5 });

    expect(await state.listOutbox()).toEqual([]);
    expect(await state.isLocallyAuthored('rev-1')).toBe(true);

    const reopened = new DurableSyncState({ persist });
    expect(await reopened.isLocallyAuthored('rev-1')).toBe(true);
  });

  it('keeps a parked incoming change across a reload until it is unparked (B2)', async () => {
    await state.parkRemote(remoteEvent(3, 'rev-x'), 'The file has an invalid format.');
    await state.parkRemote(remoteEvent(3, 'rev-x'), 'again');
    expect(await state.listParkedRemote()).toEqual([remoteEvent(3, 'rev-x')]);
    expect(state.parkedSnapshot()).toEqual([
      { revisionId: 'rev-x', fileId: 'file-1', reason: 'again' },
    ]);

    const reopened = new DurableSyncState({ persist });
    expect(await reopened.listParkedRemote()).toEqual([remoteEvent(3, 'rev-x')]);
    await reopened.unparkRemote('rev-x');
    expect(await reopened.listParkedRemote()).toEqual([]);
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
    expect(await recovered.listParkedRemote()).toEqual([]);
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
      // nuke cursor/pathOwners/baseHashes, it degrades to an empty stash.
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
    await state.parkRemote(remoteEvent(2, 'r'), 'x');
    const reopened = new DurableSyncState({ persist });
    expect((await reopened.listOutbox())[0]?.revisionId).toBe('rev-1');
    expect(await reopened.getEnvelope('rev-1')).not.toBeUndefined();
    expect(await reopened.getEnvelope('missing')).toBeUndefined();
    expect((await reopened.listParkedRemote()).length).toBe(1);
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

  // P1: a remote apply recorded the path owner, the base hash and the base
  // content in three whole-file writes of data.json.
  it('records an applied revision in one write', async () => {
    await state.loadCursor();
    const before = persist.saveCalls;

    await state.recordApplied('file-9', 'Notes/n.md', 'hash-9', 'body');

    expect(persist.saveCalls - before).toBe(1);
    expect(state.fileIdAtPath('Notes/n.md')).toBe('file-9');
    expect(state.baseHashFor('file-9')).toBe('hash-9');
    expect(state.baseContentFor('file-9')).toBe('body');
  });

  // A2: every note's full text sat in data.json (twice, with the backup),
  // though production merges over the revision history's ancestor.
  it('keeps no note text when base contents are not kept', async () => {
    const legacy = new MemoryPersist({
      version: 1,
      cursor: 0,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      pathOwners: {},
      baseHashes: {},
      baseContents: { 'file-0': 'old note text' },
    });
    const lean = new DurableSyncState({ persist: legacy, keepBaseContents: false });

    await lean.recordApplied('file-9', 'Notes/n.md', 'hash-9', 'body');

    expect(lean.baseContentFor('file-0')).toBeNull();
    expect(lean.baseContentFor('file-9')).toBeNull();
    expect((legacy.saved as PersistedSyncState).baseContents).toEqual({});
    expect(lean.baseHashFor('file-9')).toBe('hash-9');
  });

  it('remembers durably which file a conflict copy belongs to', async () => {
    await state.recordConflictArtifactPath('rev-9', 'Havemind Conflicts/N (conflict A 2026-09-28 1200).md', 'file-7');
    const reopened = new DurableSyncState({ persist });
    await reopened.loadCursor();
    expect(
      reopened.fileIdForConflictCopy('Havemind Conflicts/N (conflict A 2026-09-28 1200).md'),
    ).toBe('file-7');
    expect(reopened.fileIdForConflictCopy('Havemind Conflicts/other.md')).toBeNull();
    expect(
      reopened.revisionForConflictCopy('Havemind Conflicts/N (conflict A 2026-09-28 1200).md'),
    ).toBe('rev-9');
  });

  it('quarantines an outbox item durably, removing it from the outbox', async () => {
    await state.enqueue(envelope());
    await state.quarantineOutboxItem('rev-1', 'server-rejected');

    expect(await state.listOutbox()).toEqual([]);
    expect(state.quarantineSnapshot()).toEqual([
      {
        revisionId: 'rev-1',
        fileId: 'file-1',
        reason: 'server-rejected',
        parentRevisionIds: [],
      },
    ]);

    // The dead-letter record and the emptied outbox both survive a restart.
    const reopened = new DurableSyncState({ persist });
    expect(await reopened.listOutbox()).toEqual([]);
    expect(reopened.quarantineSnapshot()).toEqual([
      {
        revisionId: 'rev-1',
        fileId: 'file-1',
        reason: 'server-rejected',
        parentRevisionIds: [],
      },
    ]);
  });

  it('deduplicates an envelope re-enqueued with the same revision id', async () => {
    await state.enqueue(envelope());
    await state.enqueue(envelope({ contentHash: 'hash-2', payloadBase64: 'BBBB' }));
    const outbox = await state.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.contentHash).toBe('hash-2');
  });

  describe('fail-closed persisted-state recovery (GAP-1)', () => {
    it('SALVAGES a queued outbox when a non-outbox core field is corrupt, then persists normally (no permanent wedge)', async () => {
      // A present blob whose CORE cursor is corrupt but whose outbox still holds
      // a queued-but-unsent revision. The salvage path keeps the readable outbox,
      // resets only the unrecoverable field (cursor→0), preserves the raw blob to
      // the sidecar and writes the CLEANED state as the new primary, nothing is
      // dropped and nothing is wedged.
      const corruptBlob = {
        version: 1,
        cursor: 'not-a-number',
        outbox: [envelope({ revisionId: 'rev-queued' })],
        locallyAuthored: ['rev-author'],
        deferred: [],
      };
      persist = new MemoryPersist(corruptBlob);
      const recovered = new DurableSyncState({ persist, now: () => 4242 });

      await recovered.loadCursor(); // triggers the load/parse + salvage write

      // The readable queue is salvaged; the unrecoverable cursor is reset to 0.
      expect(await recovered.loadCursor()).toBe(0);
      expect((await recovered.listOutbox()).map((r) => r.revisionId)).toEqual([
        'rev-queued',
      ]);
      expect(await recovered.isLocallyAuthored('rev-author')).toBe(true);
      // Salvage is not a wedge: nothing is at risk (the queue was saved).
      expect(recovered.isRecoveryRequired()).toBe(false);

      // The original bytes are preserved under a corrupt sidecar, timestamped
      // from the injected clock, nothing is discarded.
      expect(persist.corrupt).toHaveLength(1);
      expect(persist.corrupt[0]?.raw).toEqual(corruptBlob);
      expect(persist.corrupt[0]?.timestamp).toBe(4242);

      // The salvaged state was written as the new clean primary during hydrate,
      // and subsequent mutations persist normally (the wedge is gone).
      expect(persist.saveCalls).toBeGreaterThanOrEqual(1);
      const savesBefore = persist.saveCalls;
      await recovered.saveCursor(9);
      expect(persist.saveCalls).toBe(savesBefore + 1);
      expect(await recovered.loadCursor()).toBe(9);
    });

    it('reloads a SALVAGED primary as a clean ok state (not re-locked across restart)', async () => {
      const corruptBlob = {
        version: 1,
        cursor: 'not-a-number',
        outbox: [envelope({ revisionId: 'rev-queued' })],
        locallyAuthored: [],
        deferred: [],
      };
      persist = new MemoryPersist(corruptBlob);
      const first = new DurableSyncState({ persist, now: () => 1 });
      await first.loadCursor(); // salvages + rewrites the primary

      // A fresh instance over the SAME persistence reads the cleaned primary as a
      // normal 'ok' state, it must not re-detect corruption and re-lock.
      const reopened = new DurableSyncState({ persist });
      expect(reopened.isRecoveryRequired()).toBe(false);
      expect((await reopened.listOutbox()).map((r) => r.revisionId)).toEqual([
        'rev-queued',
      ]);
      // No fresh corrupt sidecar is minted on the clean reload.
      expect(persist.corrupt).toHaveLength(1);
    });

    it('resumes writable from a clean empty state when the outbox itself is UNRECOVERABLE, surfacing a recovery signal (no wedge)', async () => {
      // The outbox container is not an array, so the queue truly cannot be read.
      // The raw bytes are preserved to the sidecar for manual recovery, the state
      // resumes from a clean writable empty state, the primary is rewritten so a
      // restart does not re-lock, and an OBSERVABLE recovery signal is set.
      const corruptBlob = {
        version: 1,
        cursor: 0,
        outbox: 'not-an-array',
        locallyAuthored: [],
        deferred: [],
      };
      persist = new MemoryPersist(corruptBlob);
      const recovered = new DurableSyncState({ persist, now: () => 99 });

      await recovered.loadCursor();

      // Raw bytes preserved for manual recovery; recovery signal is observable.
      expect(persist.corrupt).toHaveLength(1);
      expect(persist.corrupt[0]?.raw).toEqual(corruptBlob);
      expect(recovered.isRecoveryRequired()).toBe(true);

      // The state is writable, a mutation persists (never wedged).
      await recovered.enqueue(envelope({ revisionId: 'rev-new' }));
      expect((await recovered.listOutbox()).map((r) => r.revisionId)).toEqual([
        'rev-new',
      ]);

      // A restart reads the rewritten clean primary as 'ok' and is not re-locked.
      const reopened = new DurableSyncState({ persist });
      expect(reopened.isRecoveryRequired()).toBe(false);
      expect((await reopened.listOutbox()).map((r) => r.revisionId)).toEqual([
        'rev-new',
      ]);
    });

    it('treats a null/absent blob as a clean first run (no recovery flag)', async () => {
      persist = new MemoryPersist(null);
      const fresh = new DurableSyncState({ persist });

      expect(await fresh.loadCursor()).toBe(0);
      expect(await fresh.listOutbox()).toEqual([]);
      expect(fresh.isRecoveryRequired()).toBe(false);
      expect(persist.corrupt).toEqual([]);

      // A genuine first run is fully writable, the empty state persists normally.
      await fresh.saveCursor(3);
      expect(persist.saveCalls).toBe(1);
      expect(await fresh.loadCursor()).toBe(3);
    });

    it('keeps valid outbox envelopes and quarantines one malformed sibling (no full wipe)', async () => {
      const blob = {
        version: 1,
        cursor: 2,
        outbox: [
          envelope({ revisionId: 'rev-good' }),
          { revisionId: 'rev-bad' }, // missing the required envelope fields
        ],
        locallyAuthored: [],
        deferred: [],
      };
      const recovered = new DurableSyncState({ persist: new MemoryPersist(blob) });

      // The good envelope survives; the whole outbox is NOT nuked.
      const outbox = await recovered.listOutbox();
      expect(outbox.map((row) => row.revisionId)).toEqual(['rev-good']);
      expect(await recovered.loadCursor()).toBe(2);
      expect(recovered.isRecoveryRequired()).toBe(false);

      // The bad entry is quarantined (visible), not silently dropped.
      const quarantine = recovered.quarantineSnapshot();
      expect(
        quarantine.some(
          (row) => row.revisionId === 'rev-bad' && row.reason === 'corrupt-envelope',
        ),
      ).toBe(true);
    });

    it('recovers from a valid .bak when the primary is corrupt', async () => {
      persist = new MemoryPersist({ version: 1, cursor: 'corrupt' });
      persist.backup = {
        version: 1,
        cursor: 12,
        outbox: [],
        locallyAuthored: ['rev-x'],
        deferred: [],
      };
      const recovered = new DurableSyncState({ persist, now: () => 7 });

      // The last durable snapshot is loaded from .bak, so the state is usable
      // and NOT recovery-required.
      expect(await recovered.loadCursor()).toBe(12);
      expect(await recovered.isLocallyAuthored('rev-x')).toBe(true);
      expect(recovered.isRecoveryRequired()).toBe(false);
      // The corrupt primary is still preserved for forensics.
      expect(persist.corrupt).toHaveLength(1);
    });

    it('flags recovery when a corrupt primary recovered from .bak had a newer queued revision the backup lacks', async () => {
      // The primary's CORE cursor is corrupt, but its outbox is intact and holds
      // 'rev-newer', a revision the one-generation-behind .bak does not have
      // (e.g. it was enqueued after the last save() rotated .bak). The backup is
      // a valid, parseable snapshot, so hydrate prefers it as the live state
      // (never auto-merges), but the newer delta the salvage would have kept
      // must not silently vanish: the observable recovery signal must be set.
      persist = new MemoryPersist({
        version: 1,
        cursor: 'corrupt',
        outbox: [envelope({ revisionId: 'rev-newer' })],
        locallyAuthored: [],
        deferred: [],
      });
      persist.backup = {
        version: 1,
        cursor: 12,
        outbox: [],
        locallyAuthored: ['rev-x'],
        deferred: [],
      };
      const recovered = new DurableSyncState({ persist, now: () => 7 });

      // The backup snapshot is preferred as the live state, not a merge.
      expect(await recovered.loadCursor()).toBe(12);
      expect(await recovered.isLocallyAuthored('rev-x')).toBe(true);
      expect(await recovered.listOutbox()).toEqual([]);
      // But the newer delta that was preserved-not-applied must be surfaced.
      expect(recovered.isRecoveryRequired()).toBe(true);
      // The raw corrupt primary (with the newer revision) is preserved to the
      // sidecar for manual recovery.
      expect(persist.corrupt).toHaveLength(1);
      expect(persist.corrupt[0]?.raw).toMatchObject({
        outbox: [expect.objectContaining({ revisionId: 'rev-newer' })],
      });
    });

    it('does NOT flag recovery when the .bak-recovered outbox already matches the corrupt primary salvage (no newer delta)', async () => {
      // Same corrupt-primary-with-intact-outbox shape, but this time the queued
      // revision is ALSO present in the backup snapshot, the salvage carries
      // nothing the backup lacks, so no spurious recovery signal should fire.
      persist = new MemoryPersist({
        version: 1,
        cursor: 'corrupt',
        outbox: [envelope({ revisionId: 'rev-shared' })],
        locallyAuthored: [],
        deferred: [],
      });
      persist.backup = {
        version: 1,
        cursor: 12,
        outbox: [envelope({ revisionId: 'rev-shared' })],
        locallyAuthored: ['rev-x'],
        deferred: [],
      };
      const recovered = new DurableSyncState({ persist, now: () => 7 });

      expect(await recovered.loadCursor()).toBe(12);
      expect((await recovered.listOutbox()).map((r) => r.revisionId)).toEqual([
        'rev-shared',
      ]);
      expect(recovered.isRecoveryRequired()).toBe(false);
      expect(persist.corrupt).toHaveLength(1);
    });
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
      expect(state.quarantineSnapshot()).toEqual([]);

      // A second retry is inert, the stash is gone, so no double-enqueue.
      await state.requeueQuarantined('rev-1');
      expect(await state.listOutbox()).toHaveLength(1);
    });

    it('discards a quarantined item permanently', async () => {
      await state.enqueue(envelope());
      await state.quarantineOutboxItem('rev-1', 'server-rejected');

      await state.discardQuarantined('rev-1');
      expect(state.quarantineSnapshot()).toEqual([]);

      // Retry after discard is a no-op, nothing re-enters the outbox.
      await state.requeueQuarantined('rev-1');
      expect(await state.listOutbox()).toEqual([]);
    });

    it('records a durable failed-to-queue entry surfaced in the quarantine (SND-02)', async () => {
      await state.recordFailedToQueue('Notes/A.md');

      const quarantine = state.quarantineSnapshot();
      expect(quarantine).toEqual([
        {
          revisionId: 'failed-to-queue:Notes/A.md',
          fileId: 'Notes/A.md',
          reason: 'failed-to-queue',
        },
      ]);

      // Idempotent per path: a second failure for the same file does not add a
      // duplicate row.
      await state.recordFailedToQueue('Notes/A.md');
      expect(state.quarantineSnapshot()).toHaveLength(1);

      // Durable across a restart, and discardable via the shared SND-01 path.
      const reopened = new DurableSyncState({ persist });
      await reopened.loadCursor();
      expect(reopened.quarantineSnapshot()).toHaveLength(1);
      await reopened.discardQuarantined('failed-to-queue:Notes/A.md');
      expect(reopened.quarantineSnapshot()).toEqual([]);
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

      // Both rows stay visible in the panel, nothing is silently dropped.
      const rows = bounded.quarantineSnapshot();
      expect(rows.map((r) => r.revisionId).sort()).toEqual(['rev-1', 'rev-2']);

      // The oldest stash was evicted to respect the budget, so its Retry is
      // inert at the state level (no stash) and the caller degrades it to a
      // re-commit from disk (MAJOR 2 path). The newest stash survives, so its
      // Retry still re-enqueues the exact bytes.
      expect(await bounded.requeueQuarantined('rev-1')).toBe(false);
      expect(await bounded.requeueQuarantined('rev-2')).toBe(true);
      // The evicted row remains after its inert retry, visibility is preserved.
      expect(
        (bounded.quarantineSnapshot()).some((r) => r.revisionId === 'rev-1'),
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

    it('keeps the quarantine row shape unchanged (no envelope leak into the row)', async () => {
      await state.enqueue(envelope());
      await state.quarantineOutboxItem('rev-1', 'server-rejected');
      // The row carries the revision's parents, never its payload.
      expect(state.quarantineSnapshot()).toEqual([
        {
          revisionId: 'rev-1',
          fileId: 'file-1',
          reason: 'server-rejected',
          parentRevisionIds: [],
        },
      ]);
    });

    it('resolves a path back from a fileId owner', async () => {
      await state.recordPathOwner('file-1', 'Notes/A.md');
      expect(state.pathForFileId('file-1')).toBe('Notes/A.md');
      expect(state.pathForFileId('unknown')).toBeNull();
    });
  });
});

class FakePayloadStore implements OutboxPayloadStore {
  readonly map = new Map<string, string>();
  putFails = false;
  getFails = false;
  /** Holds every read until it resolves. */
  gate: Promise<void> = Promise.resolve();
  puts = 0;
  gets = 0;
  deletes = 0;

  async putPayload(revisionId: string, payloadBase64: string): Promise<void> {
    this.puts += 1;
    if (this.putFails) throw new Error('payload store unavailable');
    this.map.set(revisionId, payloadBase64);
  }

  async getPayload(revisionId: string): Promise<string | undefined> {
    this.gets += 1;
    await this.gate;
    if (this.getFails) throw new Error('payload store unavailable');
    return this.map.get(revisionId);
  }

  async deletePayload(revisionId: string): Promise<void> {
    this.deletes += 1;
    this.map.delete(revisionId);
  }

  async listPayloadIds(): Promise<readonly string[]> {
    return [...this.map.keys()];
  }
}

/** The disk (data.json) form the persist port last received. */
function diskState(persist: MemoryPersist): PersistedSyncState {
  return persist.saved as PersistedSyncState;
}

describe('DurableSyncState outbox payload externalization (arch P1)', () => {
  let persist: MemoryPersist;
  let store: FakePayloadStore;

  beforeEach(() => {
    persist = new MemoryPersist();
    store = new FakePayloadStore();
  });

  it('enqueues the payload into the store, not into data.json', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'PAYLOAD64' }));

    // The bytes live in the store, keyed by revisionId.
    expect(store.map.get('rev-1')).toBe('PAYLOAD64');
    // data.json carries only a reference: empty payload + externalized marker.
    const disk = diskState(persist);
    expect(disk.outbox[0]?.payloadBase64).toBe('');
    expect(disk.outbox[0]?.payloadExternalized).toBe(true);
    // The runner-facing envelope still resolves the real bytes from the cache.
    expect((await state.getEnvelope('rev-1'))?.payloadBase64).toBe('PAYLOAD64');
    expect(state.peekEnvelope('rev-1')?.payloadBase64).toBe('PAYLOAD64');
  });

  it('keeps data.json small when a large payload is queued', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    const big = 'A'.repeat(200_000);
    await state.enqueue(envelope({ payloadBase64: big }));

    const serialized = JSON.stringify(persist.saved);
    expect(serialized.length).toBeLessThan(1000);
    expect(store.map.get('rev-1')).toBe(big);
  });

  it('reloads an externalized outbox and drains the correct bytes', async () => {
    const first = new DurableSyncState({ persist, payloadStore: store });
    await first.enqueue(envelope({ payloadBase64: 'REAL-BYTES' }));

    // A fresh instance sharing the same (persisted) store + data.json.
    const reopened = new DurableSyncState({ persist, payloadStore: store });
    expect((await reopened.listOutbox())[0]?.revisionId).toBe('rev-1');
    expect((await reopened.getEnvelope('rev-1'))?.payloadBase64).toBe(
      'REAL-BYTES',
    );
  });

  it('keeps receipt payload bytes recoverable if removing the queue entry cannot be saved', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'PRESERVE-ME' }));
    const save = persist.save.bind(persist);
    persist.save = async () => { throw new Error('disk full'); };
    await expect(state.recordPushReceipt({ revisionId: 'rev-1', serverSequence: 1 })).rejects.toThrow('disk full');
    expect(store.map.get('rev-1')).toBe('PRESERVE-ME');
    expect(await state.listOutbox()).toHaveLength(1);
    persist.save = save;
    const reopened = new DurableSyncState({ persist, payloadStore: store });
    expect((await reopened.getEnvelope('rev-1'))?.payloadBase64).toBe('PRESERVE-ME');
  });

  it('migrates a legacy inline-payload data.json into the store, still draining', async () => {
    // A pre-upgrade blob: full payload inline, no externalized marker.
    const legacy: PersistedSyncState = {
      version: 1,
      cursor: 4,
      outbox: [
        {
          operationId: 'op-1',
          revisionId: 'rev-1',
          fileId: 'file-1',
          contentHash: 'hash-1',
          idempotencyKey: 'idem-1',
          header: { revisionId: 'rev-1' },
          payloadBase64: 'LEGACY-INLINE',
        },
      ],
      locallyAuthored: [],
      deferred: [],
      quarantine: [],
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
      conflictArtifacts: {},
      quarantinedEnvelopes: {},
    };
    persist = new MemoryPersist(legacy);
    const state = new DurableSyncState({ persist, payloadStore: store });

    // Warming the cache runs the migration.
    expect(await state.loadCursor()).toBe(4);
    // The inline payload was moved into the store.
    expect(store.map.get('rev-1')).toBe('LEGACY-INLINE');
    // data.json now holds only a reference.
    const disk = diskState(persist);
    expect(disk.outbox[0]?.payloadBase64).toBe('');
    expect(disk.outbox[0]?.payloadExternalized).toBe(true);
    // The outbox still drains the correct bytes.
    expect((await state.getEnvelope('rev-1'))?.payloadBase64).toBe(
      'LEGACY-INLINE',
    );
    expect(await state.listOutbox()).toHaveLength(1);
  });

  it('fails closed when a referenced payload is missing from the store (torn state)', async () => {
    // data.json references an externalized payload the store does NOT have.
    const torn: PersistedSyncState = {
      version: 1,
      cursor: 0,
      outbox: [
        {
          operationId: 'op-1',
          revisionId: 'rev-1',
          fileId: 'file-1',
          contentHash: 'hash-1',
          idempotencyKey: 'idem-1',
          header: { revisionId: 'rev-1' },
          payloadBase64: '',
          payloadExternalized: true,
        },
      ],
      locallyAuthored: [],
      deferred: [],
      quarantine: [],
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
      conflictArtifacts: {},
      quarantinedEnvelopes: {},
    };
    persist = new MemoryPersist(torn);
    const state = new DurableSyncState({ persist, payloadStore: store });

    // The torn item is quarantined, never left drainable with empty bytes.
    expect(await state.listOutbox()).toEqual([]);
    expect(await state.getEnvelope('rev-1')).toBeUndefined();
    expect(state.peekEnvelope('rev-1')).toBeUndefined();
    const rows = state.quarantineSnapshot();
    expect(rows).toEqual([
      { revisionId: 'rev-1', fileId: 'file-1', reason: PAYLOAD_MISSING_REASON },
    ]);
  });

  it('falls back to inline data.json when the store is unavailable', async () => {
    store.putFails = true;
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'INLINE-FALLBACK' }));

    // Nothing reached the store, but sync still works: the bytes are inline.
    expect(store.map.size).toBe(0);
    const disk = diskState(persist);
    expect(disk.outbox[0]?.payloadBase64).toBe('INLINE-FALLBACK');
    expect(disk.outbox[0]?.payloadExternalized).not.toBe(true);
    expect((await state.getEnvelope('rev-1'))?.payloadBase64).toBe(
      'INLINE-FALLBACK',
    );
    expect(await state.listOutbox()).toHaveLength(1);
  });

  it('deletes the externalized payload when a revision leaves the outbox on receipt', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'BYTES' }));
    expect(store.map.has('rev-1')).toBe(true);

    await state.recordPushReceipt({ revisionId: 'rev-1', serverSequence: 9 });
    expect(store.map.has('rev-1')).toBe(false);
  });

  it('deletes the externalized payload when a quarantined send is discarded', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'BYTES' }));
    await state.quarantineOutboxItem('rev-1', 'server-rejected');
    // Still stashed for retry → payload retained.
    expect(store.map.has('rev-1')).toBe(true);

    await state.discardQuarantined('rev-1');
    expect(store.map.has('rev-1')).toBe(false);
  });

  it('deletes the payload of a stash evicted under the byte budget (no leak)', async () => {
    const bounded = new DurableSyncState({
      persist,
      payloadStore: store,
      quarantinedEnvelopeBudgetBytes: 20,
    });
    const big = 'A'.repeat(16); // decodes to 12 bytes; two exceed the 20-byte budget
    await bounded.enqueue(envelope({ revisionId: 'rev-1', payloadBase64: big }));
    await bounded.enqueue(envelope({ revisionId: 'rev-2', payloadBase64: big }));
    await bounded.quarantineOutboxItem('rev-1', 'server-rejected');
    await bounded.quarantineOutboxItem('rev-2', 'server-rejected');

    // The oldest stash was evicted → its payload must not leak in the store.
    expect(store.map.has('rev-1')).toBe(false);
    expect(store.map.has('rev-2')).toBe(true);
  });

  it('retains the payload across quarantine and requeues the exact bytes', async () => {
    const state = new DurableSyncState({ persist, payloadStore: store });
    await state.enqueue(envelope({ payloadBase64: 'RETRY-BYTES' }));
    await state.quarantineOutboxItem('rev-1', 'server-rejected');
    expect(store.map.get('rev-1')).toBe('RETRY-BYTES');

    expect(await state.requeueQuarantined('rev-1')).toBe(true);
    expect((await state.getEnvelope('rev-1'))?.payloadBase64).toBe(
      'RETRY-BYTES',
    );
    expect(store.map.get('rev-1')).toBe('RETRY-BYTES');
  });

  it('keeps a change queued while the first load still reads stored payloads', async () => {
    await new DurableSyncState({ persist, payloadStore: store }).enqueue(envelope());
    let release = (): void => {};
    store.gate = new Promise((resolve) => { release = resolve; });
    const state = new DurableSyncState({ persist, payloadStore: store });

    const loading = state.listOutbox();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = state.enqueue(envelope({ revisionId: 'rev-2', operationId: 'op-2' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([loading, queued]);

    expect((await state.listOutbox()).map((entry) => entry.revisionId)).toEqual(['rev-1', 'rev-2']);
    expect(diskState(persist).outbox.map((entry) => entry.revisionId)).toEqual(['rev-1', 'rev-2']);
  });

  it('deletes stored payloads nothing refers to any more when it loads (S1)', async () => {
    const first = new DurableSyncState({ persist, payloadStore: store });
    await first.enqueue(envelope());
    await first.enqueue(envelope({ revisionId: 'rev-2', operationId: 'op-2' }));
    await first.quarantineOutboxItem('rev-2', 'server-rejected');
    await first.quarantineOutboxItem('rev-3', 'payload-missing');
    store.map.set('rev-3', 'KEPT-FOR-ITS-ROW');
    store.map.set('orphan', 'LEAKED');

    await new DurableSyncState({ persist, payloadStore: store }).listOutbox();

    expect([...store.map.keys()].sort()).toEqual(['rev-1', 'rev-2', 'rev-3']);
  });

  it('keeps every stored payload when the queue was recovered from a damaged copy', async () => {
    await new DurableSyncState({ persist, payloadStore: store }).enqueue(envelope());
    persist.saved = { version: 1, cursor: 'not-a-number' };

    await new DurableSyncState({ persist, payloadStore: store }).listOutbox();

    expect(store.map.has('rev-1')).toBe(true);
  });

  it('still recovers a corrupt blob from backup with a payload store present (GAP-1)', async () => {
    // Seed a good backup, then a corrupt primary, the GAP-1 path must still win.
    const good = new DurableSyncState({ persist, payloadStore: store });
    await good.saveCursor(11);
    await good.saveCursor(12); // primary=12, backup=11
    // Corrupt the primary in place.
    persist.saved = { version: 1, cursor: 'not-a-number' };

    const recovered = new DurableSyncState({ persist, payloadStore: store });
    expect(await recovered.loadCursor()).toBe(11);
  });
});
