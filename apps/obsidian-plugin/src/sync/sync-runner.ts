/**
 * Client sync runner: drives durable push/pull and safe remote apply.
 *
 * The runner is transport-agnostic and speaks only to injected ports so it can
 * be exercised without Obsidian, HTTP or IndexedDB. It enforces two hard rules
 * from `plans/001-technical-plan.md` §14:
 *
 *  - a single-flight loop, never two overlapping cycles racing the same cursor;
 *  - never a silent overwrite of a divergent open buffer — such an event is
 *    deferred or turned into a visible conflict, never applied on top.
 */

export interface RemoteRevision {
  readonly revisionId: string;
  readonly fileId: string;
  /** Content-addressed hash of the remote payload bytes. */
  readonly contentHash: string;
  /**
   * The revision ids this revision was authored on top of (its DAG parents),
   * carried from the producer's header. Lets the apply side decide, by
   * causality, whether an incoming revision is a fast-forward from this device's
   * head (the peer had our version → apply in place) or a concurrent divergence
   * (never a silent overwrite — rule 3). Optional/best-effort: absent (or empty)
   * when the transport cannot surface it, in which case apply fails SAFE
   * (a divergent shared file becomes a conflict, never an overwrite).
   */
  readonly parentRevisionIds?: readonly string[];
}

export interface RemoteEvent {
  readonly serverSequence: number;
  readonly revision: RemoteRevision;
}

export interface PushRevision {
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
  /**
   * Decoded payload byte length. Drives size-bounded push batching so a single
   * large revision is isolated into its own request and can never wedge a whole
   * multi-item batch. Optional; treated as 0 (best-effort batching) when unknown.
   */
  readonly payloadBytes?: number;
  /**
   * The revision ids this revision was authored on top of (its DAG parents),
   * surfaced from the outbox envelope's header. Lets the push side model the
   * parent→child lineage AMONG queued revisions so that quarantining a poison
   * parent can cascade to its descendants (which the server would otherwise keep
   * rejecting with MISSING_PARENT forever), and so a MISSING_PARENT for a child
   * whose parent is already dead becomes terminal rather than an infinite retry.
   * Optional/best-effort: absent (or empty) for a root create or when the header
   * carried none, in which case the revision has no in-outbox dependency.
   */
  readonly parentRevisionIds?: readonly string[];
}

export interface PushReceipt {
  readonly revisionId: string;
  readonly serverSequence: number;
}

/**
 * The per-revision outcome the opaque server reports for one pushed revision.
 * Returning a result per revision (instead of aborting the whole batch on the
 * first failure) is what lets the runner record the accepted prefix and isolate
 * a single poison revision, so one bad file never blocks every other file.
 */
export interface PushItemResult {
  readonly revisionId: string;
  readonly outcome: 'accepted' | 'rejected';
  /** Present when `outcome === 'accepted'`. */
  readonly receipt?: PushReceipt;
  /**
   * Present when `outcome === 'rejected'`: `true` means the revision will never
   * be accepted on a blind retry (quarantine it); `false`/absent means a
   * transient rejection that should be retried after the next pull.
   */
  readonly permanent?: boolean;
  /**
   * Present when `outcome === 'rejected'`: `true` means the server rejected the
   * revision because its parent is not (yet) on the server (MISSING_PARENT). This
   * is retryable-by-code (`permanent` stays false) while the parent is still
   * pending in the outbox, but TERMINAL once the parent is quarantined or gone —
   * otherwise a child of a dead parent retries forever. The runner resolves which
   * of the two applies from the in-outbox lineage.
   */
  readonly missingParent?: boolean;
}

export interface PullResult {
  readonly cursor: number;
  readonly events: readonly RemoteEvent[];
}

/**
 * The opaque server transport. The runner never asks the server to compute a
 * diff, provenance or merge — it only ships bytes and reads back ordered
 * events.
 */
export interface SyncTransport {
  push(revisions: readonly PushRevision[]): Promise<readonly PushItemResult[]>;
  pull(after: number): Promise<PullResult>;
}

/**
 * Durable client state that must survive a process restart. Durability lives
 * behind this port so that a restart can never re-push or re-apply an already
 * acknowledged revision.
 */
export interface SyncStatePort {
  /** The highest server sequence already materialized locally. */
  loadCursor(): Promise<number>;
  saveCursor(sequence: number): Promise<void>;
  /** Revisions still awaiting a server receipt. */
  listOutbox(): Promise<readonly PushRevision[]>;
  /** Remove a pushed revision from the outbox and remember local authorship. */
  recordPushReceipt(receipt: PushReceipt): Promise<void>;
  /**
   * Dead-letter a poison revision: remove it from the outbox and record it as a
   * visible, durable failure. Used when the server permanently rejects a
   * revision (or a single-item request permanently fails), so one bad file can
   * never block the rest of the outbox and can never trigger an infinite retry.
   */
  quarantineOutboxItem(revisionId: string, reason: string): Promise<void>;
  /** Echo suppression: was this revision authored by this device? */
  isLocallyAuthored(revisionId: string): Promise<boolean>;
}

export interface OpenBuffer {
  /** Hash of the synced base loaded into the editor, or null if unknown. */
  readonly baseHash: string | null;
  /** Hash of the current in-memory editor content. */
  readonly currentHash: string;
}

/**
 * What `applyRemote` actually did. The runner asks the vault to apply a remote
 * revision only after the open-buffer guard cleared it, but the vault runs a
 * second, on-disk overwrite guard of its own: it compares the current on-disk
 * content against the last synced base before writing (rule 3). It therefore
 * reports back whether it wrote the content (`applied`), diverted it to a
 * conflict artifact because the on-disk file had diverged (`conflict`), or
 * skipped the write because the file had already converged to the incoming
 * content (`noop`).
 */
export type RemoteApplyOutcome = 'applied' | 'conflict' | 'noop';

export interface VaultApplyPort {
  /** Every open leaf/popout buffer for the target file. */
  openBuffers(fileId: string): Promise<readonly OpenBuffer[]>;
  /**
   * Write the remote revision content to the vault file, subject to the vault's
   * own on-disk overwrite guard. Returns what it did so the runner can report a
   * conflict the on-disk guard raised even though the buffer guard was clean.
   */
  applyRemote(event: RemoteEvent): Promise<RemoteApplyOutcome>;
  /** Record a visible conflict artifact without overwriting the active file. */
  recordConflict(event: RemoteEvent): Promise<void>;
}

export type SchedulerFn = (callback: () => void, delayMs: number) => void;

export interface SyncRunnerOptions {
  readonly transport: SyncTransport;
  readonly state: SyncStatePort;
  readonly vault: VaultApplyPort;
  /** Schedules a backoff retry; wraps `setTimeout` in production. */
  readonly scheduler: SchedulerFn;
  /** Injectable jitter source in the half-open range [0, 1). */
  readonly random?: () => number;
  /** First-failure backoff ceiling; defaults to the five-second loop cadence. */
  readonly baseBackoffMs?: number;
  /** Upper bound on the backoff ceiling. */
  readonly maxBackoffMs?: number;
  /**
   * Byte budget for one push request. The outbox is drained in sub-batches that
   * stay under this budget so a single large revision is isolated into its own
   * request and cannot wedge a whole multi-item batch. Defaults to the server's
   * 512 KiB per-payload ceiling.
   */
  readonly maxPushBatchBytes?: number;
  /** Maximum revisions in one push request; defaults to the server's 64. */
  readonly maxPushBatchItems?: number;
  /**
   * Observes the outcome of every completed cycle — including cycles the runner
   * drives itself through its internal backoff scheduler. Wiring the controller
   * here (not only through `trigger()`'s return value) is what lets a background
   * recovery cycle clear a stale "offline" status: a success reached only via
   * backoff still surfaces, so the indicator never latches offline while cycles
   * are succeeding.
   */
  readonly onCycleComplete?: (result: SyncCycleResult) => void;
}

export type SyncCycleStatus =
  | 'synced'
  | 'conflict'
  | 'deferred'
  | 'offline'
  | 'unauthenticated';

export interface SyncCycleResult {
  readonly status: SyncCycleStatus;
  readonly pushed: number;
  readonly applied: number;
  readonly suppressed: number;
  readonly conflicts: number;
  readonly deferred: number;
  /** Revisions dead-lettered this cycle (permanent push failure). */
  readonly quarantined: number;
  /**
   * Monotonic per-runner cycle number. Lets a status consumer ignore a stale or
   * duplicate outcome (a coalesced trigger and a backoff retry can both surface
   * the same cycle) so the indicator always reflects the LATEST cycle.
   */
  readonly cycleId?: number;
}

type RemoteApplyDecision = 'apply' | 'conflict' | 'defer';

/** Quarantine reason for a revision dead-lettered because a parent was quarantined. */
const PARENT_QUARANTINED_REASON = 'parent-quarantined';
/** Quarantine reason for an orphaned child whose parent is dead/absent (terminal). */
const MISSING_PARENT_REASON = 'missing-parent';

/**
 * A read-only view of the parent→child lineage among the queued revisions,
 * derived once per push cycle from each revision's `parentRevisionIds`. It answers
 * both directions: the parents a revision depends on, and the children that depend
 * on a revision (used to cascade a quarantine down a dead lineage).
 */
interface LineageIndex {
  parentsOf(revisionId: string): readonly string[];
  childrenOf(revisionId: string): readonly string[];
}

function buildLineageIndex(outbox: readonly PushRevision[]): LineageIndex {
  const parents = new Map<string, readonly string[]>();
  const children = new Map<string, string[]>();
  for (const item of outbox) {
    const itemParents = item.parentRevisionIds ?? [];
    parents.set(item.revisionId, itemParents);
    for (const parentId of itemParents) {
      const list = children.get(parentId);
      if (list === undefined) {
        children.set(parentId, [item.revisionId]);
      } else {
        list.push(item.revisionId);
      }
    }
  }
  return {
    parentsOf: (revisionId) => parents.get(revisionId) ?? [],
    childrenOf: (revisionId) => children.get(revisionId) ?? [],
  };
}

const DEFAULT_BASE_BACKOFF_MS = 5000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
/** Mirrors the server's per-payload ceiling so a sub-batch never overflows it. */
const DEFAULT_MAX_PUSH_BATCH_BYTES = 512 * 1024;
/** Mirrors the server's DEFAULT_MAX_BATCH_SIZE. */
const DEFAULT_MAX_PUSH_BATCH_ITEMS = 64;

/**
 * Decides how to handle a remote event given the open editor buffers for its
 * file. A clean buffer (content equal to its synced base) is safe to replace;
 * any buffer that diverges from its known base must never be silently
 * overwritten.
 */
export function decideRemoteApply(
  buffers: readonly OpenBuffer[],
  incomingContentHash: string,
): RemoteApplyDecision {
  const divergent = buffers.filter(
    (buffer) => buffer.currentHash !== buffer.baseHash,
  );
  if (divergent.length === 0) {
    return 'apply';
  }
  if (divergent.every((buffer) => buffer.currentHash === incomingContentHash)) {
    // The user's unsaved edit already equals the remote content, so writing it
    // loses nothing.
    return 'apply';
  }
  if (divergent.some((buffer) => buffer.baseHash === null)) {
    // Without a known base we cannot safely build a conflict, so defer and
    // retry once the buffer settles.
    return 'defer';
  }
  return 'conflict';
}

export class SyncRunner {
  private readonly options: Required<
    Pick<
      SyncRunnerOptions,
      | 'baseBackoffMs'
      | 'maxBackoffMs'
      | 'random'
      | 'maxPushBatchBytes'
      | 'maxPushBatchItems'
    >
  > &
    SyncRunnerOptions;

  private inFlight: Promise<SyncCycleResult> | null = null;
  private rerunRequested = false;
  private failureCount = 0;
  private cycleCounter = 0;
  private stopped = false;

  public constructor(options: SyncRunnerOptions) {
    this.options = {
      baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      random: options.random ?? Math.random,
      maxPushBatchBytes: options.maxPushBatchBytes ?? DEFAULT_MAX_PUSH_BATCH_BYTES,
      maxPushBatchItems: options.maxPushBatchItems ?? DEFAULT_MAX_PUSH_BATCH_ITEMS,
      ...options,
    };
  }

  /**
   * Single-flight entry point. Overlapping triggers coalesce into exactly one
   * additional rerun rather than launching parallel cycles.
   *
   * A stopped runner is inert: it issues no push/pull. This is what guarantees
   * that after a reconnect (or teardown) the previous connection's runner can
   * never ship a stale-identity revision — its own backoff timer may still fire,
   * but the trigger it drives is a no-op. Only the freshly-built runner, whose
   * transport already carries the current identity, ever pushes after reconnect.
   */
  public trigger(): Promise<SyncCycleResult> {
    if (this.stopped) {
      return Promise.resolve(idleCycleResult());
    }
    if (this.inFlight !== null) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    return this.loop();
  }

  /**
   * Quiesces the runner permanently: it stops accepting triggers and cancels any
   * pending backoff (the scheduled callback re-checks `stopped` before running).
   * Called from the controller's `stop()` on teardown/reconnect so a prior-session
   * runner cannot race a push onto the wire under an identity the server no longer
   * accepts. Idempotent.
   */
  public stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<SyncCycleResult> {
    let result: SyncCycleResult;
    do {
      this.rerunRequested = false;
      const cycle = this.runCycle();
      this.inFlight = cycle;
      try {
        result = await cycle;
      } finally {
        this.inFlight = null;
      }
      // A stop mid-cycle wins over a coalesced rerun request: never start a
      // fresh cycle once quiesced.
    } while (this.rerunRequested && !this.stopped);
    return result;
  }

  private async runCycle(): Promise<SyncCycleResult> {
    const cycleId = (this.cycleCounter += 1);
    let result: SyncCycleResult;
    try {
      const push = await this.runPush();
      const apply = await this.runPull();
      this.failureCount = 0;
      result = {
        applied: apply.applied,
        conflicts: apply.conflicts,
        cycleId,
        deferred: apply.deferred,
        pushed: push.pushed,
        quarantined: push.quarantined,
        status: apply.status,
        suppressed: apply.suppressed,
      };
    } catch (error) {
      // A refused session (HTTP 401) is terminal: stop, never retry, and let the
      // controller surface "reconnect required". Transient failures back off.
      const status: SyncCycleStatus = isAuthDenied(error)
        ? 'unauthenticated'
        : 'offline';
      if (status === 'offline') {
        this.scheduleBackoff();
      }
      result = {
        applied: 0,
        conflicts: 0,
        cycleId,
        deferred: 0,
        pushed: 0,
        quarantined: 0,
        status,
        suppressed: 0,
      };
    }
    // Report every completed cycle — including backoff-driven retries — so a
    // recovery reached only through the runner's own scheduler still clears a
    // stale offline status.
    this.options.onCycleComplete?.(result);
    return result;
  }

  /**
   * Drains the outbox in size-bounded sub-batches and reconciles each per-item
   * result. A permanently rejected revision is dead-lettered (quarantined) so it
   * can never block other files or trigger an infinite retry; a transient
   * rejection is left in the outbox to retry after the next pull. A whole-request
   * permanent failure is isolated to a single item and quarantined; a transient
   * transport failure is re-thrown so the cycle backs off offline as before.
   *
   * Quarantining a revision CASCADES to its outbox descendants (the revisions
   * whose lineage transitively depends on it): a dead parent will never land, so
   * every child would otherwise be rejected with MISSING_PARENT forever. The
   * cascade dead-letters the whole lineage in topological order so descendants
   * stop retrying, and the `quarantined` count reflects the full lineage so the
   * status surface can never read a clean "synced" while a lineage is dead.
   */
  private async runPush(): Promise<{ pushed: number; quarantined: number }> {
    const outbox = await this.options.state.listOutbox();
    if (outbox.length === 0) {
      return { pushed: 0, quarantined: 0 };
    }

    // A work queue so a multi-item batch that fails permanently can be split into
    // singletons and re-tried this same cycle to isolate the poison revision.
    const queue = this.planPushBatches(outbox);
    const lineage = buildLineageIndex(outbox);
    // `pending`: revisions still queued and alive this cycle. An item leaves it on
    // accept OR quarantine, so a later batch (or a re-split singleton) never
    // re-pushes a revision the cascade already dead-lettered.
    const pending = new Set(outbox.map((item) => item.revisionId));
    const accepted = new Set<string>();
    const quarantinedIds = new Set<string>();
    let pushed = 0;

    // Dead-letter `rootId` and every outbox descendant that transitively depends
    // on it, in breadth-first (topological) order over the lineage.
    const quarantineLineage = async (
      rootId: string,
      rootReason: string,
    ): Promise<void> => {
      const work: Array<{ id: string; reason: string }> = [
        { id: rootId, reason: rootReason },
      ];
      while (work.length > 0) {
        const next = work.shift();
        if (next === undefined || !pending.has(next.id)) {
          continue; // already accepted, already quarantined, or not in this outbox
        }
        pending.delete(next.id);
        quarantinedIds.add(next.id);
        await this.options.state.quarantineOutboxItem(next.id, next.reason);
        for (const childId of lineage.childrenOf(next.id)) {
          work.push({ id: childId, reason: PARENT_QUARANTINED_REASON });
        }
      }
    };

    for (let index = 0; index < queue.length; index += 1) {
      const batch = queue[index];
      if (batch === undefined || batch.length === 0) {
        continue;
      }
      // Skip anything the cascade already dead-lettered: never ship a doomed child.
      const live = batch.filter((item) => pending.has(item.revisionId));
      if (live.length === 0) {
        continue;
      }

      let results: readonly PushItemResult[];
      try {
        results = await this.options.transport.push(live);
      } catch (error) {
        if (isAuthDenied(error)) {
          throw error; // terminal: bubble to runCycle → 'unauthenticated'
        }
        if (isPermanentError(error)) {
          if (live.length === 1 && live[0] !== undefined) {
            await quarantineLineage(live[0].revisionId, permanentReason(error));
            continue;
          }
          // Can't attribute a multi-item permanent failure: split to isolate it.
          for (const item of live) {
            queue.push([item]);
          }
          continue;
        }
        throw error; // transient: bubble to runCycle → 'offline' + backoff
      }

      for (const result of results) {
        if (quarantinedIds.has(result.revisionId)) {
          continue; // already dead-lettered by a cascade from its parent
        }
        if (result.outcome === 'accepted' && result.receipt !== undefined) {
          await this.options.state.recordPushReceipt(result.receipt);
          pending.delete(result.revisionId);
          accepted.add(result.revisionId);
          pushed += 1;
        } else if (result.outcome === 'rejected' && result.permanent === true) {
          await quarantineLineage(result.revisionId, 'server-rejected');
        } else if (
          result.outcome === 'rejected' &&
          result.missingParent === true &&
          !(await this.parentStillViable(
            result.revisionId,
            lineage,
            pending,
            accepted,
          ))
        ) {
          // The server has no parent for this child AND none of its parents is
          // still pending/accepted here — the parent is dead, so the child (and
          // its own descendants) can never land. Dead-letter it terminally rather
          // than retry forever.
          await quarantineLineage(result.revisionId, MISSING_PARENT_REASON);
        }
        // A transient rejection — or a MISSING_PARENT whose parent is still
        // pending/accepted — is left in the outbox to retry after a pull.
      }
    }

    return { pushed, quarantined: quarantinedIds.size };
  }

  /**
   * Whether a MISSING_PARENT child's lineage is still healthy: at least one of its
   * parents is still pending in the outbox, was accepted earlier this cycle, or
   * was locally authored on a prior cycle (already on the server). When true the
   * child stays retryable (the parent will land); when false every parent is dead
   * or absent, so the child is an orphan the runner dead-letters.
   */
  private async parentStillViable(
    revisionId: string,
    lineage: LineageIndex,
    pending: ReadonlySet<string>,
    accepted: ReadonlySet<string>,
  ): Promise<boolean> {
    for (const parentId of lineage.parentsOf(revisionId)) {
      if (pending.has(parentId) || accepted.has(parentId)) {
        return true;
      }
      if (await this.options.state.isLocallyAuthored(parentId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Groups the outbox into sub-batches that each stay under the byte and item
   * budgets. A single revision larger than the byte budget still occupies its
   * own batch (it is the first item, so no split fires), isolating it so a 4xx
   * on that one request never wedges other files.
   */
  private planPushBatches(
    outbox: readonly PushRevision[],
  ): PushRevision[][] {
    const maxBytes = this.options.maxPushBatchBytes;
    const maxItems = this.options.maxPushBatchItems;
    const batches: PushRevision[][] = [];
    let current: PushRevision[] = [];
    let currentBytes = 0;

    for (const item of outbox) {
      const bytes = item.payloadBytes ?? 0;
      const wouldOverflow =
        current.length > 0 &&
        (current.length >= maxItems || currentBytes + bytes > maxBytes);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += bytes;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private async runPull(): Promise<
    Omit<SyncCycleResult, 'pushed' | 'quarantined'>
  > {
    let cursor = await this.options.state.loadCursor();
    const { events } = await this.options.transport.pull(cursor);
    const ordered = [...events].sort(
      (left, right) => left.serverSequence - right.serverSequence,
    );

    let applied = 0;
    let suppressed = 0;
    let conflicts = 0;
    let deferred = 0;

    for (const remoteEvent of ordered) {
      if (remoteEvent.serverSequence <= cursor) {
        // Already materialized, or a duplicate of an earlier sequence in this
        // page — never regress the cursor onto it.
        continue;
      }

      // Contiguity gate (rule 3, no silent skip): the next sequence we
      // materialize must be exactly `cursor + 1`. A hole — the page starts
      // beyond `cursor + 1`, or a gap opens mid-page — means an earlier
      // revision is not in this page. Stop here rather than advancing the cursor
      // PAST the missing sequence (which would skip that revision forever). The
      // `/events` endpoint is cursor-based, so the next poll re-requests from the
      // same (unadvanced) cursor and the server re-supplies the missing run.
      if (remoteEvent.serverSequence !== cursor + 1) {
        break;
      }

      if (await this.options.state.isLocallyAuthored(remoteEvent.revision.revisionId)) {
        suppressed += 1;
        cursor = remoteEvent.serverSequence;
        await this.options.state.saveCursor(cursor);
        continue;
      }

      const buffers = await this.options.vault.openBuffers(
        remoteEvent.revision.fileId,
      );
      const decision = decideRemoteApply(
        buffers,
        remoteEvent.revision.contentHash,
      );

      if (decision === 'defer') {
        deferred += 1;
        break;
      }

      if (decision === 'conflict') {
        await this.options.vault.recordConflict(remoteEvent);
        conflicts += 1;
      } else {
        // The open-buffer guard cleared this event, but the vault runs a second
        // on-disk overwrite guard before writing. A divergent on-disk file is
        // diverted to a conflict artifact rather than silently overwritten
        // (rule 3), and the runner counts it as a conflict so the status
        // surfaces it.
        const outcome = await this.options.vault.applyRemote(remoteEvent);
        if (outcome === 'conflict') {
          conflicts += 1;
        } else {
          applied += 1;
        }
      }

      cursor = remoteEvent.serverSequence;
      await this.options.state.saveCursor(cursor);
    }

    return {
      applied,
      conflicts,
      deferred,
      status: resolveStatus({ conflicts, deferred }),
      suppressed,
    };
  }

  private scheduleBackoff(): void {
    // A stopped runner never schedules another retry; and even a retry armed
    // just before stop() is neutralised because its callback re-checks `stopped`.
    if (this.stopped) {
      return;
    }
    this.failureCount += 1;
    const ceiling = Math.min(
      this.options.maxBackoffMs,
      this.options.baseBackoffMs * 2 ** (this.failureCount - 1),
    );
    // Half jitter: a guaranteed floor of ceiling/2 plus up to another half.
    const half = ceiling / 2;
    const delayMs = half + this.options.random() * half;
    this.options.scheduler(() => {
      void this.trigger();
    }, delayMs);
  }
}

/**
 * A transport or access-token error is terminal (auth denied, HTTP 401) when it
 * carries `authDenied === true`. Structural check keeps the runner decoupled
 * from the concrete error classes.
 */
function isAuthDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { authDenied?: unknown }).authDenied === true
  );
}

/**
 * A transport error is permanent (a 4xx the same bytes will never satisfy —
 * e.g. 413 too large, 422 invalid batch, 400 bad request) when it carries
 * `permanent === true`. Such a request must never be retried forever; the
 * offending revision is quarantined instead. Structural check keeps the runner
 * decoupled from the concrete error classes.
 */
function isPermanentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  );
}

/**
 * The neutral result a stopped runner returns from `trigger()`: no work done, no
 * `cycleId` so a status consumer treats it as a stale/duplicate and never latches
 * a state off a quiesced runner.
 */
function idleCycleResult(): SyncCycleResult {
  return {
    applied: 0,
    conflicts: 0,
    deferred: 0,
    pushed: 0,
    quarantined: 0,
    status: 'synced',
    suppressed: 0,
  };
}

function permanentReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'permanent-http-error';
}

function resolveStatus(counts: {
  conflicts: number;
  deferred: number;
}): SyncCycleStatus {
  if (counts.deferred > 0) {
    return 'deferred';
  }
  if (counts.conflicts > 0) {
    return 'conflict';
  }
  return 'synced';
}
