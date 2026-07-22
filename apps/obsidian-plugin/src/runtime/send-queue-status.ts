/**
 * SND-01 — send-queue visibility ("no silent send failures").
 *
 * Turns the durable outbox + quarantine bookkeeping (persisted in
 * `DurableSyncState`) into a small view model the panel renders. Two signals:
 *  - WAITING: outbox items that have been queued longer than a staleness
 *    threshold (~30s). A healthy outbox drains in a cycle or two, so a stale
 *    item means sends are stuck (offline/backoff) — worth surfacing quietly.
 *  - FAILED: quarantined items (a permanent server rejection or a push that
 *    permanently failed). These never retry on their own, so they are surfaced
 *    with a per-item reason and Retry/Discard affordances.
 *
 * Pure and dependency-free: `main.ts` reads the outbox ages + quarantine through
 * the existing sync-state accessors and hands them here — no parallel store.
 */

/** An outbox entry with the wall-clock time it was enqueued (SND-01). */
export interface OutboxAgeEntry {
  readonly revisionId: string;
  readonly enqueuedAt: number;
}

/** A quarantined (dead-lettered) send, optionally resolved to a vault path. */
export interface QuarantineViewEntry {
  readonly revisionId: string;
  readonly fileId: string;
  readonly reason: string;
  /** Vault path when the fileId still maps to one, else absent. */
  readonly path?: string;
}

export interface SendQueueStatusInput {
  readonly outbox: readonly OutboxAgeEntry[];
  readonly quarantine: readonly QuarantineViewEntry[];
  readonly now: number;
  /** Age past which a still-queued item counts as "waiting". Defaults to 30s. */
  readonly staleThresholdMs?: number;
}

/** One rendered failed-send row: a display label plus the failure reason. */
export interface SendQueueFailedRow {
  readonly revisionId: string;
  /** Human-facing identifier — the vault path when known, else the fileId. */
  readonly label: string;
  readonly reason: string;
}

export interface SendQueueStatusView {
  /** Count of outbox items older than the staleness threshold. */
  readonly waitingCount: number;
  /** Quarantined sends, each with a Retry/Discard affordance in the panel. */
  readonly failed: readonly SendQueueFailedRow[];
}

const DEFAULT_STALE_THRESHOLD_MS = 30_000;

/**
 * Builds the send-queue view. `waitingCount` counts only outbox items that have
 * been queued at least `staleThresholdMs` — a freshly enqueued change that the
 * next cycle will ship is not "waiting" yet, so the row stays quiet during
 * normal operation. `failed` maps every quarantine entry to a row labelled by
 * its vault path (falling back to the fileId, then a generic label).
 */
export function buildSendQueueStatus(
  input: SendQueueStatusInput,
): SendQueueStatusView {
  const threshold = input.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const waitingCount = input.outbox.filter(
    (entry) => input.now - entry.enqueuedAt >= threshold,
  ).length;

  const failed = input.quarantine.map((entry) => ({
    revisionId: entry.revisionId,
    label:
      entry.path !== undefined && entry.path.length > 0
        ? entry.path
        : entry.fileId.length > 0
          ? entry.fileId
          : 'Unknown change',
    reason: entry.reason,
  }));

  return { waitingCount, failed };
}

/**
 * Notice-once bookkeeping. Given the set of quarantine revisionIds already
 * announced and the current quarantine, returns the entries that are NEW (never
 * announced) plus the updated known-set. Callers fire exactly one Notice per
 * `fresh` entry, so a retry that re-quarantines the same revisionId is silent.
 */
export function selectNewlyQuarantined(
  known: ReadonlySet<string>,
  quarantine: readonly QuarantineViewEntry[],
): { readonly fresh: readonly QuarantineViewEntry[]; readonly next: ReadonlySet<string> } {
  const fresh = quarantine.filter((entry) => !known.has(entry.revisionId));
  const next = new Set(known);
  for (const entry of quarantine) next.add(entry.revisionId);
  return { fresh, next };
}
