import type { RevisionNode } from './revision-dag.js';

export interface RevisionReceipt {
  readonly revisionId: string;
  readonly serverSequence: number;
}

export interface ServerRevisionEvent {
  readonly serverSequence: number;
  readonly revision: RevisionNode;
}

export interface AcknowledgedRevision {
  readonly revision: RevisionNode;
  readonly receipt: RevisionReceipt;
}

export interface ClientModelSnapshot {
  readonly schemaVersion: 1;
  readonly outbox: readonly RevisionNode[];
  readonly acknowledged: readonly AcknowledgedRevision[];
  readonly inbox: readonly ServerRevisionEvent[];
  readonly downloadedSequence: number;
  readonly materializedSequence: number;
}

export type QueueRevisionResult = 'duplicate' | 'queued';

export type ClientModelErrorCode =
  | 'EVENT_REVISION_REUSE'
  | 'EVENT_SEQUENCE_REUSE'
  | 'INVALID_LIMIT'
  | 'INVALID_RECEIPT'
  | 'INVALID_SNAPSHOT'
  | 'MATERIALIZATION_MISMATCH'
  | 'MATERIALIZATION_OUT_OF_ORDER'
  | 'RECEIPT_MISMATCH'
  | 'REVISION_ID_REUSE'
  | 'UNKNOWN_PUSH_RECEIPT';

export class ClientModelError extends Error {
  public constructor(
    public readonly code: ClientModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClientModelError';
  }
}

function cloneRevision(revision: RevisionNode): RevisionNode {
  return {
    ...revision,
    parentRevisionIds: [...revision.parentRevisionIds],
  };
}

function cloneReceipt(receipt: RevisionReceipt): RevisionReceipt {
  return { ...receipt };
}

function cloneEvent(event: ServerRevisionEvent): ServerRevisionEvent {
  return {
    serverSequence: event.serverSequence,
    revision: cloneRevision(event.revision),
  };
}

function cloneAcknowledgement(
  acknowledgement: AcknowledgedRevision,
): AcknowledgedRevision {
  return {
    revision: cloneRevision(acknowledgement.revision),
    receipt: cloneReceipt(acknowledgement.receipt),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRevision(left: RevisionNode, right: RevisionNode): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.vaultId === right.vaultId &&
    left.fileId === right.fileId &&
    left.blobHash === right.blobHash &&
    sameStrings(left.parentRevisionIds, right.parentRevisionIds)
  );
}

function sameReceipt(left: RevisionReceipt, right: RevisionReceipt): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.serverSequence === right.serverSequence
  );
}

function sameEvent(
  left: ServerRevisionEvent,
  right: ServerRevisionEvent,
): boolean {
  return (
    left.serverSequence === right.serverSequence &&
    sameRevision(left.revision, right.revision)
  );
}

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function acknowledgementAtSequence(
  acknowledged: ReadonlyMap<string, AcknowledgedRevision>,
  serverSequence: number,
): AcknowledgedRevision | undefined {
  for (const entry of acknowledged.values()) {
    if (entry.receipt.serverSequence === serverSequence) {
      return entry;
    }
  }

  return undefined;
}

function assertSnapshotCursor(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClientModelError(
      'INVALID_SNAPSHOT',
      `${name} must be a non-negative safe integer.`,
    );
  }
}

export class DurableClientModel {
  private outboxByRevisionId = new Map<string, RevisionNode>();
  private acknowledgedByRevisionId = new Map<string, AcknowledgedRevision>();
  private inboxBySequence = new Map<number, ServerRevisionEvent>();
  private eventSequenceByRevisionId = new Map<string, number>();
  private downloadedCursor = 0;
  private materializedCursor = 0;

  public constructor(snapshot?: ClientModelSnapshot) {
    if (snapshot !== undefined) {
      this.loadSnapshot(snapshot);
    }
  }

  public static restore(snapshot: ClientModelSnapshot): DurableClientModel {
    return new DurableClientModel(snapshot);
  }

  public get downloadedSequence(): number {
    return this.downloadedCursor;
  }

  public get materializedSequence(): number {
    return this.materializedCursor;
  }

  public get acknowledgedRevisionIds(): string[] {
    return [...this.acknowledgedByRevisionId.keys()].sort();
  }

  public get materializedRevisionIds(): string[] {
    const revisionIds: string[] = [];
    for (let sequence = 1; sequence <= this.materializedCursor; sequence += 1) {
      const storedEvent = this.inboxBySequence.get(sequence);
      if (storedEvent === undefined) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          `Materialized event ${sequence} is missing from the durable inbox.`,
        );
      }
      revisionIds.push(storedEvent.revision.revisionId);
    }
    return revisionIds;
  }

  public queueRevision(revision: RevisionNode): QueueRevisionResult {
    const existing = this.findKnownRevision(revision.revisionId);
    if (existing !== undefined) {
      if (sameRevision(existing, revision)) {
        return 'duplicate';
      }

      throw new ClientModelError(
        'REVISION_ID_REUSE',
        `Revision ID ${revision.revisionId} already has different bytes.`,
      );
    }

    this.outboxByRevisionId.set(revision.revisionId, cloneRevision(revision));
    return 'queued';
  }

  public nextPushBatch(limit = 50): RevisionNode[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ClientModelError(
        'INVALID_LIMIT',
        'Push batch limit must be a positive safe integer.',
      );
    }

    return [...this.outboxByRevisionId.values()]
      .slice(0, limit)
      .map(cloneRevision);
  }

  public recordPushReceipt(receipt: RevisionReceipt): void {
    if (!isSequence(receipt.serverSequence) || receipt.revisionId.length === 0) {
      throw new ClientModelError(
        'INVALID_RECEIPT',
        'Push receipt contains an invalid revision ID or server sequence.',
      );
    }

    const acknowledged = this.acknowledgedByRevisionId.get(receipt.revisionId);
    if (acknowledged !== undefined) {
      if (sameReceipt(acknowledged.receipt, receipt)) {
        return;
      }

      throw new ClientModelError(
        'RECEIPT_MISMATCH',
        `Revision ${receipt.revisionId} has a different durable receipt.`,
      );
    }

    const pending = this.outboxByRevisionId.get(receipt.revisionId);
    if (pending === undefined) {
      throw new ClientModelError(
        'UNKNOWN_PUSH_RECEIPT',
        `Receipt references unknown revision ${receipt.revisionId}.`,
      );
    }

    const receiptAtSequence = acknowledgementAtSequence(
      this.acknowledgedByRevisionId,
      receipt.serverSequence,
    );
    if (
      receiptAtSequence !== undefined &&
      receiptAtSequence.revision.revisionId !== receipt.revisionId
    ) {
      throw new ClientModelError(
        'RECEIPT_MISMATCH',
        `Server sequence ${receipt.serverSequence} already acknowledges another revision.`,
      );
    }

    const eventAtSequence = this.inboxBySequence.get(receipt.serverSequence);
    if (
      eventAtSequence !== undefined &&
      !sameRevision(eventAtSequence.revision, pending)
    ) {
      throw new ClientModelError(
        'RECEIPT_MISMATCH',
        `Receipt sequence ${receipt.serverSequence} belongs to another revision.`,
      );
    }

    this.acknowledgedByRevisionId.set(receipt.revisionId, {
      revision: cloneRevision(pending),
      receipt: cloneReceipt(receipt),
    });
    this.outboxByRevisionId.delete(receipt.revisionId);
  }

  public receiveEvents(events: readonly ServerRevisionEvent[]): void {
    const nextInbox = new Map(this.inboxBySequence);
    const nextSequenceByRevisionId = new Map(this.eventSequenceByRevisionId);
    const nextOutbox = new Map(this.outboxByRevisionId);
    const nextAcknowledged = new Map(this.acknowledgedByRevisionId);

    for (const candidate of events) {
      if (!isSequence(candidate.serverSequence)) {
        throw new ClientModelError(
          'EVENT_SEQUENCE_REUSE',
          'Server event sequence must be a positive safe integer.',
        );
      }

      const incoming = cloneEvent(candidate);
      const existingAtSequence = nextInbox.get(incoming.serverSequence);
      if (existingAtSequence !== undefined) {
        if (sameEvent(existingAtSequence, incoming)) {
          continue;
        }

        throw new ClientModelError(
          'EVENT_SEQUENCE_REUSE',
          `Server sequence ${incoming.serverSequence} has different bytes.`,
        );
      }

      const existingSequence = nextSequenceByRevisionId.get(
        incoming.revision.revisionId,
      );
      if (existingSequence !== undefined) {
        throw new ClientModelError(
          'EVENT_REVISION_REUSE',
          `Revision ${incoming.revision.revisionId} appears at multiple sequences.`,
        );
      }

      const receiptAtSequence = acknowledgementAtSequence(
        nextAcknowledged,
        incoming.serverSequence,
      );
      if (
        receiptAtSequence !== undefined &&
        receiptAtSequence.revision.revisionId !== incoming.revision.revisionId
      ) {
        throw new ClientModelError(
          'RECEIPT_MISMATCH',
          `Downloaded sequence ${incoming.serverSequence} conflicts with a stored receipt.`,
        );
      }

      const knownRevision = this.findKnownRevisionIn(
        incoming.revision.revisionId,
        nextOutbox,
        nextAcknowledged,
        nextInbox,
      );
      if (
        knownRevision !== undefined &&
        !sameRevision(knownRevision, incoming.revision)
      ) {
        throw new ClientModelError(
          'REVISION_ID_REUSE',
          `Downloaded revision ${incoming.revision.revisionId} has different bytes.`,
        );
      }

      const acknowledged = nextAcknowledged.get(incoming.revision.revisionId);
      if (
        acknowledged !== undefined &&
        acknowledged.receipt.serverSequence !== incoming.serverSequence
      ) {
        throw new ClientModelError(
          'RECEIPT_MISMATCH',
          `Downloaded event conflicts with the stored push receipt.`,
        );
      }

      const pending = nextOutbox.get(incoming.revision.revisionId);
      if (pending !== undefined) {
        nextAcknowledged.set(incoming.revision.revisionId, {
          revision: cloneRevision(pending),
          receipt: {
            revisionId: pending.revisionId,
            serverSequence: incoming.serverSequence,
          },
        });
        nextOutbox.delete(incoming.revision.revisionId);
      }

      nextInbox.set(incoming.serverSequence, incoming);
      nextSequenceByRevisionId.set(
        incoming.revision.revisionId,
        incoming.serverSequence,
      );
    }

    let nextDownloadedCursor = this.downloadedCursor;
    while (nextInbox.has(nextDownloadedCursor + 1)) {
      nextDownloadedCursor += 1;
    }

    this.inboxBySequence = nextInbox;
    this.eventSequenceByRevisionId = nextSequenceByRevisionId;
    this.outboxByRevisionId = nextOutbox;
    this.acknowledgedByRevisionId = nextAcknowledged;
    this.downloadedCursor = nextDownloadedCursor;
  }

  public nextMaterialization(): ServerRevisionEvent | null {
    const nextSequence = this.materializedCursor + 1;
    if (nextSequence > this.downloadedCursor) {
      return null;
    }

    const storedEvent = this.inboxBySequence.get(nextSequence);
    if (storedEvent === undefined) {
      throw new ClientModelError(
        'INVALID_SNAPSHOT',
        `Downloaded event ${nextSequence} is missing from the durable inbox.`,
      );
    }

    return cloneEvent(storedEvent);
  }

  public confirmMaterialized(
    serverSequence: number,
    revisionId: string,
  ): void {
    const expectedSequence = this.materializedCursor + 1;
    if (serverSequence !== expectedSequence) {
      throw new ClientModelError(
        'MATERIALIZATION_OUT_OF_ORDER',
        `Expected materialization sequence ${expectedSequence}.`,
      );
    }

    const storedEvent = this.inboxBySequence.get(serverSequence);
    if (
      storedEvent === undefined ||
      storedEvent.revision.revisionId !== revisionId
    ) {
      throw new ClientModelError(
        'MATERIALIZATION_MISMATCH',
        'Materialization acknowledgement does not match the durable inbox.',
      );
    }

    this.materializedCursor = serverSequence;
  }

  public snapshot(): ClientModelSnapshot {
    return {
      schemaVersion: 1,
      outbox: [...this.outboxByRevisionId.values()].map(cloneRevision),
      acknowledged: [...this.acknowledgedByRevisionId.values()].map(
        cloneAcknowledgement,
      ),
      inbox: [...this.inboxBySequence.values()]
        .sort((left, right) => left.serverSequence - right.serverSequence)
        .map(cloneEvent),
      downloadedSequence: this.downloadedCursor,
      materializedSequence: this.materializedCursor,
    };
  }

  private findKnownRevision(revisionId: string): RevisionNode | undefined {
    return this.findKnownRevisionIn(
      revisionId,
      this.outboxByRevisionId,
      this.acknowledgedByRevisionId,
      this.inboxBySequence,
    );
  }

  private findKnownRevisionIn(
    revisionId: string,
    outbox: ReadonlyMap<string, RevisionNode>,
    acknowledged: ReadonlyMap<string, AcknowledgedRevision>,
    inbox: ReadonlyMap<number, ServerRevisionEvent>,
  ): RevisionNode | undefined {
    const pending = outbox.get(revisionId);
    if (pending !== undefined) {
      return pending;
    }

    const accepted = acknowledged.get(revisionId);
    if (accepted !== undefined) {
      return accepted.revision;
    }

    for (const storedEvent of inbox.values()) {
      if (storedEvent.revision.revisionId === revisionId) {
        return storedEvent.revision;
      }
    }

    return undefined;
  }

  private loadSnapshot(snapshot: ClientModelSnapshot): void {
    if (snapshot.schemaVersion !== 1) {
      throw new ClientModelError(
        'INVALID_SNAPSHOT',
        'Unsupported client model snapshot version.',
      );
    }

    assertSnapshotCursor(snapshot.downloadedSequence, 'Downloaded sequence');
    assertSnapshotCursor(
      snapshot.materializedSequence,
      'Materialized sequence',
    );
    if (snapshot.materializedSequence > snapshot.downloadedSequence) {
      throw new ClientModelError(
        'INVALID_SNAPSHOT',
        'Materialized sequence cannot exceed downloaded sequence.',
      );
    }

    const outbox = new Map<string, RevisionNode>();
    for (const revision of snapshot.outbox) {
      if (outbox.has(revision.revisionId)) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          `Duplicate outbox revision ${revision.revisionId}.`,
        );
      }
      outbox.set(revision.revisionId, cloneRevision(revision));
    }

    const acknowledged = new Map<string, AcknowledgedRevision>();
    const acknowledgedSequenceIds = new Set<number>();
    for (const entry of snapshot.acknowledged) {
      if (
        entry.revision.revisionId !== entry.receipt.revisionId ||
        !isSequence(entry.receipt.serverSequence) ||
        acknowledgedSequenceIds.has(entry.receipt.serverSequence) ||
        acknowledged.has(entry.revision.revisionId) ||
        outbox.has(entry.revision.revisionId)
      ) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          `Invalid acknowledgement for revision ${entry.revision.revisionId}.`,
        );
      }
      acknowledged.set(
        entry.revision.revisionId,
        cloneAcknowledgement(entry),
      );
      acknowledgedSequenceIds.add(entry.receipt.serverSequence);
    }

    const inbox = new Map<number, ServerRevisionEvent>();
    const sequenceByRevisionId = new Map<string, number>();
    for (const storedEvent of snapshot.inbox) {
      if (
        !isSequence(storedEvent.serverSequence) ||
        inbox.has(storedEvent.serverSequence) ||
        sequenceByRevisionId.has(storedEvent.revision.revisionId)
      ) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          'Inbox contains a duplicate or invalid event.',
        );
      }

      const accepted = acknowledged.get(storedEvent.revision.revisionId);
      if (
        accepted !== undefined &&
        (!sameRevision(accepted.revision, storedEvent.revision) ||
          accepted.receipt.serverSequence !== storedEvent.serverSequence)
      ) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          'Inbox event conflicts with an acknowledged revision.',
        );
      }


      const acceptedAtSequence = acknowledgementAtSequence(
        acknowledged,
        storedEvent.serverSequence,
      );
      if (
        outbox.has(storedEvent.revision.revisionId) ||
        (acceptedAtSequence !== undefined &&
          acceptedAtSequence.revision.revisionId !==
            storedEvent.revision.revisionId)
      ) {
        throw new ClientModelError(
          'INVALID_SNAPSHOT',
          'Inbox event conflicts with durable outbox or receipt state.',
        );
      }

      inbox.set(storedEvent.serverSequence, cloneEvent(storedEvent));
      sequenceByRevisionId.set(
        storedEvent.revision.revisionId,
        storedEvent.serverSequence,
      );
    }

    let contiguousSequence = 0;
    while (inbox.has(contiguousSequence + 1)) {
      contiguousSequence += 1;
    }
    if (contiguousSequence !== snapshot.downloadedSequence) {
      throw new ClientModelError(
        'INVALID_SNAPSHOT',
        'Downloaded cursor does not match the durable inbox prefix.',
      );
    }

    this.outboxByRevisionId = outbox;
    this.acknowledgedByRevisionId = acknowledged;
    this.inboxBySequence = inbox;
    this.eventSequenceByRevisionId = sequenceByRevisionId;
    this.downloadedCursor = snapshot.downloadedSequence;
    this.materializedCursor = snapshot.materializedSequence;
  }
}
