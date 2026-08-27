/**
 * SND-02, commit-path failure recovery ("nothing silently dropped").
 *
 * The push producer's settle-time chain (`observeModify` → `commitLocalChange`)
 * can reject for reasons other than an oversized payload: a transient
 * `readText` failure, a `saveData` rejection inside enqueue. Before this module
 * that rejection was swallowed, no Notice, no row, and (because the modify
 * debouncer deletes the pending entry before firing) no re-trigger, so the edit
 * was lost until the file was touched again.
 *
 * This tracker gives every failing path exactly one bounded second chance:
 *  - FIRST failure for a path: surface a Notice and RE-ARM the settle window
 *    (re-run the commit chain once more), most transient failures clear.
 *  - SECOND consecutive failure: surface a Notice and record a DURABLE
 *    `failed-to-queue` entry so the send-queue panel shows it with the same
 *    Retry/Discard affordances as a server-rejected send (SND-01 machinery).
 *  - A SUCCESS resets the budget, so an unrelated later failure re-arms again.
 *
 * Pure and dependency-injected: the Notice, the re-arm, and the durable record
 * are all supplied by the caller so the whole policy is unit-testable without
 * Obsidian or the sync state.
 */

export interface CommitPathRecoveryDeps {
  /** Surface a user-visible message (production wraps `new Notice`). */
  readonly notify: (message: string) => void;
  /** Re-arm the settle window for `path` so the commit chain runs once more. */
  readonly rearm: (path: string) => void;
  /** Durably record a `failed-to-queue` entry for the send-queue panel. */
  readonly recordFailedToQueue: (path: string) => Promise<void>;
  /**
   * Discard any durable `failed-to-queue` row for `path` (MAJOR 1). Called on a
   * later successful commit for the same path so a stale row, recorded by an
   * earlier transient failure, cannot survive as a phantom failure once the
   * change has actually gone through. A no-op when no such row exists.
   */
  readonly clearFailedToQueue: (path: string) => void;
}

export class CommitPathRecovery {
  private readonly deps: CommitPathRecoveryDeps;
  /** Paths that have failed once and been re-armed (awaiting their retry). */
  private readonly rearmed = new Set<string>();

  constructor(deps: CommitPathRecoveryDeps) {
    this.deps = deps;
  }

  /**
   * Handle a commit-path failure for `path`. The first failure re-arms; a
   * second consecutive failure records a durable failed-to-queue entry. Never
   * throws, recovery must not itself wedge the change loop.
   */
  async onCommitFailure(path: string): Promise<void> {
    if (!this.rearmed.has(path)) {
      this.rearmed.add(path);
      this.deps.notify(
        `A change to ${path} could not be queued, will retry.`,
      );
      this.deps.rearm(path);
      return;
    }
    // The re-armed retry also failed. Stop retrying and record it durably so
    // it is visible and recoverable rather than silently dropped.
    this.rearmed.delete(path);
    this.deps.notify(
      `A change to ${path} could not be queued, see the Havemind panel.`,
    );
    await this.deps.recordFailedToQueue(path);
  }

  /**
   * Note a successful commit for `path`: reset its in-memory retry budget AND
   * discard any durable failed-to-queue row an earlier failure left behind
   * (MAJOR 1), so a change that ultimately went through never lingers as a
   * phantom failure in the send-queue panel.
   */
  onCommitSuccess(path: string): void {
    this.rearmed.delete(path);
    this.deps.clearFailedToQueue(path);
  }
}

/**
 * The three distinguishable outcomes of retrying a failed-to-queue row
 * (MAJOR 2 / FINDING 1). A single boolean conflated the last two, a vanished
 * file (drop the row) with a debouncer that no-op'd the re-trigger because it
 * was disposed (offline/torn-down producer). Only `file-missing` is a confirmed
 * loss; `unavailable` means the retry could not run and the row must be kept.
 */
export type RetryFailedCommitOutcome =
  | 'retriggered'
  | 'file-missing'
  | 'unavailable';

/**
 * Retry a failed-to-queue row (MAJOR 2). Such a row has no stashed envelope,
 * it never reached the outbox, so the only recovery is to re-run the commit
 * chain against the current on-disk content (the source of truth). Returns:
 *  - `'file-missing'` when the path is gone (the ONLY confirmed-loss case): the
 *    caller surfaces it and drops the stale row rather than pushing a phantom
 *    empty create for a vanished file;
 *  - `'unavailable'` when the file exists but the injected `retrigger` did NOT
 *    schedule anything (the debouncer is disposed, producer torn down /
 *    offline, FINDING 3): the retry never ran, so the caller keeps the row;
 *  - `'retriggered'` when the commit chain was re-armed exactly once through the
 *    injected `retrigger` (the same debouncer-trigger the bounded re-arm uses).
 */
export function retryFailedCommit(
  path: string,
  deps: {
    readonly exists: (path: string) => boolean;
    /** Re-arm the settle window; returns whether it actually scheduled. */
    readonly retrigger: (path: string) => boolean;
  },
): RetryFailedCommitOutcome {
  if (!deps.exists(path)) return 'file-missing';
  return deps.retrigger(path) ? 'retriggered' : 'unavailable';
}
