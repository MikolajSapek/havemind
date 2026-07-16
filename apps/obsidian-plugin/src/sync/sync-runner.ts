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
}

export interface RemoteEvent {
  readonly serverSequence: number;
  readonly revision: RemoteRevision;
}

export interface PushRevision {
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
}

export interface PushReceipt {
  readonly revisionId: string;
  readonly serverSequence: number;
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
  push(revisions: readonly PushRevision[]): Promise<readonly PushReceipt[]>;
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
  /** Echo suppression: was this revision authored by this device? */
  isLocallyAuthored(revisionId: string): Promise<boolean>;
}

export interface OpenBuffer {
  /** Hash of the synced base loaded into the editor, or null if unknown. */
  readonly baseHash: string | null;
  /** Hash of the current in-memory editor content. */
  readonly currentHash: string;
}

export interface VaultApplyPort {
  /** Every open leaf/popout buffer for the target file. */
  openBuffers(fileId: string): Promise<readonly OpenBuffer[]>;
  /** Write the remote revision content to the vault file. */
  applyRemote(event: RemoteEvent): Promise<void>;
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
}

type RemoteApplyDecision = 'apply' | 'conflict' | 'defer';

const DEFAULT_BASE_BACKOFF_MS = 5000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

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
    Pick<SyncRunnerOptions, 'baseBackoffMs' | 'maxBackoffMs' | 'random'>
  > &
    SyncRunnerOptions;

  private inFlight: Promise<SyncCycleResult> | null = null;
  private rerunRequested = false;
  private failureCount = 0;

  public constructor(options: SyncRunnerOptions) {
    this.options = {
      baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      random: options.random ?? Math.random,
      ...options,
    };
  }

  /**
   * Single-flight entry point. Overlapping triggers coalesce into exactly one
   * additional rerun rather than launching parallel cycles.
   */
  public trigger(): Promise<SyncCycleResult> {
    if (this.inFlight !== null) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    return this.loop();
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
    } while (this.rerunRequested);
    return result;
  }

  private async runCycle(): Promise<SyncCycleResult> {
    try {
      const pushed = await this.runPush();
      const apply = await this.runPull();
      this.failureCount = 0;
      return {
        applied: apply.applied,
        conflicts: apply.conflicts,
        deferred: apply.deferred,
        pushed,
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
      return {
        applied: 0,
        conflicts: 0,
        deferred: 0,
        pushed: 0,
        status,
        suppressed: 0,
      };
    }
  }

  private async runPush(): Promise<number> {
    const outbox = await this.options.state.listOutbox();
    if (outbox.length === 0) {
      return 0;
    }

    const receipts = await this.options.transport.push(outbox);
    for (const receipt of receipts) {
      await this.options.state.recordPushReceipt(receipt);
    }
    return receipts.length;
  }

  private async runPull(): Promise<Omit<SyncCycleResult, 'pushed'>> {
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
        continue;
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
        await this.options.vault.applyRemote(remoteEvent);
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
