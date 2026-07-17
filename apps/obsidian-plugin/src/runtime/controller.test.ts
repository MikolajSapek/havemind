import { describe, expect, it } from 'vitest';

import { HavemindSyncController, type SyncRunnerLike } from './controller';
import type { SchedulerHooks } from './scheduler';
import type { StatusBarView } from './status';
import type { SyncCycleResult } from '../sync/sync-runner';

const CLEAN: SyncCycleResult = {
  status: 'synced',
  pushed: 0,
  applied: 0,
  suppressed: 0,
  conflicts: 0,
  deferred: 0,
  quarantined: 0,
};

class FakeRunner implements SyncRunnerLike {
  triggerCount = 0;
  result: SyncCycleResult = CLEAN;

  async trigger(): Promise<SyncCycleResult> {
    this.triggerCount += 1;
    return this.result;
  }
}

class FakeHooks implements SchedulerHooks {
  focus: (() => void) | null = null;
  online: (() => void) | null = null;
  interval: { run: () => void; ms: number } | null = null;

  onFocus(run: () => void): () => void {
    this.focus = run;
    return () => undefined;
  }

  onOnline(run: () => void): () => void {
    this.online = run;
    return () => undefined;
  }

  setInterval(run: () => void, ms: number): () => void {
    this.interval = { run, ms };
    return () => undefined;
  }
}

function build(): {
  controller: HavemindSyncController;
  runner: FakeRunner;
  hooks: FakeHooks;
  statuses: StatusBarView[];
} {
  const runner = new FakeRunner();
  const hooks = new FakeHooks();
  const statuses: StatusBarView[] = [];
  const controller = new HavemindSyncController({
    runner,
    hooks,
    intervalMs: 60_000,
    onStatus: (_status, view) => statuses.push(view),
    now: () => 1_000,
  });
  return { controller, runner, hooks, statuses };
}

describe('HavemindSyncController', () => {
  it('reports syncing then the resolved connection status on a manual sync', async () => {
    const { controller, statuses } = build();
    await controller.syncNow();
    expect(statuses.map((view) => view.text)).toEqual([
      'Havemind: syncing',
      'Havemind: Synced',
    ]);
  });

  it('maps a conflict cycle onto the Conflict status', async () => {
    const { controller, runner, statuses } = build();
    runner.result = { ...CLEAN, status: 'conflict', conflicts: 1 };
    await controller.syncNow();
    expect(statuses.at(-1)?.text).toBe('Havemind: Conflict');
  });

  it('triggers a sync on startup and drives the interval schedule', async () => {
    const { controller, runner, hooks } = build();
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.triggerCount).toBe(1); // startup
    expect(hooks.interval?.ms).toBe(60_000);

    hooks.interval?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.triggerCount).toBe(2);
  });

  it('stops the schedule so later events cannot trigger a sync', async () => {
    const { controller, runner, hooks } = build();
    controller.start();
    await Promise.resolve();
    controller.stop();
    hooks.focus?.();
    await Promise.resolve();
    expect(runner.triggerCount).toBe(1);
  });

  const OFFLINE: SyncCycleResult = { ...CLEAN, status: 'offline' };

  it('does not latch Offline on a single transient failure — shows a retrying state', () => {
    const { controller, statuses } = build();
    // One blip: the status must be a brief retrying state, never "Offline".
    controller.observeCycle(OFFLINE);
    expect(statuses.at(-1)?.text).toBe('Havemind: syncing');
    expect(statuses.at(-1)?.text).not.toBe('Havemind: Offline');
  });

  it('recovers to Synced on the next successful cycle after a failure', () => {
    const { controller, statuses } = build();
    controller.observeCycle(OFFLINE);
    controller.observeCycle(CLEAN);
    expect(statuses.at(-1)?.text).toBe('Havemind: Synced');
  });

  it('recovers to Synced from a sustained Offline once a later cycle succeeds', () => {
    const { controller, statuses } = build();
    // Sustained loss reaches Offline, but a background (backoff-driven) cycle
    // that succeeds must clear it — status follows the LATEST cycle, not a flag.
    controller.observeCycle(OFFLINE);
    controller.observeCycle(OFFLINE);
    controller.observeCycle(OFFLINE);
    expect(statuses.at(-1)?.text).toBe('Havemind: Offline');
    controller.observeCycle(CLEAN);
    expect(statuses.at(-1)?.text).toBe('Havemind: Synced');
  });

  it('shows Offline only after several consecutive failures', () => {
    const { controller, statuses } = build();
    controller.observeCycle(OFFLINE);
    controller.observeCycle(OFFLINE);
    expect(statuses.at(-1)?.text).toBe('Havemind: syncing');
    controller.observeCycle(OFFLINE);
    expect(statuses.at(-1)?.text).toBe('Havemind: Offline');
  });

  it('ignores a stale duplicate cycle so status follows the latest outcome', () => {
    const { controller, statuses } = build();
    controller.observeCycle({ ...CLEAN, cycleId: 5 });
    expect(statuses.at(-1)?.text).toBe('Havemind: Synced');
    // A late, lower-id cycle (e.g. a coalesced/backoff duplicate) must not
    // override the newer outcome.
    controller.observeCycle({ ...OFFLINE, cycleId: 4 });
    expect(statuses.at(-1)?.text).toBe('Havemind: Synced');
  });

  it('halts the loop on an unauthenticated cycle — no 401 retry storm', async () => {
    const { controller, runner, hooks, statuses } = build();
    runner.result = { ...CLEAN, status: 'unauthenticated' };

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.triggerCount).toBe(1);
    expect(statuses.at(-1)?.text).toBe('Havemind: Reconnect required');

    // Further schedule events must not fire another request until reconnect.
    hooks.focus?.();
    hooks.interval?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.triggerCount).toBe(1);
  });
});
