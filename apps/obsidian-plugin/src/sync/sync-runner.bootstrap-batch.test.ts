/**
 * The bootstrap apply pass must run inside ONE durable-state batch.
 *
 * Every head the phone materialises records a path owner, a base hash and a base
 * content, and each of those used to re-serialise the whole `data.json`. Over a
 * few hundred notes that is quadratic and is what made a phone join take twenty
 * minutes; long enough for iOS to background the app mid-bootstrap, which then
 * left cursor zero over a populated vault.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SyncRunner,
  type OpenBuffer,
  type PushRevision,
  type RemoteApplyOutcome,
  type RemoteEvent,
  type SyncStatePort,
  type SyncTransport,
  type VaultApplyPort,
} from './sync-runner';

function head(sequence: number): RemoteEvent {
  return {
    serverSequence: sequence,
    revision: {
      revisionId: `rev-${sequence}`,
      fileId: `file-${sequence}`,
      contentHash: `hash-${sequence}`,
    },
  };
}

class BatchingState implements SyncStatePort {
  cursor = 0;
  /** Nesting depth observed at each applyRemote call. */
  readonly depthDuringApply: number[] = [];
  private depth = 0;
  batches = 0;

  async runBatched<T>(body: () => Promise<T>): Promise<T> {
    this.depth += 1;
    if (this.depth === 1) this.batches += 1;
    try {
      return await body();
    } finally {
      this.depth -= 1;
    }
  }

  currentDepth(): number {
    return this.depth;
  }

  async loadCursor(): Promise<number> {
    return this.cursor;
  }
  async saveCursor(sequence: number): Promise<void> {
    this.cursor = sequence;
  }
  async listOutbox(): Promise<readonly PushRevision[]> {
    return [];
  }
  async recordPushReceipt(): Promise<void> {
    /* unused */
  }
  async quarantineOutboxItem(): Promise<void> {
    /* unused */
  }
  async isLocallyAuthored(): Promise<boolean> {
    return false;
  }
}

function makeVault(state: BatchingState): VaultApplyPort {
  return {
    async openBuffers(): Promise<readonly OpenBuffer[]> {
      return [];
    },
    async applyRemote(): Promise<RemoteApplyOutcome> {
      state.depthDuringApply.push(state.currentDepth());
      return 'applied';
    },
    async recordConflict(): Promise<void> {
      /* unused */
    },
  };
}

describe('bootstrap batching', () => {
  it('applies every snapshot head inside one durable-state batch', async () => {
    const state = new BatchingState();
    const events = [head(1), head(2), head(3), head(4)];
    const transport: SyncTransport = {
      push: vi.fn(async () => []),
      pull: vi.fn(async () => ({
        cursor: 4,
        events,
        snapshot: true,
        complete: true,
      })),
    };

    const runner = new SyncRunner({
      transport,
      state,
      vault: makeVault(state),
      scheduler: () => undefined,
    });

    await runner.trigger();

    expect(state.depthDuringApply).toHaveLength(4);
    expect(state.depthDuringApply.every((depth) => depth === 1)).toBe(true);
    expect(state.batches).toBe(1);
    expect(state.cursor).toBe(4);
  });

  it('applies collapsed-bootstrap heads inside one batch too', async () => {
    const state = new BatchingState();
    const events = [head(1), head(2)];
    const transport: SyncTransport = {
      push: vi.fn(async () => []),
      // No `snapshot` flag: the older-server path that collapses locally.
      pull: vi.fn(async () => ({ cursor: 2, events })),
    };

    const runner = new SyncRunner({
      transport,
      state,
      vault: makeVault(state),
      scheduler: () => undefined,
    });

    await runner.trigger();

    expect(state.depthDuringApply.length).toBeGreaterThan(0);
    expect(state.depthDuringApply.every((depth) => depth === 1)).toBe(true);
    expect(state.batches).toBe(1);
  });

  it('works against a state port that has no batching support', async () => {
    // The port method is optional, an older/simpler state must still sync.
    const plain: SyncStatePort = {
      cursor: 0,
      async loadCursor() {
        return 0;
      },
      async saveCursor() {
        /* ignored */
      },
      async listOutbox() {
        return [];
      },
      async recordPushReceipt() {
        /* unused */
      },
      async quarantineOutboxItem() {
        /* unused */
      },
      async isLocallyAuthored() {
        return false;
      },
    } as SyncStatePort & { cursor: number };

    let applied = 0;
    const runner = new SyncRunner({
      transport: {
        push: vi.fn(async () => []),
        pull: vi.fn(async () => ({
          cursor: 2,
          events: [head(1), head(2)],
          snapshot: true,
          complete: true,
        })),
      },
      state: plain,
      vault: {
        async openBuffers() {
          return [];
        },
        async applyRemote() {
          applied += 1;
          return 'applied';
        },
        async recordConflict() {
          /* unused */
        },
      },
      scheduler: () => undefined,
    });

    await runner.trigger();
    expect(applied).toBe(2);
  });
});
