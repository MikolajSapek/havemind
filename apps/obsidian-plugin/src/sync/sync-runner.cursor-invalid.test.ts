/**
 * A cursor the server rejects must be recoverable, not a permanent offline.
 *
 * The server answers 409 CURSOR_INVALID when a client presents a cursor beyond
 * the vault's highest committed sequence. That is not a transport failure and
 * not an auth failure: the connection is fine, this device simply holds a
 * position the server cannot serve, which happens whenever the server's
 * sequence numbering moves underneath it (a restore from backup, or the repair
 * that renumbers a log damaged by the old compaction).
 *
 * Before this, 409 fell through as a generic error: the cycle reported
 * `offline`, the panel showed "The server refused the session", and the runner
 * retried the same bad cursor forever. Nothing in the client even referenced
 * CURSOR_INVALID, so the device could never come back on its own.
 *
 * Recovery is to reset the cursor to zero and re-bootstrap, which is exactly a
 * fresh join: current heads are materialised and content already on disk
 * converges without a write.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SyncRunner,
  type OpenBuffer,
  type PushRevision,
  type RemoteApplyOutcome,
  type SyncStatePort,
  type SyncTransport,
  type VaultApplyPort,
} from './sync-runner';

class StubState implements SyncStatePort {
  cursor: number;
  readonly savedCursors: number[] = [];

  constructor(cursor: number) {
    this.cursor = cursor;
  }

  async loadCursor(): Promise<number> {
    return this.cursor;
  }
  async saveCursor(sequence: number): Promise<void> {
    this.cursor = sequence;
    this.savedCursors.push(sequence);
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

/** The shape the transport raises for a 409: neither auth nor permanent. */
function cursorInvalidError(): Error & { cursorInvalid: boolean } {
  return Object.assign(new Error('Server returned HTTP 409.'), {
    cursorInvalid: true,
  });
}

describe('CURSOR_INVALID recovery', () => {
  it('resets the cursor to zero and re-bootstraps instead of going offline', async () => {
    const state = new StubState(1842);
    let call = 0;
    const transport: SyncTransport = {
      push: vi.fn(async () => []),
      pull: vi.fn(async (after: number) => {
        call += 1;
        // The server renumbered below this device's cursor.
        if (after > 826) throw cursorInvalidError();
        return {
          cursor: 826,
          events: [],
          snapshot: true,
          complete: true,
        };
      }),
    };

    const runner = new SyncRunner({
      transport,
      state,
      vault: IDLE_VAULT,
      scheduler: () => undefined,
    });

    const result = await runner.trigger();

    expect(result.status).not.toBe('offline');
    expect(state.savedCursors[0]).toBe(0);
    expect(call).toBeGreaterThan(1);
  });

  it('does not reset on an ordinary transport failure', async () => {
    // A network blip must keep the cursor: resetting it would replay the whole
    // vault over a populated one on every flaky connection.
    const state = new StubState(500);
    const transport: SyncTransport = {
      push: vi.fn(async () => []),
      pull: vi.fn(async () => {
        throw new Error('network down');
      }),
    };

    const runner = new SyncRunner({
      transport,
      state,
      vault: IDLE_VAULT,
      scheduler: () => undefined,
    });

    const result = await runner.trigger();

    expect(result.status).toBe('offline');
    expect(state.cursor).toBe(500);
    expect(state.savedCursors).toEqual([]);
  });

  it('gives up rather than looping when the reset cursor is refused too', async () => {
    // If even zero is refused the problem is not the cursor; report offline and
    // back off instead of resetting on a loop.
    const state = new StubState(1842);
    const transport: SyncTransport = {
      push: vi.fn(async () => []),
      pull: vi.fn(async () => {
        throw cursorInvalidError();
      }),
    };

    const runner = new SyncRunner({
      transport,
      state,
      vault: IDLE_VAULT,
      scheduler: () => undefined,
    });

    const result = await runner.trigger();
    expect(result.status).toBe('offline');
  });
});
