/**
 * A per-key async mutex: one serial promise-chain per key, distinct keys run
 * concurrently.
 *
 * Rule 3 (zero silent overwrites) has an on-disk overwrite guard in
 * `vault-apply.ts` that reads a file, decides, then writes. Between that read
 * and the write the LOCAL change producer (the vault observer → hash → outbox
 * enqueue) could observe and record a concurrent local edit to the SAME file,
 * so a naive apply would clobber a revision the producer just captured. Routing
 * both remote apply AND the producer's per-file observe through ONE shared
 * KeyedMutex — keyed by the file's canonical collision key — means a single file
 * can never be produced and applied at the same time: the two critical sections
 * for one key run strictly one-after-another, while unrelated files still sync
 * in parallel (no global lock).
 *
 * The registry drops a key as soon as its chain drains, so a long-lived vault
 * never accumulates one entry per file ever touched.
 */

function noop(): void {
  /* swallow settlement outcome; callers observe their own task's result */
}

export interface KeyedLock {
  /**
   * Runs `task` exclusively for `key`: it starts only after every previously
   * enqueued task for the same key has settled, and any task enqueued for that
   * key afterwards waits for this one. Tasks under different keys never block
   * each other. The task's resolution (or rejection) is passed straight back to
   * the caller; a rejection never wedges the next task on the key.
   */
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export class KeyedMutex implements KeyedLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Chain after the previous link regardless of its outcome, so one caller's
    // rejection never skips or wedges the next critical section for this key.
    const run = previous.then(task, task);
    const settled = run.then(noop, noop);
    this.chains.set(key, settled);
    // Drop the key once this link drains AND nothing newer has taken the tail,
    // keeping the registry bounded by the number of IN-FLIGHT keys.
    void settled.then(() => {
      if (this.chains.get(key) === settled) {
        this.chains.delete(key);
      }
    });
    return run;
  }

  /** Number of keys with an in-flight or not-yet-drained chain (for tests). */
  size(): number {
    return this.chains.size;
  }
}
