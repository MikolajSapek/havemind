import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from '@havemind/sync-core';
import { protectedRevisionHeaderSchema } from '@havemind/protocol';

import type { LocalChangeOperation } from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import {
  OutboxLocalChangeRepository,
  type ProducerState,
} from './outbox-repository';

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

const FILE_ID = '22222222-2222-4222-8222-222222222222';

function makeOperation(
  overrides: Partial<LocalChangeOperation> = {},
): LocalChangeOperation {
  return {
    content: 'Hello\n',
    contentHash: 'hash-1',
    fileId: FILE_ID,
    kind: 'create',
    observedAt: 1,
    operationId: 'op-1',
    path: 'Notes/a.md',
    previousContent: null,
    previousContentHash: null,
    previousPath: null,
    ...overrides,
  };
}

function decode(envelope: OutboxEnvelope): string {
  return Buffer.from(envelope.payloadBase64, 'base64').toString('utf8');
}

class MemoryStore {
  state: ProducerState = { mappings: [], heads: {} };
  async load(): Promise<ProducerState> {
    return this.state;
  }
  async save(state: ProducerState): Promise<void> {
    this.state = state;
  }
}

function makeRepo(maxPayloadBytes?: number) {
  const store = new MemoryStore();
  const enqueued: OutboxEnvelope[] = [];
  let counter = 0;
  const repo = new OutboxLocalChangeRepository({
    identity: IDENTITY,
    store,
    enqueue: async (envelope) => {
      enqueued.push(envelope);
    },
    generateRevisionId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-00000000000${counter}`;
    },
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
  });
  return { repo, store, enqueued };
}

describe('OutboxLocalChangeRepository', () => {
  it('enqueues a root create envelope that decodes to the note', async () => {
    const { repo, enqueued } = makeRepo();

    await repo.commitLocalChange({
      operation: makeOperation(),
      removeFileId: null,
      upsertMapping: {
        collisionKey: 'notes/a.md',
        content: 'Hello\n',
        contentHash: 'hash-1',
        fileId: FILE_ID,
        path: 'Notes/a.md',
      },
    });

    expect(enqueued).toHaveLength(1);
    const envelope = enqueued[0] as OutboxEnvelope;
    expect(envelope.fileId).toBe(FILE_ID);
    const header = protectedRevisionHeaderSchema.parse(envelope.header);
    expect(header.parentRevisionIds).toEqual([]);
    expect(decodeRevisionPayload(decode(envelope))).toEqual({
      operation: 'create',
      path: 'Notes/a.md',
      previousPath: null,
      content: 'Hello\n',
    });
    // The mapping is now durable so a later modify resolves it.
    expect(await repo.listMappings()).toHaveLength(1);
  });

  it('parents a later update on the created revision', async () => {
    const { repo, enqueued } = makeRepo();
    await repo.commitLocalChange({
      operation: makeOperation(),
      removeFileId: null,
      upsertMapping: {
        collisionKey: 'notes/a.md',
        content: 'Hello\n',
        contentHash: 'hash-1',
        fileId: FILE_ID,
        path: 'Notes/a.md',
      },
    });
    const createRevisionId = (enqueued[0] as OutboxEnvelope).revisionId;

    await repo.commitLocalChange({
      operation: makeOperation({
        content: 'Hello again\n',
        contentHash: 'hash-2',
        kind: 'update',
        operationId: 'op-2',
      }),
      removeFileId: null,
      upsertMapping: {
        collisionKey: 'notes/a.md',
        content: 'Hello again\n',
        contentHash: 'hash-2',
        fileId: FILE_ID,
        path: 'Notes/a.md',
      },
    });

    expect(enqueued).toHaveLength(2);
    const updateHeader = protectedRevisionHeaderSchema.parse(
      (enqueued[1] as OutboxEnvelope).header,
    );
    expect(updateHeader.parentRevisionIds).toEqual([createRevisionId]);
  });

  it('rejects an oversized change before enqueue and leaves producer state untouched', async () => {
    const { repo, store, enqueued } = makeRepo(16);

    await expect(
      repo.commitLocalChange({
        operation: makeOperation({
          content: 'This note is well over the tiny per-payload limit.\n',
        }),
        removeFileId: null,
        upsertMapping: {
          collisionKey: 'notes/a.md',
          content: 'This note is well over the tiny per-payload limit.\n',
          contentHash: 'hash-1',
          fileId: FILE_ID,
          path: 'Notes/a.md',
        },
      }),
    ).rejects.toThrow(/too large/u);

    // The oversized change never entered the outbox and never mutated the map or
    // head — so it cannot silently wedge the outbox.
    expect(enqueued).toHaveLength(0);
    expect(store.state).toEqual({ mappings: [], heads: {} });
    expect(await repo.listMappings()).toHaveLength(0);
  });

  it('emits a delete tombstone and forgets the file head', async () => {
    const { repo, enqueued } = makeRepo();
    await repo.commitLocalChange({
      operation: makeOperation(),
      removeFileId: null,
      upsertMapping: {
        collisionKey: 'notes/a.md',
        content: 'Hello\n',
        contentHash: 'hash-1',
        fileId: FILE_ID,
        path: 'Notes/a.md',
      },
    });
    await repo.commitLocalChange({
      operation: makeOperation({
        content: null,
        contentHash: null,
        kind: 'delete',
        operationId: 'op-3',
      }),
      removeFileId: FILE_ID,
      upsertMapping: null,
    });

    expect(enqueued).toHaveLength(2);
    expect(decodeRevisionPayload(decode(enqueued[1] as OutboxEnvelope)).operation).toBe('delete');
    expect(await repo.listMappings()).toHaveLength(0);
  });
});
