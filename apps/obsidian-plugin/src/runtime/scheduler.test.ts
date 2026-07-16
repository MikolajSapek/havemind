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
