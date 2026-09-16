/**
 * Bootstrap write amplification (the 20-minute phone join).
 *
 * Every `recordPathOwner` / `recordBaseHash` / `recordBaseContent` used to
 * re-serialise the WHOLE `data.json` through the persist port, and that port
 * turns one save into two full load+save round trips (stage, then promote).
 * Materialising a vault of N notes therefore wrote the entire blob O(N) times
 * while the blob itself grew with N, which is quadratic and is what made a
 * few hundred notes take twenty minutes on a phone.
 *
 * `runBatched` coalesces one bootstrap's bookkeeping into a single persist at
 * the end, without changing what ends up on disk.
 */

import { describe, expect, it } from 'vitest';

import { DurableSyncState, type PersistedSyncState } from './sync-state';

function countingPersist() {
  let stored: PersistedSyncState | null = null;
  let saves = 0;
  return {
    get saves() {
      return saves;
    },
    get stored() {
      return stored;
    },
    port: {
      async load() {
        return stored;
      },
      async loadBackup() {
        return null;
      },
      async save(state: PersistedSyncState) {
        saves += 1;
        stored = state;
      },
      async preserveCorrupt() {
        /* no-op */
      },
    },
  };
}

const NOTES = 50;

describe('DurableSyncState.runBatched', () => {
  it('persists once for a whole bootstrap instead of once per record', async () => {
    const persist = countingPersist();
    const state = new DurableSyncState({ persist: persist.port });

    await state.runBatched(async () => {
      for (let i = 0; i < NOTES; i += 1) {
        await state.recordPathOwner(`file-${i}`, `Notes/note-${i}.md`);
        await state.recordBaseHash(`file-${i}`, `hash-${i}`);
        await state.recordBaseContent(`file-${i}`, `content-${i}`);
      }
      await state.saveCursor(NOTES);
    });

    // One flush for the batch. Without batching this is 3*NOTES + 1 saves.
    expect(persist.saves).toBe(1);
  });

  it('writes exactly the same state a non-batched run would', async () => {
    const batched = countingPersist();
    const plain = countingPersist();
    const a = new DurableSyncState({ persist: batched.port });
    const b = new DurableSyncState({ persist: plain.port });

    const work = async (state: DurableSyncState): Promise<void> => {
      for (let i = 0; i < NOTES; i += 1) {
        await state.recordPathOwner(`file-${i}`, `Notes/note-${i}.md`);
        await state.recordBaseHash(`file-${i}`, `hash-${i}`);
        await state.recordBaseContent(`file-${i}`, `content-${i}`);
      }
      await state.saveCursor(NOTES);
    };

    await a.runBatched(() => work(a));
    await work(b);

    expect(batched.stored).toEqual(plain.stored);
    expect(plain.saves).toBeGreaterThan(batched.saves);
  });

  it('flushes what was recorded even when the batch body throws', async () => {
    const persist = countingPersist();
    const state = new DurableSyncState({ persist: persist.port });

    await expect(
      state.runBatched(async () => {
        await state.recordPathOwner('file-0', 'Notes/note-0.md');
        await state.saveCursor(7);
        throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');

    // An interrupted bootstrap must not lose the heads it already materialised,
    // otherwise the next connect replays from zero over a populated vault.
    expect(persist.saves).toBe(1);
    expect(persist.stored?.cursor).toBe(7);
    expect(persist.stored?.pathOwners['Notes/note-0.md']).toBe('file-0');
  });

  it('is re-entrant: a nested batch flushes once with the outer one', async () => {
    const persist = countingPersist();
    const state = new DurableSyncState({ persist: persist.port });

    await state.runBatched(async () => {
      await state.recordPathOwner('file-a', 'A.md');
      await state.runBatched(async () => {
        await state.recordPathOwner('file-b', 'B.md');
      });
      expect(persist.saves).toBe(0);
    });

    expect(persist.saves).toBe(1);
    expect(persist.stored?.pathOwners['A.md']).toBe('file-a');
    expect(persist.stored?.pathOwners['B.md']).toBe('file-b');
  });
});
