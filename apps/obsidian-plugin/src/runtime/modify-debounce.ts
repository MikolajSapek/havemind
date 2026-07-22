/**
 * A per-path settling window between a vault `modify` event and the producer's
 * hash/enqueue for that path (AUD-03, PART 3).
 *
 * Obsidian fires a `modify` event the instant a file changes on disk. When a
 * formatter plugin (Linter "format on save", Prettier-for-Obsidian) rewrites a
 * note immediately after Havemind's own apply, the naive path hashes the note
 * mid-rewrite and pushes a spurious revision; two devices with different
 * formatter settings then oscillate forever. Debouncing each modify by a short
 * window — reset on every further modify to the SAME path — means the note is
 * hashed once, after it settles, reading its final content.
 *
 * Only `modify` is debounced. Create/rename/delete are ordering-sensitive and
 * must fire immediately (a rename or delete reorders around a modify), so they
 * never pass through here.
 *
 * The timer is injected (`DebounceTimer`) so tests drive it deterministically
 * with a fake clock — the same injected-timer idiom the scheduler uses — and
 * `dispose()` clears every pending timer on unload/re-pair, mirroring the
 * producer's listener-teardown contract.
 */

/** The exported settling window: modifies within this window coalesce to one. */
export const MODIFY_SETTLE_MS = 1500;

/** Minimal timer seam; production wraps `setTimeout`/`clearTimeout`. */
export interface DebounceTimer {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface ModifyDebouncerOptions {
  /** Invoked once per path after it has settled for `delayMs`. */
  readonly onSettled: (path: string) => void;
  /** Settling window; defaults to `MODIFY_SETTLE_MS`. */
  readonly delayMs?: number;
  /** Timer seam; defaults to the real `setTimeout`/`clearTimeout`. */
  readonly timer?: DebounceTimer;
}

/** The default real-clock timer (browser/Obsidian and Node both accepted). */
const realTimer: DebounceTimer = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clear: (handle) => {
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

export class ModifyDebouncer {
  private readonly onSettled: (path: string) => void;
  private readonly delayMs: number;
  private readonly timer: DebounceTimer;
  private readonly pending = new Map<string, number>();

  constructor(options: ModifyDebouncerOptions) {
    this.onSettled = options.onSettled;
    this.delayMs = options.delayMs ?? MODIFY_SETTLE_MS;
    this.timer = options.timer ?? realTimer;
  }

  /**
   * Records a modify for `path`, resetting any in-flight settle window for that
   * same path so only the LAST modify in a burst reaches `onSettled`.
   */
  trigger(path: string): void {
    const existing = this.pending.get(path);
    if (existing !== undefined) {
      this.timer.clear(existing);
    }
    const handle = this.timer.set(() => {
      this.pending.delete(path);
      this.onSettled(path);
    }, this.delayMs);
    this.pending.set(path, handle);
  }

  /**
   * Cancels the pending settle for a single `path`, if any. Called when a
   * rename or delete for that path fires: those events carry their own content
   * (or tombstone) immediately, so a later settled modify for the same path
   * would resolve against a file that has moved or gone — reading '' for the
   * missing path and pushing a phantom empty create. A no-op when nothing is
   * pending for `path`.
   */
  cancel(path: string): void {
    const existing = this.pending.get(path);
    if (existing !== undefined) {
      this.timer.clear(existing);
      this.pending.delete(path);
    }
  }

  /** Cancels every pending settle. Called on producer teardown/unload. */
  dispose(): void {
    for (const handle of this.pending.values()) {
      this.timer.clear(handle);
    }
    this.pending.clear();
  }
}
