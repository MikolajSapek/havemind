/**
 * Sync scheduler wiring per `plan/05-plugin-polaczenie-i-sync.md`:
 * a sync is triggered on startup, on window focus, on regaining network and on
 * a periodic interval. Every trigger funnels into the runner's single-flight
 * entry point, so overlapping schedules coalesce rather than racing.
 *
 * The scheduler talks only to an injected `SchedulerHooks` boundary (wrapping
 * Obsidian workspace/DOM events and `registerInterval` in production), which
 * keeps the schedule logic unit-testable and free of platform globals. After
 * `stop()` no scheduled callback fires again.
 */

export interface SchedulerHooks {
  /** Registers a focus listener; returns a disposer. */
  onFocus(run: () => void): () => void;
  /** Registers an online/network-regained listener; returns a disposer. */
  onOnline(run: () => void): () => void;
  /** Registers a periodic timer; returns a disposer. */
  setInterval(run: () => void, ms: number): () => void;
}

export interface SyncSchedulerOptions {
  readonly trigger: () => void;
  readonly hooks: SchedulerHooks;
  readonly intervalMs: number;
}

export class SyncScheduler {
  private readonly options: SyncSchedulerOptions;
  private disposers: Array<() => void> = [];
  private running = false;

  constructor(options: SyncSchedulerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const fire = (): void => {
      if (this.running) this.options.trigger();
    };

    // Startup: production calls `start()` from `workspace.onLayoutReady`, so the
    // first trigger fires as soon as the schedule is armed.
    fire();
    this.disposers.push(this.options.hooks.onFocus(fire));
    this.disposers.push(this.options.hooks.onOnline(fire));
    this.disposers.push(
      this.options.hooks.setInterval(fire, this.options.intervalMs),
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }
}
