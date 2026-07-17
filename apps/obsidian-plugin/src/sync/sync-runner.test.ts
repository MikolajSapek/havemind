import { describe, expect, it, vi } from 'vitest';

import {
  SyncRunner,
  type OpenBuffer,
  type PushItemResult,
  type PushReceipt,
  type PushRevision,
  type RemoteApplyOutcome,
  type RemoteEvent,
  type SyncRunnerOptions,
  type SyncStatePort,
  type SyncTransport,
  type VaultApplyPort,
} from './sync-runner';

interface ScheduledRetry {
  callback: () => void;
  delayMs: number;
}

class FakeState implements SyncStatePort {
  cursor = 0;
  readonly outbox = new Map<string, PushRevision>();
  readonly authored = new Set<string>();
  readonly quarantined = new Map<string, string>();

  constructor(seed?: {
    cursor?: number;
    outbox?: readonly PushRevision[];
    authored?: readonly string[];
  }) {
    if (seed?.cursor !== undefined) this.cursor = seed.cursor;
    for (const revision of seed?.outbox ?? []) {
      this.outbox.set(revision.revisionId, revision);
    }
    for (const id of seed?.authored ?? []) this.authored.add(id);
  }

  async loadCursor(): Promise<number> {
    return this.cursor;
  }

  async saveCursor(sequence: number): Promise<void> {
    this.cursor = sequence;
  }

  async listOutbox(): Promise<readonly PushRevision[]> {
    return [...this.outbox.values()];
  }

  async recordPushReceipt(receipt: PushReceipt): Promise<void> {
    this.outbox.delete(receipt.revisionId);
    this.authored.add(receipt.revisionId);
  }

  async quarantineOutboxItem(revisionId: string, reason: string): Promise<void> {
    this.outbox.delete(revisionId);
    this.quarantined.set(revisionId, reason);
  }

  async isLocallyAuthored(revisionId: string): Promise<boolean> {
    return this.authored.has(revisionId);
  }
}

class FakeVault implements VaultApplyPort {
  readonly buffers = new Map<string, OpenBuffer[]>();
  readonly applied: RemoteEvent[] = [];
  readonly conflicts: RemoteEvent[] = [];
  /** Outcome `applyRemote` returns per fileId; defaults to 'applied'. */
  readonly applyOutcomes = new Map<string, RemoteApplyOutcome>();

  async openBuffers(fileId: string): Promise<readonly OpenBuffer[]> {
    return this.buffers.get(fileId) ?? [];
  }

  async applyRemote(event: RemoteEvent): Promise<RemoteApplyOutcome> {
    const outcome = this.applyOutcomes.get(event.revision.fileId) ?? 'applied';
    if (outcome === 'conflict') {
      this.conflicts.push(event);
    } else {
      this.applied.push(event);
    }
    return outcome;
  }

  async recordConflict(event: RemoteEvent): Promise<void> {
    this.conflicts.push(event);
  }
}

function makeRunner(
  overrides: Partial<SyncRunnerOptions> = {},
): {
  runner: SyncRunner;
  state: FakeState;
  vault: FakeVault;
  transport: SyncTransport;
  retries: ScheduledRetry[];
} {
  const state = (overrides.state as FakeState) ?? new FakeState();
  const vault = (overrides.vault as FakeVault) ?? new FakeVault();
  const retries: ScheduledRetry[] = [];
  const transport: SyncTransport = overrides.transport ?? {
    push: vi.fn(async () => []),
    pull: vi.fn(async () => ({ cursor: 0, events: [] })),
  };

  const runner = new SyncRunner({
    transport,
    state,
    vault,
    scheduler: (callback, delayMs) => retries.push({ callback, delayMs }),
    random: () => 0,
    ...overrides,
  });

  return { runner, state, vault, transport, retries };
}

function event(
  serverSequence: number,
  fileId: string,
  contentHash: string,
  revisionId = `rev-${serverSequence}`,
): RemoteEvent {
  return { revision: { contentHash, fileId, revisionId }, serverSequence };
}

describe('SyncRunner push', () => {
  it('pushes durable outbox revisions and records their receipts', async () => {
    const state = new FakeState({
      outbox: [{ contentHash: 'h-a', fileId: 'file-a', revisionId: 'rev-a' }],
    });
    const push = vi.fn(
      async (): Promise<readonly PushItemResult[]> => [
        {
          revisionId: 'rev-a',
          outcome: 'accepted',
          receipt: { revisionId: 'rev-a', serverSequence: 1 },
        },
      ],
    );
    const { runner } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 1, events: [] })) },
    });

    const result = await runner.trigger();

    expect(push).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(1);
    expect([...state.outbox.keys()]).toEqual([]);
    expect(state.authored.has('rev-a')).toBe(true);
  });

  it('does not re-push an already acknowledged revision after a restart', async () => {
    // Simulates a process restart: the durable outbox is empty because the
    // revision was already pushed and recorded before the crash.
    const state = new FakeState({ authored: ['rev-a'], cursor: 0 });
    const push = vi.fn(async (): Promise<readonly PushItemResult[]> => []);
    const { runner } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
    });

    await runner.trigger();

    expect(push).not.toHaveBeenCalled();
  });
});

describe('SyncRunner poison-item isolation', () => {
  it('quarantines a permanently rejected item while the rest of the outbox drains, without infinite backoff', async () => {
    // A 600 KB note and a small note share the outbox. The big note is isolated
    // into its own request (byte budget) and the transport rejects it with a
    // permanent 4xx; the small note commits. The bad item lands in quarantine
    // and NO backoff retry is scheduled.
    const state = new FakeState({
      outbox: [
        {
          contentHash: 'h-big',
          fileId: 'file-big',
          revisionId: 'rev-big',
          payloadBytes: 600 * 1024,
        },
        {
          contentHash: 'h-small',
          fileId: 'file-small',
          revisionId: 'rev-small',
          payloadBytes: 32,
        },
      ],
    });
    const push = vi.fn(
      async (
        revisions: readonly PushRevision[],
      ): Promise<readonly PushItemResult[]> => {
        if (revisions.some((revision) => revision.revisionId === 'rev-big')) {
          // The server refused the oversized payload (e.g. 413/422).
          throw Object.assign(new Error('Server returned HTTP 413.'), {
            permanent: true,
          });
        }
        return revisions.map((revision) => ({
          revisionId: revision.revisionId,
          outcome: 'accepted' as const,
          receipt: { revisionId: revision.revisionId, serverSequence: 7 },
        }));
      },
    );
    const { runner, retries } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
      maxPushBatchBytes: 512 * 1024,
    });

    const result = await runner.trigger();

    expect(result.pushed).toBe(1);
    expect(result.quarantined).toBe(1);
    // The small note synced; the big note is gone from the outbox…
    expect([...state.outbox.keys()]).toEqual([]);
    expect(state.authored.has('rev-small')).toBe(true);
    // …and dead-lettered with a surfaced reason, not silently dropped.
    expect(state.quarantined.get('rev-big')).toBe('Server returned HTTP 413.');
    // A permanent failure never schedules a retry: no infinite backoff.
    expect(retries).toHaveLength(0);
  });

  it('records the accepted prefix and only isolates the permanently rejected item in a batch', async () => {
    // Both items ship in one batch; the server accepts #1 and permanently
    // rejects #2. #1 must be recorded done and never re-sent; only #2 is removed.
    const state = new FakeState({
      outbox: [
        { contentHash: 'h1', fileId: 'file-1', revisionId: 'rev-1', payloadBytes: 16 },
        { contentHash: 'h2', fileId: 'file-2', revisionId: 'rev-2', payloadBytes: 16 },
      ],
    });
    const push = vi.fn(
      async (): Promise<readonly PushItemResult[]> => [
        {
          revisionId: 'rev-1',
          outcome: 'accepted',
          receipt: { revisionId: 'rev-1', serverSequence: 3 },
        },
        { revisionId: 'rev-2', outcome: 'rejected', permanent: true },
      ],
    );
    const { runner, retries } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
    });

    const result = await runner.trigger();

    // The whole batch was pushed once — #1 is not re-sent forever.
    expect(push).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(state.authored.has('rev-1')).toBe(true);
    expect([...state.outbox.keys()]).toEqual([]);
    expect(state.quarantined.has('rev-2')).toBe(true);
    expect(retries).toHaveLength(0);
  });

  it('keeps a transiently rejected item in the outbox to retry after a pull', async () => {
    const state = new FakeState({
      outbox: [
        { contentHash: 'h1', fileId: 'file-1', revisionId: 'rev-1', payloadBytes: 16 },
      ],
    });
    const push = vi.fn(
      async (): Promise<readonly PushItemResult[]> => [
        { revisionId: 'rev-1', outcome: 'rejected', permanent: false },
      ],
    );
    const { runner } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
    });

    const result = await runner.trigger();

    expect(result.pushed).toBe(0);
    expect(result.quarantined).toBe(0);
    // Left in the outbox, not quarantined: it will be retried next cycle.
    expect([...state.outbox.keys()]).toEqual(['rev-1']);
    expect(state.quarantined.size).toBe(0);
  });

  it('backs off (does not quarantine) when a push fails transiently', async () => {
    const state = new FakeState({
      outbox: [
        { contentHash: 'h1', fileId: 'file-1', revisionId: 'rev-1', payloadBytes: 16 },
      ],
    });
    const push = vi.fn(async () => {
      // A 5xx / network error carries no `permanent` flag → transient.
      throw new Error('Server returned HTTP 503.');
    });
    const { runner, retries } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
    });

    const result = await runner.trigger();

    expect(result.status).toBe('offline');
    expect(result.quarantined).toBe(0);
    // The item stays queued and a backoff retry is scheduled.
    expect([...state.outbox.keys()]).toEqual(['rev-1']);
    expect(state.quarantined.size).toBe(0);
    expect(retries).toHaveLength(1);
  });
});

describe('SyncRunner single-flight and backoff', () => {
  it('coalesces overlapping triggers into a single in-flight cycle', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pull = vi.fn(async () => {
      await gate;
      return { cursor: 0, events: [] as RemoteEvent[] };
    });
    const { runner } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
    });

    const first = runner.trigger();
    const second = runner.trigger();
    release();
    await Promise.all([first, second]);

    // The overlapping trigger requests exactly one rerun, never two parallel
    // pulls racing the same cursor.
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('reports every completed cycle through onCycleComplete, including backoff-driven recovery', async () => {
    const pull = vi
      .fn<SyncTransport['pull']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ cursor: 0, events: [] });
    const observed: string[] = [];
    const { runner, retries } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
      onCycleComplete: (result) => observed.push(result.status),
    });

    const first = await runner.trigger();
    expect(first.status).toBe('offline');
    // The failed cycle was observed…
    expect(observed).toEqual(['offline']);

    // …and the backoff-driven retry cycle is observed too, so a success reached
    // only through the runner's own scheduler still surfaces the recovery. The
    // scheduler callback fires the cycle without awaiting it, so flush the loop.
    retries[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual(['offline', 'synced']);
  });

  it('schedules a jittered exponential backoff retry when the transport fails', async () => {
    const pull = vi
      .fn<SyncTransport['pull']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ cursor: 0, events: [] });
    const { runner, retries } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
      baseBackoffMs: 5000,
    });

    const first = await runner.trigger();
    expect(first.status).toBe('offline');
    expect(retries[0]?.delayMs).toBe(2500);

    const second = await runner.trigger();
    expect(second.status).toBe('offline');
    // Attempt two doubles the ceiling before half-jitter.
    expect(retries[1]?.delayMs).toBe(5000);

    const third = await runner.trigger();
    expect(third.status).toBe('synced');
    // Success resets the failure counter, so the next failure starts over.
    expect(retries).toHaveLength(2);
  });
});

describe('SyncRunner stop (reconnect quiescence)', () => {
  it('emits no further push once stopped, even when a pending backoff retry fires', async () => {
    // A prior-session connection that went offline is backing off. On reconnect
    // its handle is stopped; the pending backoff must never fire a push through
    // the now-stale transport (old identity) and 403 the server.
    const push = vi.fn(async (): Promise<readonly PushItemResult[]> => {
      throw new Error('offline');
    });
    const pull = vi.fn(async () => ({ cursor: 0, events: [] as RemoteEvent[] }));
    const state = new FakeState({
      outbox: [{ contentHash: 'h', fileId: 'file-old', revisionId: 'rev-old' }],
    });
    const { runner, retries } = makeRunner({ state, transport: { push, pull } });

    const first = await runner.trigger();
    expect(first.status).toBe('offline');
    expect(push).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(1);

    runner.stop();
    retries[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stopped runner shipped no further push — the stale revision can no
    // longer escape after teardown/reconnect.
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('makes trigger() inert after stop() so neither push nor pull runs', async () => {
    const push = vi.fn(async (): Promise<readonly PushItemResult[]> => []);
    const pull = vi.fn(async () => ({ cursor: 0, events: [] as RemoteEvent[] }));
    const state = new FakeState({
      outbox: [{ contentHash: 'h', fileId: 'file-old', revisionId: 'rev-old' }],
    });
    const { runner } = makeRunner({ state, transport: { push, pull } });

    runner.stop();
    const result = await runner.trigger();

    expect(push).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(result.pushed).toBe(0);
  });

  it('does not schedule a new backoff after stop() when a cycle fails', async () => {
    const pull = vi.fn(async () => {
      throw new Error('offline');
    });
    const { runner, retries } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
    });

    runner.stop();
    await runner.trigger();

    expect(retries).toHaveLength(0);
  });
});

describe('SyncRunner remote apply', () => {
  it('applies a remote revision when no editor buffer is open', async () => {
    const { runner, vault, state } = makeRunner({
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(1);
    expect(vault.conflicts).toHaveLength(0);
    expect(state.cursor).toBe(1);
    expect(result.status).toBe('synced');
  });

  it('applies over a clean open buffer that still matches its synced base', async () => {
    const vault = new FakeVault();
    vault.buffers.set('file-a', [{ baseHash: 'base', currentHash: 'base' }]);
    const { runner } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(1);
    expect(result.status).toBe('synced');
  });

  it('suppresses the echo of a locally authored revision without touching the file', async () => {
    const state = new FakeState({ authored: ['rev-1'] });
    const vault = new FakeVault();
    const { runner } = makeRunner({
      state,
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash', 'rev-1')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(0);
    expect(vault.conflicts).toHaveLength(0);
    expect(result.suppressed).toBe(1);
    expect(state.cursor).toBe(1);
  });

  it('never overwrites a divergent open buffer: routes to conflict instead', async () => {
    const vault = new FakeVault();
    vault.buffers.set('file-a', [{ baseHash: 'base', currentHash: 'local-edit' }]);
    const { runner, state } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(0);
    expect(vault.conflicts).toHaveLength(1);
    expect(result.status).toBe('conflict');
    expect(state.cursor).toBe(1);
  });

  it('defers when a divergent buffer has an unknown base and stops advancing', async () => {
    const vault = new FakeVault();
    vault.buffers.set('file-a', [{ baseHash: null, currentHash: 'local-edit' }]);
    const { runner, state } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 2,
          events: [
            event(1, 'file-a', 'remote-hash'),
            event(2, 'file-b', 'other-hash'),
          ],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(0);
    expect(vault.conflicts).toHaveLength(0);
    expect(result.status).toBe('deferred');
    // The cursor never advanced past the deferred event, so nothing after it
    // is materialized this cycle.
    expect(state.cursor).toBe(0);
  });

  it('applies when a divergent buffer already equals the incoming remote content', async () => {
    const vault = new FakeVault();
    vault.buffers.set('file-a', [
      { baseHash: 'base', currentHash: 'remote-hash' },
    ]);
    const { runner } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(1);
    expect(vault.conflicts).toHaveLength(0);
    expect(result.status).toBe('synced');
  });

  it('routes to conflict when the on-disk guard rejects a clean-buffer apply', async () => {
    // The open buffer guard is clean (no buffers), but the vault's on-disk
    // overwrite guard reports the file diverged. The runner must count this as a
    // conflict, not a silent apply (rule 3), and still advance the cursor.
    const vault = new FakeVault();
    vault.applyOutcomes.set('file-a', 'conflict');
    const { runner, state } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.applied).toHaveLength(0);
    expect(vault.conflicts).toHaveLength(1);
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toBe(1);
    expect(state.cursor).toBe(1);
  });

  it('treats an on-disk no-op apply as synced without a conflict', async () => {
    // The on-disk content already equals the incoming revision: the vault skips
    // the write and reports a no-op. The runner stays synced.
    const vault = new FakeVault();
    vault.applyOutcomes.set('file-a', 'noop');
    const { runner } = makeRunner({
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 1,
          events: [event(1, 'file-a', 'remote-hash')],
        })),
      },
    });

    const result = await runner.trigger();

    expect(vault.conflicts).toHaveLength(0);
    expect(result.status).toBe('synced');
  });

  it('skips events at or below the durable cursor to avoid duplicate apply', async () => {
    const state = new FakeState({ cursor: 1 });
    const vault = new FakeVault();
    const { runner } = makeRunner({
      state,
      vault,
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 2,
          events: [
            event(1, 'file-a', 'remote-hash'),
            event(2, 'file-b', 'remote-hash-2'),
          ],
        })),
      },
    });

    await runner.trigger();

    expect(vault.applied).toHaveLength(1);
    expect(vault.applied[0]?.serverSequence).toBe(2);
    expect(state.cursor).toBe(2);
  });
});

describe('SyncRunner auth denial', () => {
  it('reports unauthenticated and does NOT schedule a retry on a 401 (no storm)', async () => {
    const pull = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { authDenied: true });
    });
    const { runner, retries } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
    });

    const result = await runner.trigger();

    expect(result.status).toBe('unauthenticated');
    // Terminal: no backoff retry is scheduled, so the loop cannot storm.
    expect(retries).toHaveLength(0);
  });

  it('still backs off for a transient (non-auth) failure', async () => {
    const pull = vi.fn(async () => {
      throw new Error('offline');
    });
    const { runner, retries } = makeRunner({
      transport: { push: vi.fn(async () => []), pull },
    });

    const result = await runner.trigger();

    expect(result.status).toBe('offline');
    expect(retries).toHaveLength(1);
  });
});
