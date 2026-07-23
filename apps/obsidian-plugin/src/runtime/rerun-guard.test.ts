import { describe, expect, it } from 'vitest';

import { RerunGuard } from './rerun-guard';

/** A manually-resolvable task so a trigger can arrive mid-run deterministically. */
function deferredTask(): {
  run: () => Promise<void>;
  runs: number;
  releaseNext: () => void;
} {
  let releaseCurrent: (() => void) | null = null;
  const state = {
    runs: 0,
    run(): Promise<void> {
      state.runs += 1;
      return new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
    },
    releaseNext(): void {
      const release = releaseCurrent;
      releaseCurrent = null;
      release?.();
    },
  };
  return state;
}

describe('RerunGuard (MINOR: conflict sweep re-arm)', () => {
  it('re-runs the task when a trigger arrives while it is running', async () => {
    const task = deferredTask();
    const guard = new RerunGuard(task.run);

    const first = guard.trigger();
    // Let the first run start and suspend inside runOnce.
    await Promise.resolve();
    expect(task.runs).toBe(1);

    // A second trigger arrives mid-run: it must NOT drop — it re-arms a re-run.
    void guard.trigger();
    task.releaseNext(); // first run finishes → loop re-runs runOnce
    await Promise.resolve();
    expect(task.runs).toBe(2);

    task.releaseNext(); // second run finishes → no pending, loop exits
    await first;
    expect(task.runs).toBe(2);
  });

  it('does not overlap runs and coalesces multiple mid-run triggers into one', async () => {
    const task = deferredTask();
    const guard = new RerunGuard(task.run);

    const first = guard.trigger();
    await Promise.resolve();
    expect(task.runs).toBe(1);

    // Several triggers during the same run collapse into a single re-run.
    void guard.trigger();
    void guard.trigger();
    void guard.trigger();

    task.releaseNext();
    await Promise.resolve();
    expect(task.runs).toBe(2);

    task.releaseNext();
    await first;
    expect(task.runs).toBe(2);
  });
});
