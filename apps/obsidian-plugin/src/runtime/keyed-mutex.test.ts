import { describe, expect, it } from 'vitest';

import { KeyedMutex } from './keyed-mutex';

/** A manually-resolved promise, so a test can hold a critical section open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('KeyedMutex', () => {
  it('serialises tasks that share a key (the second waits for the first)', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const gate = deferred();

    const first = mutex.runExclusive('file-1', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = mutex.runExclusive('file-1', async () => {
      order.push('second:start');
    });

    // Let microtasks flush: the second task must NOT have started while the
    // first still holds the key.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs tasks with different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const gate = deferred();

    const a = mutex.runExclusive('file-a', async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
    });
    const b = mutex.runExclusive('file-b', async () => {
      order.push('b:start');
    });

    // Different keys: b must proceed even though a is still holding file-a.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start', 'b:start']);

    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'b:start', 'a:end']);
  });

  it('returns the task result', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => 42)).resolves.toBe(42);
  });

  it('a rejecting task never wedges the next task on the same key', async () => {
    const mutex = new KeyedMutex();
    const rejected = mutex.runExclusive('file-1', async () => {
      throw new Error('boom');
    });
    await expect(rejected).rejects.toThrow('boom');

    const order: string[] = [];
    await mutex.runExclusive('file-1', async () => {
      order.push('ran');
    });
    expect(order).toEqual(['ran']);
  });

  it('does not grow its key registry without bound (settled keys drop out)', async () => {
    const mutex = new KeyedMutex();
    await mutex.runExclusive('file-1', async () => undefined);
    await mutex.runExclusive('file-2', async () => undefined);
    // The registry drop runs a microtask after each chain settles; flush.
    await Promise.resolve();
    await Promise.resolve();
    // Both chains settled and were the tail, so nothing lingers.
    expect(mutex.size()).toBe(0);
  });
});
