/**
 * Caches the conflict-copy scan between vault changes.
 *
 * `listConflictCopies` starts with `vault.getFiles()` over the whole vault. The
 * pane reads it twice per render, once for the conflicts section and once for
 * the attention count, and a repaint can happen many times a second while sync
 * catches up. Conflicts, meanwhile, change only when a file appears, vanishes
 * or is renamed.
 *
 * Invalidated by vault events, never by a timer. A timer would either rescan
 * too often, which is the cost this exists to remove, or serve a stale list at
 * the moment a conflict appears. A conflict the user cannot see is the one
 * failure this plugin must not have (`plan/01` rule 4, no silent overwrites).
 */

import type { ConflictCopy } from './conflict-resolution';

export class CachedConflictList {
  private cached: readonly ConflictCopy[] | null = null;

  public constructor(private readonly scan: () => readonly ConflictCopy[]) {}

  /** The current list, scanning only if the vault has moved since the last read. */
  public read(): readonly ConflictCopy[] {
    if (this.cached !== null) return this.cached;
    // Deliberately not wrapped: a scan that throws must not be cached as an
    // empty list, because that would hide conflicts until the pane reloads.
    // The caller's own guard decides what a failed read looks like on screen.
    const fresh = this.scan();
    this.cached = fresh;
    return fresh;
  }

  /** Drops the cached list; the next read rescans. */
  public invalidate(): void {
    this.cached = null;
  }
}
