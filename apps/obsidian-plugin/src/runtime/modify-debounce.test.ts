import { describe, expect, it } from 'vitest';

import {
  MODIFY_SETTLE_MS,
  ModifyDebouncer,
  type DebounceTimer,
} from './modify-debounce';

/** Deterministic fake timer: no wall clock, advance() drives due callbacks. */
class FakeTimer implements DebounceTimer {
  private seq = 0;
  private now = 0;
  private readonly tasks = new Map<number, { at: number; cb: () => void }>();

  set(callback: () => void, ms: number): number {
    const handle = (this.seq += 1);
    this.tasks.set(handle, { at: this.now + ms, cb: callback });
    return handle;
  }

  clear(handle: number): void {
    this.tasks.delete(handle);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(handle);
        task.cb();
      }
    }
  }
}

describe('ModifyDebouncer', () => {
  it('collapses two rapid modifies to the same path into one settled call', () => {
    // Arrange
    const timer = new FakeTimer();
    const settled: string[] = [];
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => settled.push(path),
      delayMs: MODIFY_SETTLE_MS,
      timer,
    });

    // Act: two modifies within the settle window, then let it settle.
    debouncer.trigger('Notes/Plan.md');
    timer.advance(500);
    debouncer.trigger('Notes/Plan.md');
    timer.advance(MODIFY_SETTLE_MS - 1);

    // Assert: the first timer was reset, so nothing has fired yet.
    expect(settled).toEqual([]);

    timer.advance(1);
    expect(settled).toEqual(['Notes/Plan.md']);
  });

  it('settles distinct paths independently', () => {
    // Arrange
    const timer = new FakeTimer();
    const settled: string[] = [];
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => settled.push(path),
      delayMs: MODIFY_SETTLE_MS,
      timer,
    });

    // Act: a modify to B while A is still settling must not disturb A.
    debouncer.trigger('A.md');
    timer.advance(1000);
    debouncer.trigger('B.md');
    timer.advance(500); // A now at 1500 → fires; B at 1500 has 1000 to go.

    // Assert
    expect(settled).toEqual(['A.md']);

    timer.advance(1000); // B reaches its window.
    expect(settled).toEqual(['A.md', 'B.md']);
  });

  it('cancels all pending settles on dispose', () => {
    // Arrange
    const timer = new FakeTimer();
    const settled: string[] = [];
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => settled.push(path),
      delayMs: MODIFY_SETTLE_MS,
      timer,
    });

    // Act
    debouncer.trigger('A.md');
    debouncer.dispose();
    timer.advance(MODIFY_SETTLE_MS * 2);

    // Assert
    expect(settled).toEqual([]);
  });

  it('defaults the settle window to 1500 ms', () => {
    expect(MODIFY_SETTLE_MS).toBe(1500);
  });

  it('cancels the pending settle for a single path without disturbing others', () => {
    // A rename/delete of a path must cancel that path's in-flight modify so a
    // stale settled modify never fires after the file has moved or gone.
    const timer = new FakeTimer();
    const settled: string[] = [];
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => settled.push(path),
      delayMs: MODIFY_SETTLE_MS,
      timer,
    });

    debouncer.trigger('A.md');
    debouncer.trigger('B.md');
    debouncer.cancel('A.md');
    timer.advance(MODIFY_SETTLE_MS);

    expect(settled).toEqual(['B.md']);
  });

  it('cancel is a no-op for a path with no pending settle', () => {
    const timer = new FakeTimer();
    const settled: string[] = [];
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => settled.push(path),
      timer,
    });

    expect(() => debouncer.cancel('none.md')).not.toThrow();
    timer.advance(MODIFY_SETTLE_MS);
    expect(settled).toEqual([]);
  });
});
