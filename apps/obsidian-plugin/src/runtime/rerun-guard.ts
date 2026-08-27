/**
 * Serialises an async task that must never overlap itself, while guaranteeing a
 * trigger that arrives WHILE the task is running is not dropped.
 *
 * MINOR (conflict sweep): a conflict copy written while `runConflictSweep()` was
 * already in flight hit the "already running" guard and returned a no-op,
 * nothing re-scheduled it, so that copy was never swept. This guard instead
 * records a pending flag on a mid-run trigger and re-runs the task once the
 * in-flight pass finishes, so the late-arriving work is always picked up.
 */
export class RerunGuard {
  private readonly runOnce: () => Promise<void>;
  private running = false;
  private pending = false;

  constructor(runOnce: () => Promise<void>) {
    this.runOnce = runOnce;
  }

  /**
   * Run the task. If it is already running, mark a re-run and return; the
   * in-flight pass loops once more when it finishes. Resolves when no further
   * re-run is pending.
   */
  async trigger(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.runOnce();
      } while (this.pending);
    } finally {
      this.running = false;
    }
  }
}
