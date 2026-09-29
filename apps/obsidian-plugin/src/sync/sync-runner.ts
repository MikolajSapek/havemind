/**
 * Client sync runner: durable push/pull and safe remote apply through injected
 * ports. Two rules from `plans/001-technical-plan.md` §14: a single-flight loop
 * (never two cycles racing one cursor), and never a silent overwrite of a
 * divergent open buffer (defer it, or make it a visible conflict).
 */

export interface RemoteRevision {
  readonly revisionId: string;
  readonly fileId: string;
  /** Content-addressed hash of the remote payload bytes. */
  readonly contentHash: string;
  /**
   * DAG parents, so apply can tell a fast-forward from a concurrent divergence
   * (rule 3). Best-effort: when absent, apply fails SAFE (a divergent shared
   * file becomes a conflict, never an overwrite).
   */
  readonly parentRevisionIds?: readonly string[];
  /** Authoring membership (from the receipt), for the Activity feed; never inferred. */
  readonly authorMembershipId?: string;
}

export interface RemoteEvent {
  readonly serverSequence: number;
  readonly revision: RemoteRevision;
}

export interface PushRevision {
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
  /** Decoded payload size, for size-bounded batching. Optional; 0 when unknown. */
  readonly payloadBytes?: number;
  /** DAG parents, from the outbox header, for `runPush`'s lineage; none for a root. */
  readonly parentRevisionIds?: readonly string[];
}

export interface PushReceipt {
  readonly revisionId: string;
  readonly serverSequence: number;
}

/** Per-revision push outcome: one poison revision never blocks the rest of a batch. */
export interface PushItemResult {
  readonly revisionId: string;
  readonly outcome: 'accepted' | 'rejected';
  /** Present when `outcome === 'accepted'`. */
  readonly receipt?: PushReceipt;
  /** Rejected for good (`true`, quarantine it) or retryable after the next pull. */
  readonly permanent?: boolean;
  /**
   * Rejected because the parent is not (yet) on the server (MISSING_PARENT):
   * retryable while the parent is pending, TERMINAL once it is quarantined or
   * gone (else the child retries forever). The runner decides from the lineage.
   */
  readonly missingParent?: boolean;
}

export interface PullResult {
  readonly cursor: number;
  /** Server epoch, rotated by a restore, so revision history notices one (P13). */
  readonly epoch?: string;
  readonly events: readonly RemoteEvent[];
}

/** The opaque server transport: it only ships bytes and reads back ordered events. */
export interface SyncTransport {
  push(revisions: readonly PushRevision[]): Promise<readonly PushItemResult[]>;
  pull(after: number): Promise<PullResult>;
}

/** Durable state: a restart never re-pushes or re-applies an acknowledged revision. */
export interface SyncStatePort {
  /** Retire an unaccepted merge once an applied remote merge proves it redundant. */
  retireEquivalentMerges?(event: RemoteEvent): Promise<void>;
  /** Park a change this device keeps failing to apply; listed until retried (B2). */
  parkRemote?(event: RemoteEvent, reason: string): Promise<void>;
  unparkRemote?(revisionId: string): Promise<void>;
  listParkedRemote?(): Promise<readonly RemoteEvent[]>;

  /** The highest server sequence already materialized locally. */
  loadCursor(): Promise<number>;
  saveCursor(sequence: number): Promise<void>;
  listOutbox(): Promise<readonly PushRevision[]>;
  /** Remove a pushed revision from the outbox and remember local authorship. */
  recordPushReceipt(receipt: PushReceipt): Promise<void>;
  /** Dead-letter a poison revision into a durable, visible record. */
  quarantineOutboxItem(revisionId: string, reason: string): Promise<void>;
  /** Echo suppression: was this revision authored by this device? */
  isLocallyAuthored(revisionId: string): Promise<boolean>;
}

export interface OpenBuffer {
  /** Live editor differs from disk: retry once Obsidian saves it. */
  readonly unsaved: boolean;
}

/** `conflict` may come from the vault's on-disk guard (rule 3); `noop` = converged. */
export type RemoteApplyOutcome = 'applied' | 'conflict' | 'noop' | 'deferred';

/**
 * `bootstrap` marks the one-time initial catch-up after connect (materialising a
 * PRE-EXISTING vault). It only labels the Activity entry, so the feed stays quiet
 * for the replay; materialisation is identical either way.
 */
export interface RemoteApplyOptions {
  readonly bootstrap?: boolean;
}

export interface VaultApplyPort {
  openBuffers(fileId: string): Promise<readonly OpenBuffer[]>;
  /** Write the revision, subject to the vault's on-disk overwrite guard (rule 3). */
  applyRemote(
    event: RemoteEvent,
    options?: RemoteApplyOptions,
  ): Promise<RemoteApplyOutcome>;
}

export type SchedulerCancellation = () => void;

/** Schedules a callback. Production returns a cancellation for reconnect/unload. */
export type SchedulerFn = (
  callback: () => void,
  delayMs: number,
) => void | SchedulerCancellation;

export interface SyncRunnerOptions {
  readonly beforeCycle?: () => Promise<void>;
  readonly beforePull?: () => Promise<void>;
  readonly afterPull?: () => Promise<void>;
  readonly transport: SyncTransport;
  readonly state: SyncStatePort;
  readonly vault: VaultApplyPort;
  readonly scheduler: SchedulerFn;
  /** Injectable jitter source in the half-open range [0, 1). */
  readonly random?: () => number;
  /** First-failure backoff ceiling; defaults to the five-second loop cadence. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Byte budget of one push request; defaults to the server's 512 KiB ceiling. */
  readonly maxPushBatchBytes?: number;
  /** Maximum revisions in one push request; defaults to the server's 64. */
  readonly maxPushBatchItems?: number;
  /** Observes every cycle, backoff retries included, so a recovery clears "offline". */
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
   * Monotonic per-runner number, so a consumer can drop a stale or duplicate
   * outcome (a coalesced trigger and a backoff retry can surface one cycle).
   */
  readonly cycleId?: number;
  /** Why a failed cycle failed, so the panel can say so instead of guessing. */
  readonly error?: string;
}

/** Quarantine reason for a revision dead-lettered because a parent was quarantined. */
const PARENT_QUARANTINED_REASON = 'parent-quarantined';
/** Quarantine reason for an orphaned child whose parent is dead/absent (terminal). */
const MISSING_PARENT_REASON = 'missing-parent';

/** Parent→child lineage among the queued revisions, built once per push cycle. */
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

/** Failed applies of one incoming change before it is parked (B2). */
const MAX_APPLY_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 5000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
/** Mirrors the server's per-payload ceiling so a sub-batch never overflows it. */
const DEFAULT_MAX_PUSH_BATCH_BYTES = 512 * 1024;
/** Mirrors the server's DEFAULT_MAX_BATCH_SIZE. */
const DEFAULT_MAX_PUSH_BATCH_ITEMS = 64;

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
  private readonly pendingBackoffCancellations = new Set<SchedulerCancellation>();
  /** Consecutive failed applies per incoming revision, reset on success. */
  private readonly applyFailures = new Map<string, number>();
  /**
   * Server head at this runner's FIRST pull (it is rebuilt per connection):
   * events up to it are the initial catch-up (`bootstrap`), later ones live. The
   * pull `cursor` is the current head, so this holds across paged cycles.
   */
  private bootstrapTarget: number | null = null;

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
   * Single-flight: overlapping triggers coalesce into one extra rerun. A stopped
   * runner is inert, so an old runner's leftover backoff timer can never push
   * under a stale identity after a reconnect.
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

  /** Quiesces the runner for good (no triggers, backoff cancelled); idempotent. */
  public stop(): void {
    this.stopped = true;
    for (const cancel of this.pendingBackoffCancellations) {
      cancel();
    }
    this.pendingBackoffCancellations.clear();
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
      await this.options.beforeCycle?.();
      // A transient push failure (e.g. a large upload timing out) must not also
      // stop this device receiving changes: pull anyway, then fail the cycle so
      // it backs off and retries the push. A refused session stops everything.
      let push = { pushed: 0, quarantined: 0 };
      let pushFailure: { readonly error: unknown } | null = null;
      try {
        push = await this.runPush();
      } catch (error) {
        if (isAuthDenied(error)) throw error;
        pushFailure = { error };
      }
      await this.options.beforePull?.();
      const apply = await this.runPull();
      await this.options.afterPull?.();
      if (pushFailure !== null) throw pushFailure.error;
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
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.options.onCycleComplete?.(result);
    return result;
  }

  /**
   * Drains the outbox in size-bounded sub-batches and reconciles each per-item
   * result: a permanent rejection is quarantined, a transient one stays queued
   * until the next pull, a transient transport failure is re-thrown (backoff).
   *
   * Quarantine CASCADES to outbox descendants: a dead parent never lands, so its
   * children would get MISSING_PARENT forever. The `quarantined` count covers
   * the whole lineage so the status never reads "synced" beside a dead one.
   */
  private async runPush(): Promise<{ pushed: number; quarantined: number }> {
    const outbox = await this.options.state.listOutbox();
    if (outbox.length === 0) {
      return { pushed: 0, quarantined: 0 };
    }

    const queue = this.planPushBatches(outbox);
    const lineage = buildLineageIndex(outbox);
    // `pending`: queued and still alive this cycle. Items leave it on accept or
    // quarantine, so a later batch never re-pushes what a cascade dead-lettered.
    const pending = new Set(outbox.map((item) => item.revisionId));
    const accepted = new Set<string>();
    const quarantinedIds = new Set<string>();
    let pushed = 0;

    // Dead-letter `rootId` and all its outbox descendants, breadth-first.
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
          // No parent on the server and none of its parents pending or accepted
          // here: the child can never land, so dead-letter it (and descendants).
          await quarantineLineage(result.revisionId, MISSING_PARENT_REASON);
        }
        // A transient rejection, or a MISSING_PARENT whose parent is still
        // pending/accepted, is left in the outbox to retry after a pull.
      }
    }

    return { pushed, quarantined: quarantinedIds.size };
  }

  /**
   * Whether a MISSING_PARENT child can still land: a parent is pending, was
   * accepted this cycle, or was authored earlier (already on the server).
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
   * Groups the outbox into sub-batches under the byte and item budgets. An
   * oversized revision gets its own batch (it is the first item, so no split
   * fires), so a 4xx on it never wedges other files.
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

  /**
   * Applies a parked incoming change again. True when it no longer needs to be
   * listed (applied, a conflict copy written, or already superseded); false
   * while an unsaved editor still holds the file. A failure is thrown.
   */
  async retryParked(revisionId: string): Promise<boolean> {
    const parked = await this.options.state.listParkedRemote?.();
    const event = parked?.find((item) => item.revision.revisionId === revisionId);
    if (event === undefined) return true;
    const outcome = await this.options.vault.applyRemote(event, { bootstrap: false });
    if (outcome === 'deferred') return false;
    await this.options.state.unparkRemote?.(revisionId);
    return true;
  }

  private async runPull(): Promise<
    Omit<SyncCycleResult, 'pushed' | 'quarantined'>
  > {
    let cursor = await this.options.state.loadCursor();
    const { cursor: serverHead, events } = await this.options.transport.pull(cursor);
    if (this.bootstrapTarget === null) {
      this.bootstrapTarget = serverHead;
    }
    const bootstrapTarget = this.bootstrapTarget;
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
        // page, never regress the cursor onto it.
        continue;
      }

      // Contiguity gate (rule 3, no silent skip): the next sequence must be
      // exactly `cursor + 1`. A hole (the page starts beyond it, or a gap opens
      // mid-page) means an earlier revision is missing: stop rather than skip
      // it forever by advancing the cursor past it. `/events` is cursor-based,
      // so the next poll re-requests from the same cursor.
      if (remoteEvent.serverSequence !== cursor + 1) {
        break;
      }

      if (await this.options.state.isLocallyAuthored(remoteEvent.revision.revisionId)) {
        // Acceptance does not establish a common ancestor with another device.
        // Preserve the merge base; causal apply uses revision-bound producer state.
        suppressed += 1;
        cursor = remoteEvent.serverSequence;
        await this.options.state.saveCursor(cursor);
        continue;
      }

      // An editor holding unsaved text wins: wait until Obsidian saves it. The
      // vault's on-disk guard may still divert the write to a conflict (rule 3).
      const buffers = await this.options.vault.openBuffers(
        remoteEvent.revision.fileId,
      );
      if (buffers.some((buffer) => buffer.unsaved)) {
        deferred += 1;
        break;
      }

      let outcome: RemoteApplyOutcome;
      try {
        outcome = await this.options.vault.applyRemote(remoteEvent, {
          bootstrap:
            bootstrapTarget !== null &&
            remoteEvent.serverSequence <= bootstrapTarget,
        });
      } catch (error) {
        // One change this device cannot apply (e.g. iOS refusing to read a
        // PDF) must not stop the whole vault forever: after a few tries it is
        // parked, listed in the panel, and the cursor moves on (B2).
        const id = remoteEvent.revision.revisionId;
        const attempts = (this.applyFailures.get(id) ?? 0) + 1;
        if (
          isAuthDenied(error) ||
          this.options.state.parkRemote === undefined ||
          attempts < MAX_APPLY_ATTEMPTS
        ) {
          this.applyFailures.set(id, attempts);
          throw error;
        }
        this.applyFailures.delete(id);
        await this.options.state.parkRemote(
          remoteEvent,
          error instanceof Error ? error.message : String(error),
        );
        cursor = remoteEvent.serverSequence;
        await this.options.state.saveCursor(cursor);
        continue;
      }
      this.applyFailures.delete(remoteEvent.revision.revisionId);
      if (outcome === 'deferred') {
        deferred += 1;
        break;
      }
      if (outcome === 'conflict') {
        conflicts += 1;
      } else {
        await this.options.state.retireEquivalentMerges?.(remoteEvent);
        applied += 1;
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
    const scheduledTimer: { cancellation?: SchedulerCancellation } = {};
    let fired = false;
    const scheduled = this.options.scheduler(() => {
      fired = true;
      if (scheduledTimer.cancellation !== undefined) {
        this.pendingBackoffCancellations.delete(scheduledTimer.cancellation);
      }
      void this.trigger();
    }, delayMs);
    if (typeof scheduled !== 'function') return;
    const cancellation = scheduled;
    scheduledTimer.cancellation = cancellation;
    // A synchronous test scheduler may fire before it returns its cancellation;
    // only retain timers that are still pending after scheduling.
    if (!fired && !this.stopped) {
      this.pendingBackoffCancellations.add(cancellation);
    } else if (this.stopped) {
      cancellation();
    }
  }
}

/** An error with `authDenied === true` (HTTP 401) is terminal; checked structurally. */
function isAuthDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { authDenied?: unknown }).authDenied === true
  );
}

/**
 * `permanent === true` marks a 4xx the same bytes will never satisfy (413, 422,
 * 400): quarantine the revision rather than retry forever. Checked structurally.
 */
function isPermanentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  );
}

/**
 * The result a stopped runner returns from `trigger()`: no work and no
 * `cycleId`, so a status consumer treats it as stale and never latches a state
 * off a dead runner.
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
  // A conflict outranks a deferral: a conflict copy needs the user, while a
  // deferral clears itself later and must not hide a real conflict.
  if (counts.conflicts > 0) {
    return 'conflict';
  }
  if (counts.deferred > 0) {
    return 'deferred';
  }
  return 'synced';
}
