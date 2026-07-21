import { canonicalizeMarkdown, hashPlaintext, sha256Hex } from '@havemind/protocol';
import { describe, expect, it } from 'vitest';

import {
  CANONICALIZATION_REBASE_VERSION,
  rebaseCanonicalizedHashes,
  type RebaseVaultPort,
} from './canonicalization-rebase';
import {
  VaultChangeObserver,
  type LocalChangeCommit,
  type LocalChangeRepository,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { reconcileVaultState } from '../sync/reconciliation';

const PERSIST_KEY = 'syncState';
const PRODUCER_KEY = 'pushProducer';
const MARKER_KEY = 'canonicalizationRebaseVersion';

/** A vault whose on-disk bytes are exactly what a user's editor wrote. */
class FakeVault implements RebaseVaultPort {
  constructor(private readonly files: Map<string, string>) {}
  exists(path: string): boolean {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? '';
  }
}

/** In-memory plugin-data blob port. */
function dataPort(initial: Record<string, unknown>): {
  load: () => Promise<unknown>;
  save: (data: Record<string, unknown>) => Promise<void>;
  current: () => Record<string, unknown>;
} {
  let store = initial;
  return {
    load: async () => store,
    save: async (data) => {
      store = data;
    },
    current: () => store,
  };
}

function keys(): { markerKey: string; persistKey: string; producerKey: string } {
  return { markerKey: MARKER_KEY, persistKey: PERSIST_KEY, producerKey: PRODUCER_KEY };
}

describe('rebaseCanonicalizedHashes', () => {
  it('rebases old-style raw hashes to the canonical form once and marks the version', async () => {
    // Arrange: a file whose on-disk bytes have NO trailing newline. The stored
    // state was hashed by the OLD canonicalization (raw, CRLF-only) so its
    // content and hashes lack the trailing newline the new form adds.
    const path = 'Notes/Plan.md';
    const fileId = 'file-1';
    const onDisk = 'Body line'; // byte-exact, no trailing newline
    const oldHash = await sha256Hex(onDisk); // OLD: raw sha256, no canonicalisation

    const data = {
      [PRODUCER_KEY]: {
        mappings: [
          { collisionKey: path.toLowerCase(), content: onDisk, contentHash: oldHash, fileId, path },
        ],
        heads: { [fileId]: 'rev-1' },
      },
      [PERSIST_KEY]: {
        version: 1,
        cursor: 7,
        outbox: [],
        locallyAuthored: [],
        deferred: [],
        quarantine: [],
        pathOwners: { [path]: fileId },
        baseHashes: { [fileId]: oldHash },
      },
    };
    const port = dataPort(data);
    const vault = new FakeVault(new Map([[path, onDisk]]));

    // Act
    const result = await rebaseCanonicalizedHashes({
      data: port,
      vault,
      hash: (content) => hashPlaintext(content),
      canonicalize: canonicalizeMarkdown,
      keys: keys(),
    });

    // Assert: exactly one mapping + one base hash rebased to the new form.
    const newHash = await hashPlaintext(onDisk);
    expect(newHash).not.toBe(oldHash);
    expect(result).toEqual({
      ran: true,
      mappingsRebased: 1,
      baseHashesRebased: 1,
      missingFiles: 0,
    });

    const saved = port.current();
    const producer = saved[PRODUCER_KEY] as {
      mappings: LocalFileMapping[];
      heads: Record<string, string>;
    };
    expect(producer.mappings[0]?.content).toBe('Body line\n');
    expect(producer.mappings[0]?.contentHash).toBe(newHash);
    expect(producer.heads).toEqual({ [fileId]: 'rev-1' }); // untouched
    const persist = saved[PERSIST_KEY] as { baseHashes: Record<string, string>; cursor: number };
    expect(persist.baseHashes[fileId]).toBe(newHash);
    expect(persist.cursor).toBe(7); // other sync-state fields untouched
    expect(saved[MARKER_KEY]).toBe(CANONICALIZATION_REBASE_VERSION);
  });

  it('runs exactly once — a second invocation is a no-op', async () => {
    const path = 'A.md';
    const fileId = 'f';
    const port = dataPort({
      [MARKER_KEY]: CANONICALIZATION_REBASE_VERSION,
      [PRODUCER_KEY]: { mappings: [], heads: {} },
      [PERSIST_KEY]: { baseHashes: {} },
    });
    const vault = new FakeVault(new Map([[path, 'x']]));

    const result = await rebaseCanonicalizedHashes({
      data: port,
      vault,
      hash: (content) => hashPlaintext(content),
      canonicalize: canonicalizeMarkdown,
      keys: keys(),
    });

    expect(result.ran).toBe(false);
    void fileId;
  });

  it('leaves entries for files missing on disk untouched and counts them', async () => {
    // A file that was deleted on disk before the upgrade: its stored hash cannot
    // be recomputed, so it is left as-is (documented behaviour).
    const path = 'Gone.md';
    const fileId = 'gone';
    const oldHash = await sha256Hex('whatever');
    const port = dataPort({
      [PRODUCER_KEY]: {
        mappings: [
          { collisionKey: path.toLowerCase(), content: 'whatever', contentHash: oldHash, fileId, path },
        ],
        heads: {},
      },
      [PERSIST_KEY]: { baseHashes: { [fileId]: oldHash } },
    });
    const vault = new FakeVault(new Map()); // empty vault: nothing on disk

    const result = await rebaseCanonicalizedHashes({
      data: port,
      vault,
      hash: (content) => hashPlaintext(content),
      canonicalize: canonicalizeMarkdown,
      keys: keys(),
    });

    expect(result.mappingsRebased).toBe(0);
    expect(result.baseHashesRebased).toBe(0);
    expect(result.missingFiles).toBeGreaterThanOrEqual(1);
    const saved = port.current();
    const persist = saved[PERSIST_KEY] as { baseHashes: Record<string, string> };
    expect(persist.baseHashes[fileId]).toBe(oldHash); // untouched
  });

  it('prevents a spurious revision on the next reconcile for an unchanged file', async () => {
    // Arrange: the full upgrade path. Old state hashed a no-trailing-newline file
    // raw; the new reconcile canonicalises the on-disk read, so WITHOUT the rebase
    // the stored content would mismatch and mint a spurious revision.
    const path = 'Notes/Unchanged.md';
    const fileId = 'file-unchanged';
    const onDisk = 'Stable content'; // no trailing newline on disk
    const oldHash = await sha256Hex(onDisk);
    const port = dataPort({
      [PRODUCER_KEY]: {
        mappings: [
          { collisionKey: path.toLowerCase(), content: onDisk, contentHash: oldHash, fileId, path },
        ],
        heads: { [fileId]: 'rev-1' },
      },
      [PERSIST_KEY]: {
        version: 1,
        cursor: 0,
        outbox: [],
        locallyAuthored: [],
        deferred: [],
        quarantine: [],
        pathOwners: { [path]: fileId },
        baseHashes: { [fileId]: oldHash },
      },
    });
    const vault = new FakeVault(new Map([[path, onDisk]]));

    // Act: rebase, then drive a real reconcile pass over the rebased mappings.
    await rebaseCanonicalizedHashes({
      data: port,
      vault,
      hash: (content) => hashPlaintext(content),
      canonicalize: canonicalizeMarkdown,
      keys: keys(),
    });

    const rebasedMappings = (
      port.current()[PRODUCER_KEY] as { mappings: LocalFileMapping[] }
    ).mappings;
    const enqueued: LocalChangeCommit[] = [];
    const repository: LocalChangeRepository = {
      async commitLocalChange(commit) {
        enqueued.push(commit);
        return 'new-rev';
      },
      async listMappings() {
        return rebasedMappings;
      },
    };
    const snapshot: VaultSnapshotPort = {
      async listSyncablePaths() {
        return [path];
      },
      async listAllPaths() {
        return [path];
      },
      async readText(readPath) {
        return vault.read(readPath);
      },
      async readBinary() {
        return new Uint8Array(0);
      },
    };
    const observer = new VaultChangeObserver({
      clock: () => 0,
      generateFileId: () => 'unused',
      generateOperationId: () => 'op',
      repository,
      vault: snapshot,
    });

    const reconciled = await reconcileVaultState({ observer, repository, vault: snapshot });

    // Assert: the file is seen as unchanged — no revision, no conflict artifact.
    expect(reconciled.unchanged).toBe(1);
    expect(reconciled.updated).toBe(0);
    expect(reconciled.created).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('leaves a binary attachment mapping and its base hash unchanged while rebasing a sibling markdown entry (F9)', async () => {
    // Binary attachments are hashed over RAW bytes, which are
    // canonicalisation-independent — rebasing them through the markdown
    // canonicalize/hash path would corrupt the byte hash. Only the markdown
    // sibling should be touched.
    const markdownPath = 'Notes/Plan.md';
    const markdownFileId = 'file-md';
    const markdownOnDisk = 'Body line'; // no trailing newline: OLD hash differs from NEW
    const markdownOldHash = await sha256Hex(markdownOnDisk);

    const binaryPath = 'Images/pic.png';
    const binaryFileId = 'file-binary';
    const binaryContent = 'YmFzZTY0Ynl0ZXM='; // arbitrary base64 of raw bytes
    const binaryContentHash = 'raw-byte-hash-unchanged';

    const port = dataPort({
      [PRODUCER_KEY]: {
        mappings: [
          {
            collisionKey: markdownPath.toLowerCase(),
            content: markdownOnDisk,
            contentHash: markdownOldHash,
            fileId: markdownFileId,
            path: markdownPath,
          },
          {
            collisionKey: binaryPath.toLowerCase(),
            content: binaryContent,
            contentHash: binaryContentHash,
            contentKind: 'binary',
            fileId: binaryFileId,
            path: binaryPath,
          },
        ],
        heads: {},
      },
      [PERSIST_KEY]: {
        baseHashes: {
          [markdownFileId]: markdownOldHash,
          [binaryFileId]: binaryContentHash,
        },
      },
    });
    const vault = new FakeVault(
      new Map([
        [markdownPath, markdownOnDisk],
        [binaryPath, binaryContent],
      ]),
    );

    const result = await rebaseCanonicalizedHashes({
      data: port,
      vault,
      hash: (content) => hashPlaintext(content),
      canonicalize: canonicalizeMarkdown,
      keys: keys(),
    });

    expect(result.mappingsRebased).toBe(1);
    expect(result.baseHashesRebased).toBe(1);

    const saved = port.current();
    const producer = saved[PRODUCER_KEY] as { mappings: LocalFileMapping[] };
    const binaryMapping = producer.mappings.find((m) => m.fileId === binaryFileId);
    expect(binaryMapping?.content).toBe(binaryContent);
    expect(binaryMapping?.contentHash).toBe(binaryContentHash);

    const markdownMapping = producer.mappings.find((m) => m.fileId === markdownFileId);
    expect(markdownMapping?.content).toBe('Body line\n');
    expect(markdownMapping?.contentHash).not.toBe(markdownOldHash);

    const persist = saved[PERSIST_KEY] as { baseHashes: Record<string, string> };
    expect(persist.baseHashes[binaryFileId]).toBe(binaryContentHash);
    expect(persist.baseHashes[markdownFileId]).not.toBe(markdownOldHash);
  });
});
