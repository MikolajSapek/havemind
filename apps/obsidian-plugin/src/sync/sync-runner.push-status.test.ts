/**
 * A cycle that could not ship its outbox must not report "synced".
 *
 * The cycle status used to be derived from the PULL side alone, so a revision
 * the server kept rejecting transiently stayed in the outbox forever while the
 * panel showed "Connected · synced" next to "2 changes waiting to send", the
 * exact state a user cannot act on: nothing is wrong, yet nothing is sent.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SyncRunner,
  type OpenBuffer,
  type PushItemResult,
  type PushReceipt,
  type PushRevision,
  type RemoteApplyOutcome,
  type SyncStatePort,
  type SyncTransport,
  type VaultApplyPort,
} from './sync-runner';

class StubState implements SyncStatePort {
  readonly outbox = new Map<string, PushRevision>();

  constructor(items: readonly PushRevision[]) {
    for (const item of items) this.outbox.set(item.revisionId, item);
  }

  async loadCursor(): Promise<number> {
    return 5;
  }
  async saveCursor(): Promise<void> {
    /* unused */
  }
  async listOutbox(): Promise<readonly PushRevision[]> {
    return [...this.outbox.values()];
  }
  async recordPushReceipt(receipt: PushReceipt): Promise<void> {
    this.outbox.delete(receipt.revisionId);
  }
  async quarantineOutboxItem(revisionId: string): Promise<void> {
    this.outbox.delete(revisionId);
  }
  async isLocallyAuthored(): Promise<boolean> {
    return false;
  }
}

const IDLE_VAULT: VaultApplyPort = {
  async openBuffers(): Promise<readonly OpenBuffer[]> {
    return [];
  },
  async applyRemote(): Promise<RemoteApplyOutcome> {
    return 'applied';
  },
  async recordConflict(): Promise<void> {
    /* unused */
  },
};

function runnerWith(results: readonly PushItemResult[], state: StubState) {
  const transport: SyncTransport = {
    push: vi.fn(async () => results),
    pull: vi.fn(async () => ({ cursor: 5, events: [] })),
  };
  return new SyncRunner({
    transport,
    state,
    vault: IDLE_VAULT,
    scheduler: () => undefined,
  });
}

const QUEUED: readonly PushRevision[] = [
  { contentHash: 'h1', fileId: 'file-1', revisionId: 'rev-1', payloadBytes: 16 },
  { contentHash: 'h2', fileId: 'file-2', revisionId: 'rev-2', payloadBytes: 16 },
];

describe('push outcome in the cycle status', () => {
  it('does not report synced while the outbox could not be shipped', async () => {
    const state = new StubState(QUEUED);
    const runner = runnerWith(
      [
        { revisionId: 'rev-1', outcome: 'rejected', permanent: false },
        { revisionId: 'rev-2', outcome: 'rejected', permanent: false },
      ],
      state,
    );

    const result = await runner.trigger();

    expect(result.pushed).toBe(0);
    expect(state.outbox.size).toBe(2);
    expect(result.status).not.toBe('synced');
  });

  it('reports synced when the outbox drained', async () => {
    const state = new StubState(QUEUED);
    const runner = runnerWith(
      [
        {
          revisionId: 'rev-1',
          outcome: 'accepted',
          receipt: { revisionId: 'rev-1', serverSequence: 6 },
        },
        {
          revisionId: 'rev-2',
          outcome: 'accepted',
          receipt: { revisionId: 'rev-2', serverSequence: 7 },
        },
      ],
      state,
    );

    const result = await runner.trigger();

    expect(result.pushed).toBe(2);
    expect(state.outbox.size).toBe(0);
    expect(result.status).toBe('synced');
  });

  it('keeps reporting synced for an ordinary idle cycle', async () => {
    const state = new StubState([]);
    const runner = runnerWith([], state);

    const result = await runner.trigger();

    expect(result.status).toBe('synced');
  });

  it('lets a conflict outrank an unshipped outbox', async () => {
    // A conflict copy is on disk and needs the user; a stuck send is quieter.
    const state = new StubState(QUEUED);
    const transport: SyncTransport = {
      push: vi.fn(
        async (): Promise<readonly PushItemResult[]> => [
          { revisionId: 'rev-1', outcome: 'rejected', permanent: false },
          { revisionId: 'rev-2', outcome: 'rejected', permanent: false },
        ],
      ),
      pull: vi.fn(async () => ({
        cursor: 6,
        events: [
          {
            serverSequence: 6,
            revision: { revisionId: 'r6', fileId: 'file-9', contentHash: 'h9' },
          },
        ],
      })),
    };
    const runner = new SyncRunner({
      transport,
      state,
      vault: {
        ...IDLE_VAULT,
        async applyRemote(): Promise<RemoteApplyOutcome> {
          return 'conflict';
        },
      },
      scheduler: () => undefined,
    });

    const result = await runner.trigger();
    expect(result.status).toBe('conflict');
  });
});
