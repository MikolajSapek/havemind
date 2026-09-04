/**
 * Gathers repaint requests so a burst costs one render.
 *
 * 36 call sites ask the pane to repaint, and every repaint reads the conflict
 * provider, which scans the whole vault. On a desktop that is invisible; on a
 * phone, catching up after a reconnect fires those events in bursts and the
 * pane freezes mid-tap.
 *
 * Two entry points, deliberately:
 *
 *  - `request()` coalesces. Right for events arriving FROM the server, where
 *    nobody is waiting on a particular frame.
 *  - `now()` runs at once. Right for a change the user just caused by tapping
 *    something, where somebody is.
 */

/**
 * How long requests are gathered before one render runs. Short enough to read
 * as instant, long enough that a burst costs one vault scan rather than dozens.
 */
export const REPAINT_WINDOW_MS = 50;

export class RepaintScheduler {
  private pending: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  public constructor(private readonly render: () => void) {}

  /** Queues a repaint, folding into one already queued. */
  public request(): void {
    if (this.stopped || this.pending !== null) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (!this.stopped) this.render();
    }, REPAINT_WINDOW_MS);
  }

  /** Repaints immediately, dropping anything queued. */
  public now(): void {
    this.cancel();
    if (!this.stopped) this.render();
  }

  /**
   * Permanently quiesces the scheduler. A repaint queued a moment before the
   * pane closed would otherwise write into a dead DOM.
   */
  public stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.pending === null) return;
    clearTimeout(this.pending);
    this.pending = null;
  }
}
