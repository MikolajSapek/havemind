import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from '@havemind/sync-core';
import { protectedRevisionHeaderSchema } from '@havemind/protocol';

import {
  MAX_BINARY_FILE_BYTES,
  type LocalChangeOperation,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import {
  MAX_BINARY_PAYLOAD_BYTES,
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
  it('does not bypass a refused durable transaction with separate queue and mapping writes', async () => {
    const store = new MemoryStore();
    const enqueued: OutboxEnvelope[] = [];
    const repo = new OutboxLocalChangeRepository({
      identity: IDENTITY, store, enqueue: async (envelope) => { enqueued.push(envelope); },
      generateRevisionId: () => '00000000-0000-4000-8000-000000000001',
      recovery: {
        startProducerRecovery: async () => false,
        pendingProducerRecoveries: async () => [],
        recoverProducerQueue: async () => undefined,
        completeProducerRecovery: async () => undefined,
        enqueueAutomaticMerge: async () => undefined,
      },
    });
    await expect(repo.commitLocalChange({ operation: makeOperation(), removeFileId: null,
      upsertMapping: { fileId: FILE_ID, path: 'Notes/a.md', collisionKey: 'notes/a.md',  contentHash: 'hash-1' },
    })).rejects.toThrow('refused');
    expect(enqueued).toEqual([]);
    expect(store.state).toEqual({ mappings: [], heads: {} });
  });

  it('retains both file identities when separate files commit concurrently', async () => {
    const { repo, store, enqueued } = makeRepo();
    const ids = [FILE_ID, '55555555-5555-4555-8555-555555555555'];
    await Promise.all(ids.map((fileId, index) => repo.commitLocalChange({
      operation: makeOperation({ fileId, path: `${index}.md`, operationId: `op-${index}` }),
      removeFileId: null,
      upsertMapping: { fileId, path: `${index}.md`, collisionKey: `${index}.md`,  contentHash: 'hash-1' },
    })));
    expect(enqueued).toHaveLength(2);
    expect(store.state.mappings.map((m) => m.fileId).sort()).toEqual(ids.sort());
    expect(Object.keys(store.state.heads).sort()).toEqual(ids.sort());
  });

  it('enqueues a root create envelope that decodes to the note', async () => {
    const { repo, enqueued } = makeRepo();

    await repo.commitLocalChange({
      operation: makeOperation(),
      removeFileId: null,
      upsertMapping: {
        collisionKey: 'notes/a.md',
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
          contentHash: 'hash-1',
          fileId: FILE_ID,
          path: 'Notes/a.md',
        },
      }),
    ).rejects.toThrow(/too large/u);

    // The oversized change never entered the outbox and never mutated the map or
    // head, so it cannot silently wedge the outbox.
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
          contentHash: 'hash-1',
          fileId: FILE_ID,
          path: 'Notes/a.md',
        },
      });
      expect(materialized).toEqual([
        {
          fileId: FILE_ID,
          path: 'Notes/a.md',
          contentHash: 'hash-1',
          content: 'Hello\n',
          previousPath: null,
        },
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
          contentHash: 'hash-1',
          fileId: FILE_ID,
          path: 'Notes/b.md',
        },
      });
      expect(materialized[1]).toEqual({
        fileId: FILE_ID,
        path: 'Notes/b.md',
        contentHash: 'hash-1',
        content: 'Hello\n',
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
        { ...mapping, contentHash: 'hash-s2' },
        '88888888-8888-4888-8888-888888888888',
      );
      expect(store.state.mappings).toHaveLength(1);
      expect(store.state.mappings[0]?.contentHash).toBe('hash-s2');
      expect(store.state.heads[REMOTE_FILE]).toBe(
        '88888888-8888-4888-8888-888888888888',
      );
    });

    it('forgets a remote mapping+head on remote delete', async () => {
      const { repo, store } = makeRepo();
      await repo.adoptRemoteMapping(
        {
          collisionKey: 'notes/shared.md',
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

  /**
   * Regression for the fork observed in production on 2026-09-19, reconstructed
   * from the server's revision DAG for the vault's Welcome note (server
   * sequences 88 through 95, file 6a9b8bc7).
   *
   * What the server recorded:
   *
   *   seq 88  PC     blob 681723e4ce  parent: (seq 87)
   *   seq 93  phone  blob 106827a729  parent: seq 88
   *   seq 95  PC     blob 106827a729  parent: seq 88   <- same parent, same blob
   *
   * Two devices published the SAME content with the SAME parent under two
   * revision ids, so the file gained a second head that nothing ever retired.
   * By sequence 104 the branch was eight revisions deep and the note carried
   * three conflict copies on disk.
   *
   * The mechanism is local: `commitLocalChange` parents a push solely on
   * `state.heads[fileId]`, so any apply path that materialises a peer's revision
   * WITHOUT advancing that head leaves the next local push descending from a
   * superseded revision. The merge path in `vault-apply.ts` (`tryMergeApply`) is
   * exactly such a path, and its comment calls the omission deliberate.
   *
   * These tests pin the producer-side contract the fix has to satisfy. They are
   * written against the repository alone (no vault, no transport) because the
   * defect lives in how a head is chosen, not in how a file is written.
   */
  describe('a peer revision this device absorbed must not fork the DAG', () => {
    const SHARED_FILE = '6a9b8bc7-0000-4000-8000-000000000001';
    // Stands in for seq 88, the last revision both devices agreed on.
    const AGREED_HEAD = '2b509884-0000-4000-8000-000000000088';
    // Stands in for seq 93, the peer's revision built on top of seq 88.
    const PEER_HEAD = 'cb833a66-0000-4000-8000-000000000093';

    function sharedMapping(content: string, contentHash: string) {
      return {
        collisionKey: 'notes/welcome.md',
        content,
        contentHash,
        fileId: SHARED_FILE,
        path: 'Notes/Welcome.md',
      };
    }

    /** Brings the producer to the shared state at sequence 88. */
    async function seedAgreedHead(repo: OutboxLocalChangeRepository) {
      await repo.adoptRemoteMapping(sharedMapping('AGREED\n', 'hash-88'), AGREED_HEAD);
    }

    it('parents the next local push on the absorbed peer revision, not the superseded head', async () => {
      const { repo, enqueued } = makeRepo();
      await seedAgreedHead(repo);

      // The peer's seq 93 arrives and this device absorbs it. However the apply
      // side resolved it (clean write, convergence, or three-way merge), the
      // peer's revision is now part of this device's history.
      await repo.adoptRemoteMapping(sharedMapping('PEER\n', 'hash-93'), PEER_HEAD);

      // The user types again and this device pushes. This is seq 95.
      await repo.commitLocalChange({
        operation: makeOperation({
          fileId: SHARED_FILE,
          kind: 'update',
          content: 'PEER then mine\n',
          contentHash: 'hash-95',
          path: 'Notes/Welcome.md',
          operationId: 'op-95',
        }),
        removeFileId: null,
        upsertMapping: sharedMapping('PEER then mine\n', 'hash-95'),
      });

      const header = protectedRevisionHeaderSchema.parse(
        (enqueued[0] as OutboxEnvelope).header,
      );
      // In production this was [AGREED_HEAD], which forked the file.
      expect(header.parentRevisionIds).toEqual([PEER_HEAD]);
      expect(header.parentRevisionIds).not.toContain(AGREED_HEAD);
    });

    it('leaves the adopted mapping byte-identical, so the reflected write dedupes', async () => {
      // The echo of an apply-side write is suppressed one layer up, by
      // `ObsidianVaultAdapter.commitModify` ("contentHash === mapping.contentHash
      // → return null"), which is why a duplicate never reaches this repository
      // in the first place. That guard can only fire if the mapping this
      // adoption stores matches the bytes the apply side put on disk, so that is
      // what is pinned here. In production the duplicate blob 106827a729 at
      // sequence 95 means the two disagreed.
      const { repo, store } = makeRepo();
      await seedAgreedHead(repo);
      await repo.adoptRemoteMapping(sharedMapping('PEER\n', 'hash-93'), PEER_HEAD);

      const mapping = store.state.mappings.find((m) => m.fileId === SHARED_FILE);
      expect(mapping).not.toHaveProperty('content');
      expect(mapping?.contentHash).toBe('hash-93');
      expect(store.state.heads[SHARED_FILE]).toBe(PEER_HEAD);
    });

    it('keeps a merge result descending from the peer revision it resolved', async () => {
      const { repo, enqueued, store } = makeRepo();
      await seedAgreedHead(repo);
      await repo.adoptRemoteMapping(sharedMapping('PEER\n', 'hash-93'), PEER_HEAD);

      // A three-way merge combined the peer's edit with an unsent local one and
      // wrote the result to disk. That write reflects back as a local change, and
      // it is a genuinely new revision: it must be enqueued, but as a DESCENDANT
      // of the peer revision it resolved, never as a sibling of it.
      await repo.commitLocalChange({
        operation: makeOperation({
          fileId: SHARED_FILE,
          kind: 'update',
          content: 'PEER\nplus mine\n',
          contentHash: 'hash-merged',
          path: 'Notes/Welcome.md',
          operationId: 'op-merged',
        }),
        removeFileId: null,
        upsertMapping: sharedMapping('PEER\nplus mine\n', 'hash-merged'),
      });

      expect(enqueued).toHaveLength(1);
      const header = protectedRevisionHeaderSchema.parse(
        (enqueued[0] as OutboxEnvelope).header,
      );
      expect(header.parentRevisionIds).toContain(PEER_HEAD);
      // And the producer's head moves on to the merge, so the file has one tip.
      expect(store.state.heads[SHARED_FILE]).toBe(header.revisionId);
    });

    it('does not demote an update to a root create when a head is known', async () => {
      // A root create carries no parent at all, which is the other way a file
      // acquires a second head. 94 of the 110 production revisions had no parent
      // row; this pins that an adopted head is always honoured.
      const { repo, enqueued } = makeRepo();
      await seedAgreedHead(repo);

      await repo.commitLocalChange({
        operation: makeOperation({
          fileId: SHARED_FILE,
          kind: 'update',
          content: 'AGREED edited\n',
          contentHash: 'hash-89',
          path: 'Notes/Welcome.md',
          operationId: 'op-89',
        }),
        removeFileId: null,
        upsertMapping: sharedMapping('AGREED edited\n', 'hash-89'),
      });

      const envelope = enqueued[0] as OutboxEnvelope;
      const header = protectedRevisionHeaderSchema.parse(envelope.header);
      expect(header.parentRevisionIds).toEqual([AGREED_HEAD]);
      expect(decodeRevisionPayload(decode(envelope)).operation).toBe('update');
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
      // The exact raw bytes round-trip through the envelope, never markdown
      // `content`, which would be canonicalised and corrupt binary data.
      expect(decoded.binaryContent).toEqual(bytes);
    });

    it('does not throw RevisionPayloadTooLargeError for a large binary within the file cap (raised ceiling)', async () => {
      // A 1 MiB attachment (base64 ~1.4 MB) is over the 512 KB markdown
      // default, so passing proves a binary change gets the raised ceiling.
      const { repo, enqueued } = makeRepo();
      const bytes = new Uint8Array(1024 * 1024);
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
            contentHash: 'blob-hash-big',
            contentKind: 'binary',
            fileId: FILE_ID,
            path: 'Attachments/big.png',
          },
        }),
      ).resolves.not.toBeNull();

      expect(enqueued).toHaveLength(1);
    });

    it('the raised ceiling holds the largest attachment the file cap admits', () => {
      // Base64 grows bytes by 4/3; the rest of the JSON payload (path, hashes,
      // ids) is well under 1 MB, so this bounds the real envelope size.
      const base64Bytes = 4 * Math.ceil(MAX_BINARY_FILE_BYTES / 3);
      expect(base64Bytes + 1024 * 1024).toBeLessThan(MAX_BINARY_PAYLOAD_BYTES);
    });
  });
});
