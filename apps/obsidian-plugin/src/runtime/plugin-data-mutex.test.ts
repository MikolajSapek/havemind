import { describe, expect, it } from 'vitest';

import {
  PluginDataMutex,
  createSerializedDataPort,
  getPluginDataMutex,
  type PluginDataAccess,
} from './plugin-data-mutex';

/**
 * In-memory `data.json` with a real async boundary on both load and save, so a
 * naive (unserialized) load-modify-save would interleave and clobber. The mutex
 * must serialize every read-modify-write onto one queue.
 */
class FakeAccess implements PluginDataAccess {
  private store: Record<string, unknown> = {};
  loads = 0;
  saves = 0;

  async loadData(): Promise<unknown> {
    this.loads += 1;
    await Promise.resolve();
    return JSON.parse(JSON.stringify(this.store)) as unknown;
  }

  async saveData(data: unknown): Promise<void> {
    this.saves += 1;
    await Promise.resolve();
    this.store = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  }

  snapshot(): Record<string, unknown> {
    return this.store;
  }
}

describe('PluginDataMutex.update (MAJOR)', () => {
  it('two concurrent updates to different keys both survive', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);

    await Promise.all([
      mutex.update((data) => ({ ...data, alpha: 1 })),
      mutex.update((data) => ({ ...data, beta: 2 })),
    ]);

    expect(access.snapshot()).toEqual({ alpha: 1, beta: 2 });
  });

  it('surfaces a failing update to its own caller without wedging the queue', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);

    await expect(
      mutex.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The queue keeps running after a rejected link.
    await mutex.update((data) => ({ ...data, gamma: 3 }));
    expect(access.snapshot()).toEqual({ gamma: 3 });
  });
});

describe('createSerializedDataPort (MAJOR)', () => {
  it('two concurrent saves to different keys both survive', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);
    const portA = createSerializedDataPort(mutex);
    const portB = createSerializedDataPort(mutex);

    // Both stores read a cold snapshot, then each writes only its own key.
    const baseA = await portA.load();
    const baseB = await portB.load();

    await Promise.all([
      portA.save({ ...baseA, alpha: 1 }),
      portB.save({ ...baseB, beta: 2 }),
    ]);

    expect(access.snapshot()).toEqual({ alpha: 1, beta: 2 });
  });

  it('a save preserves a concurrent update to a different key', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);
    const port = createSerializedDataPort(mutex);

    const base = await port.load();
    await Promise.all([
      mutex.update((data) => ({ ...data, viaUpdate: 'kept' })),
      port.save({ ...base, viaPort: 'kept' }),
    ]);

    expect(access.snapshot()).toEqual({ viaUpdate: 'kept', viaPort: 'kept' });
  });
});

describe('getPluginDataMutex', () => {
  it('returns the same shared mutex per plugin instance', () => {
    const access = new FakeAccess();
    expect(getPluginDataMutex(access)).toBe(getPluginDataMutex(access));
  });
});

// P4: every load and every update read the whole data.json from disk again;
// a single sync cycle read it about 93 times. This plugin is the only writer,
// so the blob it last read or wrote is what is on disk.
describe('PluginDataMutex cache (P4)', () => {
  it('reads data.json from disk once, then serves loads and updates from memory', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);

    await mutex.load();
    await mutex.update((base) => ({ ...base, a: 1 }));
    const loaded = await mutex.load();

    expect(loaded).toEqual({ a: 1 });
    expect(access.loads).toBe(1);
    expect(access.snapshot()).toEqual({ a: 1 });
  });

  it('never lets a caller change the cached blob by mutating what it loaded', async () => {
    const mutex = new PluginDataMutex(new FakeAccess());
    const loaded = await mutex.load();
    loaded.stray = true;
    expect(await mutex.load()).toEqual({});
  });

  it('keeps the previous blob when a save fails', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);
    await mutex.update(() => ({ a: 1 }));
    access.saveData = async () => {
      throw new Error('disk full');
    };
    await expect(mutex.update(() => ({ a: 2 }))).rejects.toThrow('disk full');
    expect(await mutex.load()).toEqual({ a: 1 });
  });

  it('reads the disk again after an external change', async () => {
    const access = new FakeAccess();
    const mutex = new PluginDataMutex(access);
    await mutex.load();
    await access.saveData({ fromElsewhere: true });

    mutex.invalidate();

    expect(await mutex.load()).toEqual({ fromElsewhere: true });
    expect(access.loads).toBe(2);
  });
});
