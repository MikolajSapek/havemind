import { describe, expect, it } from 'vitest';

import { SyncScheduler, type SchedulerHooks } from './scheduler';

class FakeHooks implements SchedulerHooks {
  focus: (() => void) | null = null;
  online: (() => void) | null = null;
  interval: { run: () => void; ms: number } | null = null;
  disposed = 0;

  onFocus(run: () => void): () => void {
    this.focus = run;
    return () => {
      this.disposed += 1;
    };
  }

  onOnline(run: () => void): () => void {
    this.online = run;
    return () => {
      this.disposed += 1;
    };
  }

  setInterval(run: () => void, ms: number): () => void {
    this.interval = { run, ms };
    return () => {
      this.disposed += 1;
    };
  }
}

describe('SyncScheduler', () => {
  it('triggers a sync on startup, focus, online and interval', () => {
    const hooks = new FakeHooks();
    let triggers = 0;
    const scheduler = new SyncScheduler({
      trigger: () => {
        triggers += 1;
      },
      hooks,
      intervalMs: 300_000,
    });

    scheduler.start();
    expect(triggers).toBe(1); // startup
    expect(hooks.interval?.ms).toBe(300_000);

    hooks.focus?.();
    hooks.online?.();
    hooks.interval?.run();
    expect(triggers).toBe(4);
  });

  it('disposes every registration on stop and is idempotent', () => {
    const hooks = new FakeHooks();
    const scheduler = new SyncScheduler({
      trigger: () => undefined,
      hooks,
      intervalMs: 1000,
    });
    scheduler.start();
    scheduler.stop();
    expect(hooks.disposed).toBe(3); // focus + online + interval
    scheduler.stop();
    expect(hooks.disposed).toBe(3);
  });

  it('re-arms the interval at a new cadence, disposing the previous timer', () => {
    const hooks = new FakeHooks();
    let triggers = 0;
    const scheduler = new SyncScheduler({
      trigger: () => {
        triggers += 1;
      },
      hooks,
      intervalMs: 15_000,
    });
    scheduler.start();
    expect(hooks.interval?.ms).toBe(15_000);

    scheduler.setIntervalMs(60_000);
    // The previous interval disposer fired exactly once, and the timer is
    // re-registered at the new cadence.
    expect(hooks.disposed).toBe(1);
    expect(hooks.interval?.ms).toBe(60_000);

    // The re-armed interval still funnels into the trigger.
    triggers = 0;
    hooks.interval?.run();
    expect(triggers).toBe(1);
  });

  it('remembers a cadence set before start and applies it on start', () => {
    const hooks = new FakeHooks();
    const scheduler = new SyncScheduler({
      trigger: () => undefined,
      hooks,
      intervalMs: 15_000,
    });
    scheduler.setIntervalMs(60_000); // before start: no timer exists yet
    expect(hooks.interval).toBeNull();
    scheduler.start();
    expect(hooks.interval?.ms).toBe(60_000);
  });

  it('ignores triggers fired after stop', () => {
    const hooks = new FakeHooks();
    let triggers = 0;
    const scheduler = new SyncScheduler({
      trigger: () => {
        triggers += 1;
      },
      hooks,
      intervalMs: 1000,
    });
    scheduler.start();
    scheduler.stop();
    hooks.focus?.();
    expect(triggers).toBe(1); // only the startup trigger
  });
});
