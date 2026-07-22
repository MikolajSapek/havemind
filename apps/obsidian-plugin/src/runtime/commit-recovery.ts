/**
 * SND-02 — commit-path failure recovery ("nothing silently dropped").
 *
 * The push producer's settle-time chain (`observeModify` → `commitLocalChange`)
 * can reject for reasons other than an oversized payload: a transient
 * `readText` failure, a `saveData` rejection inside enqueue. Before this module
 * that rejection was swallowed — no Notice, no row, and (because the modify
 * debouncer deletes the pending entry before firing) no re-trigger, so the edit
 * was lost until the file was touched again.
 *
 * This tracker gives every failing path exactly one bounded second chance:
 *  - FIRST failure for a path: surface a Notice and RE-ARM the settle window
 *    (re-run the commit chain once more) — most transient failures clear.
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
   * throws — recovery must not itself wedge the change loop.
   */
  async onCommitFailure(path: string): Promise<void> {
    if (!this.rearmed.has(path)) {
      this.rearmed.add(path);
      this.deps.notify(
        `A change to ${path} could not be queued — will retry.`,
      );
      this.deps.rearm(path);
      return;
    }
    // The re-armed retry also failed. Stop retrying and record it durably so
    // it is visible and recoverable rather than silently dropped.
    this.rearmed.delete(path);
    this.deps.notify(
      `A change to ${path} could not be queued — see the Havemind panel.`,
    );
    await this.deps.recordFailedToQueue(path);
  }

  /** Note a successful commit for `path`, clearing its retry budget. */
  onCommitSuccess(path: string): void {
    this.rearmed.delete(path);
  }
}
