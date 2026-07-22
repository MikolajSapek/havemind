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
    revisionId: null,
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

interface Materialized {
  fileId: string;
  path: string;
  contentHash: string;
  previousPath: string | null;
}

function makeRepo(maxPayloadBytes?: number) {
  const store = new MemoryStore();
  const enqueued: OutboxEnvelope[] = [];
  const materialized: Materialized[] = [];
  const forgotten: Array<{ fileId: string; path: string }> = [];
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
    onLocalMaterialized: async (m) => {
      materialized.push(m);
    },
    onLocalForgotten: async (m) => {
      forgotten.push(m);
    },
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
  });
  return { repo, store, enqueued, materialized, forgotten };
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
      kind: 'markdown',
      content: 'Hello\n',
      binaryContent: null,
    });
    // The mapping is now durable so a later modify resolves it.
    expect(await repo.listMappings()).toHaveLength(1);
  });

  it('returns the enqueued revisionId, matching the envelope', async () => {
    // Regression: the Activity feed used to record `operationId` because
    // callers had no way to learn the revisionId this repository actually
    // generated. commitLocalChange must surface it directly.
    const { repo, enqueued } = makeRepo();

    const revisionId = await repo.commitLocalChange({
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

    expect(revisionId).toBe((enqueued[0] as OutboxEnvelope).revisionId);
    expect(revisionId).not.toBe('op-1'); // never the operationId
  });

  it('returns null for a delete of a file that was never pushed', async () => {
    const { repo, enqueued } = makeRepo();

    const revisionId = await repo.commitLocalChange({
      operation: makeOperation({ content: null, contentHash: null, kind: 'delete' }),
      removeFileId: FILE_ID,
      upsertMapping: null,
    });

    expect(revisionId).toBeNull();
    expect(enqueued).toHaveLength(0);
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

  describe('shared apply-store seeding (FIX 1)', () => {
    it('seeds ownership+base for a locally authored create', async () => {
      const { repo, materialized, forgotten } = makeRepo();
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
      expect(materialized).toEqual([
        { fileId: FILE_ID, path: 'Notes/a.md', contentHash: 'hash-1', previousPath: null },
      ]);
      expect(forgotten).toEqual([]);
    });

    it('carries the previous path on a rename so the stale owner can be forgotten', async () => {
      const { repo, materialized } = makeRepo();
      // Seed a head so the rename is not demoted to a create.
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
          kind: 'rename',
          path: 'Notes/b.md',
          previousPath: 'Notes/a.md',
          contentHash: 'hash-1',
          operationId: 'op-r',
        }),
        removeFileId: null,
        upsertMapping: {
          collisionKey: 'notes/b.md',
          content: 'Hello\n',
          contentHash: 'hash-1',
          fileId: FILE_ID,
          path: 'Notes/b.md',
        },
      });
      expect(materialized[1]).toEqual({
        fileId: FILE_ID,
        path: 'Notes/b.md',
        contentHash: 'hash-1',
        previousPath: 'Notes/a.md',
      });
    });

    it('forgets ownership+base on a delete of a pushed file', async () => {
      const { repo, forgotten } = makeRepo();
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
          operationId: 'op-d',
        }),
        removeFileId: FILE_ID,
        upsertMapping: null,
      });
      expect(forgotten).toEqual([{ fileId: FILE_ID, path: 'Notes/a.md' }]);
    });
  });

  describe('remote-apply adoption (FIX 2)', () => {
    const REMOTE_FILE = '66666666-6666-4666-8666-666666666666';
    const REMOTE_REV = '77777777-7777-4777-8777-777777777777';

    it('adopts a remote mapping+head without enqueuing a revision', async () => {
      const { repo, enqueued, store } = makeRepo();
      await repo.adoptRemoteMapping(
        {
          collisionKey: 'notes/shared.md',
          content: 'SHARED\n',
          contentHash: 'hash-s',
          fileId: REMOTE_FILE,
          path: 'Notes/Shared.md',
        },
        REMOTE_REV,
      );
      expect(enqueued).toHaveLength(0);
      expect(store.state.mappings).toHaveLength(1);
      expect(store.state.heads[REMOTE_FILE]).toBe(REMOTE_REV);
      // A later local modify now parents on the adopted remote revision.
      await repo.commitLocalChange({
        operation: makeOperation({
          fileId: REMOTE_FILE,
          kind: 'update',
          content: 'SHARED edit\n',
          contentHash: 'hash-s2',
          path: 'Notes/Shared.md',
          operationId: 'op-e',
        }),
        removeFileId: null,
        upsertMapping: {
          collisionKey: 'notes/shared.md',
          content: 'SHARED edit\n',
          contentHash: 'hash-s2',
          fileId: REMOTE_FILE,
          path: 'Notes/Shared.md',
        },
      });
      const header = protectedRevisionHeaderSchema.parse(
        (enqueued[0] as OutboxEnvelope).header,
      );
      expect(header.parentRevisionIds).toEqual([REMOTE_REV]);
    });

    it('does not mint a duplicate mapping when adopting an existing fileId', async () => {
      const { repo, store } = makeRepo();
      const mapping = {
        collisionKey: 'notes/shared.md',
        content: 'SHARED\n',
        contentHash: 'hash-s',
        fileId: REMOTE_FILE,
        path: 'Notes/Shared.md',
      };
      await repo.adoptRemoteMapping(mapping, REMOTE_REV);
      await repo.adoptRemoteMapping(
        { ...mapping, content: 'SHARED2\n' },
        '88888888-8888-4888-8888-888888888888',
      );
      expect(store.state.mappings).toHaveLength(1);
      expect(store.state.mappings[0]?.content).toBe('SHARED2\n');
      expect(store.state.heads[REMOTE_FILE]).toBe(
        '88888888-8888-4888-8888-888888888888',
      );
    });

    it('forgets a remote mapping+head on remote delete', async () => {
      const { repo, store } = makeRepo();
      await repo.adoptRemoteMapping(
        {
          collisionKey: 'notes/shared.md',
          content: 'SHARED\n',
          contentHash: 'hash-s',
          fileId: REMOTE_FILE,
          path: 'Notes/Shared.md',
        },
        REMOTE_REV,
      );
      await repo.forgetRemoteMapping('notes/shared.md', REMOTE_FILE);
      expect(store.state.mappings).toHaveLength(0);
      expect(store.state.heads[REMOTE_FILE]).toBeUndefined();
    });
  });

  describe('binary attachments (F9)', () => {
    it('commits a binary change and enqueues an envelope carrying the raw bytes', async () => {
      const { repo, enqueued } = makeRepo();
      const bytes = new Uint8Array([0x00, 0xff, 0x80, 1, 2, 3]);
      const base64 = Buffer.from(bytes).toString('base64');

      await repo.commitLocalChange({
        operation: makeOperation({
          content: base64,
          contentHash: 'blob-hash-1',
          contentKind: 'binary',
          path: 'Attachments/img.png',
        }),
        removeFileId: null,
        upsertMapping: {
          collisionKey: 'attachments/img.png',
          content: base64,
          contentHash: 'blob-hash-1',
          contentKind: 'binary',
          fileId: FILE_ID,
          path: 'Attachments/img.png',
        },
      });

      expect(enqueued).toHaveLength(1);
      const decoded = decodeRevisionPayload(decode(enqueued[0] as OutboxEnvelope));
      expect(decoded.kind).toBe('binary');
      expect(decoded.content).toBeNull();
      // The exact raw bytes round-trip through the envelope — never markdown
      // `content`, which would be canonicalised and corrupt binary data.
      expect(decoded.binaryContent).toEqual(bytes);
    });

    it('does not throw RevisionPayloadTooLargeError for a large binary within the file cap (raised ceiling)', async () => {
      // A 20MB attachment (within MAX_BINARY_FILE_BYTES = 25MB, base64 ≈ 27MB)
      // would be rejected outright by the markdown default ceiling (512KB); a
      // binary change uses MAX_BINARY_PAYLOAD_BYTES (40MB) instead, so the
      // largest attachments the eligibility gate admits are never rejected here.
      const { repo, enqueued } = makeRepo();
      const bytes = new Uint8Array(20 * 1024 * 1024);
      const base64 = Buffer.from(bytes).toString('base64');

      await expect(
        repo.commitLocalChange({
          operation: makeOperation({
            content: base64,
            contentHash: 'blob-hash-big',
            contentKind: 'binary',
            path: 'Attachments/big.png',
          }),
          removeFileId: null,
          upsertMapping: {
            collisionKey: 'attachments/big.png',
            content: base64,
            contentHash: 'blob-hash-big',
            contentKind: 'binary',
            fileId: FILE_ID,
            path: 'Attachments/big.png',
          },
        }),
      ).resolves.not.toBeNull();

      expect(enqueued).toHaveLength(1);
      // Encoding a 20MB attachment takes ~8s under machine load; the default
      // 5s vitest timeout makes this test flaky. Perf headroom, not logic.
    }, 20_000);
  });
});
