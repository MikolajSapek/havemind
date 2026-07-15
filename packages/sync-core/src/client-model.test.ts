import { describe, expect, it } from 'vitest';

import {
  ClientModelError,
  DurableClientModel,
  type RevisionReceipt,
  type ServerRevisionEvent,
} from './client-model.js';
import { RevisionDag, type RevisionNode } from './revision-dag.js';

function revision(
  revisionId: string,
  parentRevisionIds: readonly string[] = [],
  overrides: Partial<RevisionNode> = {},
): RevisionNode {
  return {
    revisionId,
    vaultId: 'vault-a',
    fileId: 'file-a',
    parentRevisionIds,
    blobHash: `hash-${revisionId}`,
    ...overrides,
  };
}

function event(
  serverSequence: number,
  node: RevisionNode,
): ServerRevisionEvent {
  return { serverSequence, revision: node };
}

function expectModelCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected ClientModelError.');
  } catch (error) {
    expect(error).toBeInstanceOf(ClientModelError);
    expect((error as ClientModelError).code).toBe(code);
  }
}

class TestServer {
  private readonly dag = new RevisionDag();
  private readonly receipts = new Map<string, RevisionReceipt>();
  private readonly events: ServerRevisionEvent[] = [];

  public push(node: RevisionNode): RevisionReceipt {
    const result = this.dag.add(node);
    const existing = this.receipts.get(node.revisionId);

    if (result === 'replayed') {
      if (existing === undefined) {
        throw new Error('Test server lost a replay receipt.');
      }
      return existing;
    }

    const receipt = {
      revisionId: node.revisionId,
      serverSequence: this.events.length + 1,
    };
    this.receipts.set(node.revisionId, receipt);
    this.events.push(event(receipt.serverSequence, node));
    return receipt;
  }

  public pull(afterSequence: number): ServerRevisionEvent[] {
    return this.events.filter(
      ({ serverSequence }) => serverSequence > afterSequence,
    );
  }

  public get acceptedRevisionIds(): string[] {
    return this.events.map(({ revision: node }) => node.revisionId);
  }
}

function materializeAll(client: DurableClientModel): void {
  for (;;) {
    const next = client.nextMaterialization();
    if (next === null) {
      return;
    }
    client.confirmMaterialized(next.serverSequence, next.revision.revisionId);
  }
}

describe('DurableClientModel', () => {
  it('retries the same durable outbox revision after acceptance-response loss', () => {
    const server = new TestServer();
    const client = new DurableClientModel();
    const localRevision = revision('r1');

    expect(client.queueRevision(localRevision)).toBe('queued');
    const firstAttempt = client.nextPushBatch()[0];
    expect(firstAttempt).toEqual(localRevision);

    const lostReceipt = server.push(firstAttempt as RevisionNode);
    const restarted = DurableClientModel.restore(client.snapshot());
    const retryReceipt = server.push(
      restarted.nextPushBatch()[0] as RevisionNode,
    );

    expect(retryReceipt).toEqual(lostReceipt);
    restarted.recordPushReceipt(retryReceipt);
    expect(restarted.nextPushBatch()).toEqual([]);
    expect(server.acceptedRevisionIds).toEqual(['r1']);
  });

  it('persists downloaded events separately from filesystem materialization', () => {
    const client = new DurableClientModel();
    client.receiveEvents([
      event(1, revision('r1')),
      event(2, revision('r2', ['r1'])),
    ]);

    expect(client.downloadedSequence).toBe(2);
    expect(client.materializedSequence).toBe(0);
    expect(client.nextMaterialization()?.revision.revisionId).toBe('r1');

    const crashedBeforeConfirmation = DurableClientModel.restore(
      client.snapshot(),
    );
    expect(
      crashedBeforeConfirmation.nextMaterialization()?.revision.revisionId,
    ).toBe('r1');

    crashedBeforeConfirmation.confirmMaterialized(1, 'r1');
    const restarted = DurableClientModel.restore(
      crashedBeforeConfirmation.snapshot(),
    );
    expect(restarted.nextMaterialization()?.revision.revisionId).toBe('r2');
    restarted.confirmMaterialized(2, 'r2');

    expect(restarted.materializedSequence).toBe(2);
    expect(restarted.materializedRevisionIds).toEqual(['r1', 'r2']);
  });

  it('stores out-of-order events but advances download only over a contiguous prefix', () => {
    const client = new DurableClientModel();
    const second = event(2, revision('r2', ['r1']));
    const first = event(1, revision('r1'));

    client.receiveEvents([second]);
    expect(client.downloadedSequence).toBe(0);
    expect(client.nextMaterialization()).toBeNull();

    client.receiveEvents([first]);
    expect(client.downloadedSequence).toBe(2);
    client.receiveEvents([second, first]);
    expect(client.snapshot().inbox).toHaveLength(2);
  });

  it('rejects a conflicting event sequence atomically', () => {
    const client = new DurableClientModel();
    client.receiveEvents([event(1, revision('r1'))]);
    const before = client.snapshot();

    expectModelCode(
      () => client.receiveEvents([event(1, revision('other'))]),
      'EVENT_SEQUENCE_REUSE',
    );
    expect(client.snapshot()).toEqual(before);
  });

  it('deduplicates local revisions and rejects revision ID reuse', () => {
    const client = new DurableClientModel();
    const first = revision('r1');

    expect(client.queueRevision(first)).toBe('queued');
    expect(client.queueRevision({ ...first })).toBe('duplicate');
    expectModelCode(
      () => client.queueRevision({ ...first, blobHash: 'different' }),
      'REVISION_ID_REUSE',
    );

    const batch = client.nextPushBatch(1);
    expect(batch).toHaveLength(1);
    expectModelCode(() => client.nextPushBatch(0), 'INVALID_LIMIT');
  });

  it('records push receipts idempotently and rejects unknown or conflicting receipts', () => {
    const client = new DurableClientModel();
    const first = revision('r1');
    client.queueRevision(first);

    expectModelCode(
      () =>
        client.recordPushReceipt({
          revisionId: 'unknown',
          serverSequence: 1,
        }),
      'UNKNOWN_PUSH_RECEIPT',
    );

    client.recordPushReceipt({ revisionId: 'r1', serverSequence: 1 });
    client.recordPushReceipt({ revisionId: 'r1', serverSequence: 1 });
    expect(client.acknowledgedRevisionIds).toEqual(['r1']);
    expectModelCode(
      () =>
        client.recordPushReceipt({ revisionId: 'r1', serverSequence: 2 }),
      'RECEIPT_MISMATCH',
    );
    expect(client.queueRevision(first)).toBe('duplicate');
  });

  it('closes a pending outbox entry when its accepted event arrives before the receipt', () => {
    const client = new DurableClientModel();
    const first = revision('r1');
    client.queueRevision(first);

    client.receiveEvents([event(1, first)]);

    expect(client.nextPushBatch()).toEqual([]);
    expect(client.acknowledgedRevisionIds).toEqual(['r1']);
    client.recordPushReceipt({ revisionId: 'r1', serverSequence: 1 });
  });

  it('rejects receipt sequence reuse across different revisions', () => {
    const client = new DurableClientModel();
    client.queueRevision(revision('r1'));
    client.queueRevision(revision('r2', ['r1']));
    client.recordPushReceipt({ revisionId: 'r1', serverSequence: 1 });

    expectModelCode(
      () =>
        client.recordPushReceipt({ revisionId: 'r2', serverSequence: 1 }),
      'RECEIPT_MISMATCH',
    );
    expectModelCode(
      () => client.receiveEvents([event(1, revision('other'))]),
      'RECEIPT_MISMATCH',
    );
  });

  it('rejects invalid materialization acknowledgements and corrupted snapshots', () => {
    const client = new DurableClientModel();
    client.receiveEvents([event(1, revision('r1'))]);

    expectModelCode(
      () => client.confirmMaterialized(2, 'r1'),
      'MATERIALIZATION_OUT_OF_ORDER',
    );
    expectModelCode(
      () => client.confirmMaterialized(1, 'other'),
      'MATERIALIZATION_MISMATCH',
    );

    const snapshot = client.snapshot();
    expectModelCode(
      () =>
        DurableClientModel.restore({
          ...snapshot,
          materializedSequence: 2,
        }),
      'INVALID_SNAPSHOT',
    );

    expectModelCode(
      () =>
        DurableClientModel.restore({
          schemaVersion: 1,
          outbox: [revision('r1')],
          acknowledged: [],
          inbox: [event(1, revision('r1'))],
          downloadedSequence: 1,
          materializedSequence: 0,
        }),
      'INVALID_SNAPSHOT',
    );

    expectModelCode(
      () =>
        DurableClientModel.restore({
          schemaVersion: 1,
          outbox: [],
          acknowledged: [
            {
              revision: revision('r1'),
              receipt: { revisionId: 'r1', serverSequence: 1 },
            },
            {
              revision: revision('r2', ['r1']),
              receipt: { revisionId: 'r2', serverSequence: 1 },
            },
          ],
          inbox: [],
          downloadedSequence: 0,
          materializedSequence: 0,
        }),
      'INVALID_SNAPSHOT',
    );
  });

  it('converges two restarted clients without losing an accepted offline revision', () => {
    const server = new TestServer();
    const clientA = new DurableClientModel();
    let clientB = new DurableClientModel();

    clientA.queueRevision(revision('r1'));
    const firstReceipt = server.push(
      clientA.nextPushBatch()[0] as RevisionNode,
    );
    clientA.recordPushReceipt(firstReceipt);

    clientA.receiveEvents(server.pull(clientA.downloadedSequence));
    clientB.receiveEvents(server.pull(clientB.downloadedSequence));
    materializeAll(clientA);
    materializeAll(clientB);

    clientB.queueRevision(revision('r2', ['r1']));
    clientB = DurableClientModel.restore(clientB.snapshot());
    const secondReceipt = server.push(
      clientB.nextPushBatch()[0] as RevisionNode,
    );

    clientB = DurableClientModel.restore(clientB.snapshot());
    const replayedReceipt = server.push(
      clientB.nextPushBatch()[0] as RevisionNode,
    );
    expect(replayedReceipt).toEqual(secondReceipt);
    clientB.recordPushReceipt(replayedReceipt);

    clientA.receiveEvents(server.pull(clientA.downloadedSequence));
    clientB.receiveEvents(server.pull(clientB.downloadedSequence));
    materializeAll(clientA);
    materializeAll(clientB);

    expect(server.acceptedRevisionIds).toEqual(['r1', 'r2']);
    expect(clientA.materializedRevisionIds).toEqual(['r1', 'r2']);
    expect(clientB.materializedRevisionIds).toEqual(['r1', 'r2']);
    expect(clientA.materializedSequence).toBe(clientB.materializedSequence);
    expect(clientA.nextPushBatch()).toEqual([]);
    expect(clientB.nextPushBatch()).toEqual([]);
  });
});
