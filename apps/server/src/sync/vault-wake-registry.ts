/**
 * In-memory per-vault wake registry backing the real-time push (`GET /wait`)
 * long-poll. A held request subscribes with a callback; when a peer commits at
 * least one revision to that vault, the push route calls `notify` with the new
 * cursor, which resolves and clears exactly that vault's held requests. This
 * shrinks the sync conflict window from the poll interval (~15 s) to ~1 s.
 *
 * The registry is deliberately opaque: it moves only a monotonic cursor
 * integer, never content, diff, or actor identity.
 *
 * // ponytail: single-process, in-memory Map is the correct ceiling for a
 * // 2-3 user server. There is no cross-process fan-out here: `notify` only
 * // reaches waiters registered in THIS process. If the server ever runs more
 * // than one process/replica, swap this class for a real pub/sub fan-out
 * // (e.g. Postgres LISTEN/NOTIFY, or a shared bus) so a commit on one process
 * // wakes waiters on another, NOT Redis or a dedicated message broker, which
 * // this project explicitly forbids adding.
 */
export type VaultWakeListener = (cursor: number) => void;

export class VaultWakeRegistry {
  readonly #waitersByVault = new Map<string, Set<VaultWakeListener>>();

  /**
   * Registers a held request's wake callback for a vault. Returns an idempotent
   * unsubscribe the caller MUST invoke on resolve, timeout or client abort so
   * an abandoned waiter never leaks.
   */
  public subscribe(vaultId: string, onWake: VaultWakeListener): () => void {
    let waiters = this.#waitersByVault.get(vaultId);
    if (waiters === undefined) {
      waiters = new Set<VaultWakeListener>();
      this.#waitersByVault.set(vaultId, waiters);
    }
    waiters.add(onWake);

    return (): void => {
      const current = this.#waitersByVault.get(vaultId);
      if (current === undefined) {
        return;
      }
      current.delete(onWake);
      if (current.size === 0) {
        this.#waitersByVault.delete(vaultId);
      }
    };
  }

  /**
   * Wakes and clears every waiter currently held for `vaultId`, handing each
   * the new cursor. Other vaults are untouched; a second call with no new
   * subscribers is a no-op.
   */
  public notify(vaultId: string, cursor: number): void {
    const waiters = this.#waitersByVault.get(vaultId);
    if (waiters === undefined) {
      return;
    }
    // Snapshot then clear before invoking so a listener that re-subscribes
    // during its own wake registers a fresh waiter rather than being cleared.
    const listeners = [...waiters];
    this.#waitersByVault.delete(vaultId);
    for (const onWake of listeners) {
      onWake(cursor);
    }
  }

  /** Number of held waiters for a vault. Exposed for leak assertions in tests. */
  public pendingCount(vaultId: string): number {
    return this.#waitersByVault.get(vaultId)?.size ?? 0;
  }
}
