import { describe, expect, it, vi } from 'vitest';

import {
  SyncRunner,
  type OpenBuffer,
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
      async (): Promise<readonly PushReceipt[]> => [
        { revisionId: 'rev-a', serverSequence: 1 },
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
    const push = vi.fn(async (): Promise<readonly PushReceipt[]> => []);
    const { runner } = makeRunner({
      state,
      transport: { push, pull: vi.fn(async () => ({ cursor: 0, events: [] })) },
    });

    await runner.trigger();

    expect(push).not.toHaveBeenCalled();
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
