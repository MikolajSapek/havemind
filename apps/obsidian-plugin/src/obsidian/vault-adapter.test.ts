import { hashBlob } from '@havemind/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_BINARY_FILE_BYTES,
  SYNCABLE_BINARY_EXTENSIONS,
  VaultChangeObserver,
  bytesToBase64,
  classifyVaultPath,
  type LocalChangeCommit,
  type LocalChangeRepository,
  type LocalFileMapping,
  type LocalVaultError,
  type VaultSnapshotPort,
} from './vault-adapter';

const FILE_ID = '29ab3ae1-067c-46e9-81e8-04845d622ac5';
const OPERATION_ID = '9e53d494-3945-4c3f-a637-1d73a28ad8ef';

class MemoryRepository implements LocalChangeRepository {
  readonly commits: LocalChangeCommit[] = [];
  readonly mappings = new Map<string, LocalFileMapping>();
  failNextCommit = false;

  constructor(initialMappings: readonly LocalFileMapping[] = []) {
    for (const mapping of initialMappings) {
      this.mappings.set(mapping.fileId, mapping);
    }
  }

  async listMappings(): Promise<readonly LocalFileMapping[]> {
    return [...this.mappings.values()];
  }

  /** Deterministic revisionId per commit, distinct from the operationId. */
  nextRevisionId(): string {
    return `rev-${this.commits.length + 1}`;
  }

  async commitLocalChange(commit: LocalChangeCommit): Promise<string | null> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new DOMException('Quota exhausted.', 'QuotaExceededError');
    }

    const revisionId = this.nextRevisionId();
    this.commits.push(structuredClone(commit));
    if (commit.removeFileId !== null) {
      this.mappings.delete(commit.removeFileId);
    }
    if (commit.upsertMapping !== null) {
      this.mappings.set(commit.upsertMapping.fileId, commit.upsertMapping);
    }
    return revisionId;
  }
}

class MemoryVault implements VaultSnapshotPort {
  readonly contents = new Map<string, string>();
  readonly binaryContents = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  async listSyncablePaths(): Promise<readonly string[]> {
    return [...this.contents.keys(), ...this.binaryContents.keys()];
  }

  async readText(path: string): Promise<string> {
    this.reads.push(path);
    const content = this.contents.get(path);
    if (content === undefined) throw new Error(`Missing test file: ${path}`);
    return content;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    const bytes = this.binaryContents.get(path);
    if (bytes === undefined) throw new Error(`Missing test file: ${path}`);
    return bytes;
  }

  async listAllPaths(): Promise<readonly string[]> {
    return [...this.contents.keys(), ...this.binaryContents.keys()];
  }
}

describe('vault path eligibility', () => {
  it('accepts canonical Markdown paths and ignores reserved, unsafe, and non-syncable paths', () => {
    expect(classifyVaultPath('Notes/Cafe\u0301.md')).toEqual({
      canonicalPath: 'Notes/Café.md',
      collisionKey: 'notes/café.md',
      eligible: true,
      kind: 'markdown',
    });

    for (const path of [
      '.obsidian/plugins/example/data.json',
      '.trash/Deleted.md',
      'Havemind Conflicts/Plan.md',
      '../escape.md',
      'notes/archive.zip',
    ]) {
      expect(classifyVaultPath(path)).toEqual({ eligible: false });
    }
  });

  it('accepts an allowlisted binary attachment path (F9)', () => {
    expect(classifyVaultPath('image.png')).toEqual({
      canonicalPath: 'image.png',
      collisionKey: 'image.png',
      eligible: true,
      kind: 'binary',
    });
  });

  it.each(SYNCABLE_BINARY_EXTENSIONS)(
    'classifies every allowlisted binary extension (.%s) as kind binary',
    (extension) => {
      expect(classifyVaultPath(`Attachments/asset.${extension}`)).toEqual({
        canonicalPath: `Attachments/asset.${extension}`,
        collisionKey: `attachments/asset.${extension}`,
        eligible: true,
        kind: 'binary',
      });
    },
  );

  it('excludes a binary attachment under the reserved Havemind Conflicts directory', () => {
    expect(classifyVaultPath('Havemind Conflicts/x.png')).toEqual({
      eligible: false,
    });
  });

  it('excludes a binary attachment under a dotpath directory', () => {
    expect(classifyVaultPath('.hidden/x.png')).toEqual({ eligible: false });
  });
});

describe('VaultChangeObserver', () => {
  it('durably records a normalized create and deduplicates an identical modify', async () => {
    const vault = new MemoryVault();
    vault.contents.set('Notes/Plan.md', 'First\r\nline');
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    const created = await observer.observeCreate('Notes/Plan.md');
    const duplicate = await observer.observeModify('Notes/Plan.md');

    expect(created).toMatchObject({
      content: 'First\nline\n',
      fileId: FILE_ID,
      kind: 'create',
      path: 'Notes/Plan.md',
      previousContent: null,
      previousPath: null,
    });
    expect(created?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(duplicate).toBeNull();
    expect(repository.commits).toHaveLength(1);
    expect(repository.mappings.get(FILE_ID)).toMatchObject({
      content: 'First\nline\n',
      fileId: FILE_ID,
      path: 'Notes/Plan.md',
    });
  });

  it('dedupes a modify that differs from the mapping only by a trailing newline (AUD-03)', async () => {
    // A formatter that only appended a trailing newline after Havemind's apply
    // must NOT mint a spurious revision: the producer hashes the CANONICAL form,
    // so 'Body' and 'Body\n' share a content hash and the modify is a no-op.
    const vault = new MemoryVault();
    vault.contents.set('Notes/Plan.md', 'Body');
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    const created = await observer.observeCreate('Notes/Plan.md');
    vault.contents.set('Notes/Plan.md', 'Body\n\n'); // formatter reflow, same text
    const reflowed = await observer.observeModify('Notes/Plan.md');

    expect(created?.content).toBe('Body\n');
    expect(reflowed).toBeNull();
    expect(repository.commits).toHaveLength(1);
  });

  it('returns the repository-generated revisionId on the operation, never the operationId', async () => {
    // Regression: the Activity feed used to record `operationId` (a
    // client-only idempotency key) as if it were the revisionId, breaking
    // restore and local/remote-echo dedup. The observer must surface the real
    // id the repository (outbox) actually generated and enqueued.
    const vault = new MemoryVault();
    vault.contents.set('Notes/Plan.md', 'First');
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    const created = await observer.observeCreate('Notes/Plan.md');

    expect(created?.operationId).toBe(OPERATION_ID);
    expect(created?.revisionId).toBe('rev-1');
    expect(created?.revisionId).not.toBe(created?.operationId);
  });

  it('records the durable previous snapshot before an update can be uploaded', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      mapping('Notes/Plan.md', 'old text', 'old-hash'),
    ]);
    vault.contents.set('Notes/Plan.md', 'new text');
    repository.failNextCommit = true;
    const observer = createObserver(vault, repository);

    await expect(observer.observeModify('Notes/Plan.md')).rejects.toThrow(
      'Quota exhausted.',
    );
    expect(repository.commits).toHaveLength(0);
    expect(repository.mappings.get(FILE_ID)?.content).toBe('old text');

    const operation = await observer.observeModify('Notes/Plan.md');
    expect(operation).toMatchObject({
      content: 'new text\n',
      kind: 'update',
      previousContent: 'old text',
      previousContentHash: 'old-hash',
    });
    expect(repository.commits).toHaveLength(1);
  });

  it('keeps the file identity across rename and detects target path collisions', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      mapping('Notes/Old.md', 'content', 'old-hash'),
      {
        ...mapping(
          'Notes/Occupied.md',
          'other',
          'other-hash',
        ),
        fileId: 'c6e31f70-bbba-48ac-b7c4-aa754cae334d',
      },
    ]);
    vault.contents.set('Notes/New.md', 'content');
    vault.contents.set('Notes/Occupied.md', 'content');
    const observer = createObserver(vault, repository);

    const renamed = await observer.observeRename(
      'Notes/Old.md',
      'Notes/New.md',
    );

    expect(renamed).toMatchObject({
      fileId: FILE_ID,
      kind: 'rename',
      path: 'Notes/New.md',
      previousPath: 'Notes/Old.md',
    });
    await expect(
      observer.observeRename('Notes/New.md', 'Notes/Occupied.md'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalVaultError>>({
        code: 'path-collision',
      }),
    );
    expect(repository.commits).toHaveLength(1);
  });

  it('uses the last durable content for delete without reading the removed file', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      mapping('Notes/Deleted.md', 'recover me', 'durable-hash'),
    ]);
    const observer = createObserver(vault, repository);

    const deleted = await observer.observeDelete('Notes/Deleted.md');

    expect(deleted).toMatchObject({
      content: null,
      contentHash: null,
      fileId: FILE_ID,
      kind: 'delete',
      path: 'Notes/Deleted.md',
      previousContent: 'recover me',
      previousContentHash: 'durable-hash',
    });
    expect(vault.reads).toEqual([]);
    expect(repository.mappings.has(FILE_ID)).toBe(false);
  });

  it('treats a rename out of the shared namespace as delete and a rename in as create', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      mapping('Notes/Shared.md', 'shared', 'shared-hash'),
    ]);
    vault.contents.set('Notes/Imported.md', 'imported');
    const observer = createObserver(vault, repository);

    const removed = await observer.observeRename(
      'Notes/Shared.md',
      'Havemind Conflicts/Shared.md',
    );
    const imported = await observer.observeRename(
      '.obsidian/Imported.md',
      'Notes/Imported.md',
    );

    expect(removed?.kind).toBe('delete');
    expect(imported).toMatchObject({ kind: 'create', path: 'Notes/Imported.md' });
    expect(imported?.fileId).toBe(FILE_ID);
  });

  it('serializes overlapping event callbacks so later reads see the committed base', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      mapping('Notes/Plan.md', 'zero', 'zero-hash'),
    ]);
    vault.contents.set('Notes/Plan.md', 'one');
    let releaseFirstCommit: (() => void) | undefined;
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    const originalCommit = repository.commitLocalChange.bind(repository);
    let commitCount = 0;
    repository.commitLocalChange = vi.fn(async (commit) => {
      commitCount += 1;
      if (commitCount === 1) await firstCommitGate;
      return originalCommit(commit);
    });
    const observer = createObserver(vault, repository);

    const first = observer.observeModify('Notes/Plan.md');
    await vi.waitFor(() => expect(commitCount).toBe(1));
    vault.contents.set('Notes/Plan.md', 'two');
    const second = observer.observeModify('Notes/Plan.md');
    await Promise.resolve();
    expect(vault.reads).toEqual(['Notes/Plan.md']);

    releaseFirstCommit?.();
    await expect(first).resolves.toMatchObject({ content: 'one\n' });
    await expect(second).resolves.toMatchObject({
      content: 'two\n',
      previousContent: 'one\n',
    });
  });

  it('dedupes a create event for an already-mapped path (reflected remote write, no re-push)', async () => {
    // A remote apply adopts the incoming fileId into the mapping and writes the
    // file; Obsidian then fires a 'create' event. That reflected create must NOT
    // mint a new fileId — it dedupes to a no-op because the content matches.
    const vault = new MemoryVault();
    vault.contents.set('Notes/Shared.md', 'SHARED\n');
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    // First create establishes the mapping (as remote apply's adoption would).
    await observer.observeCreate('Notes/Shared.md');
    expect(repository.commits).toHaveLength(1);

    // A second create for the same unchanged path is a no-op — never a fork.
    const reflected = await observer.observeCreate('Notes/Shared.md');
    expect(reflected).toBeNull();
    expect(repository.commits).toHaveLength(1);
  });

  it('keeps the existing (adopted) fileId when a create event carries changed content', async () => {
    const vault = new MemoryVault();
    vault.contents.set('Notes/Shared.md', 'NEW\n');
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/shared.md',
        content: 'OLD\n',
        contentHash: 'stale-hash',
        fileId: 'adopted-remote-file',
        path: 'Notes/Shared.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const result = await observer.observeCreate('Notes/Shared.md');

    expect(result?.fileId).toBe('adopted-remote-file');
    expect(result?.fileId).not.toBe(FILE_ID); // never a freshly minted id
    expect(result?.kind).toBe('update');
  });
});

describe('VaultChangeObserver binary attachments (F9)', () => {
  it('reads raw bytes, base64-encodes them, and hashes the RAW bytes for a binary create', async () => {
    const vault = new MemoryVault();
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x00]);
    vault.binaryContents.set('image.png', bytes);
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    const created = await observer.observeCreate('image.png');

    const expectedContent = bytesToBase64(bytes);
    const expectedHash = await hashBlob(bytes);
    expect(created).toMatchObject({
      content: expectedContent,
      contentHash: expectedHash,
      contentKind: 'binary',
      fileId: FILE_ID,
      kind: 'create',
      path: 'image.png',
    });
    expect(repository.mappings.get(FILE_ID)).toMatchObject({
      content: expectedContent,
      contentHash: expectedHash,
      contentKind: 'binary',
      path: 'image.png',
    });
  });

  it('produces an update with the new raw-byte hash on a binary modify, and dedupes identical bytes', async () => {
    const vault = new MemoryVault();
    const originalBytes = new Uint8Array([0x01, 0x02, 0x03]);
    vault.binaryContents.set('image.png', originalBytes);
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    await observer.observeCreate('image.png');

    const changedBytes = new Uint8Array([0x04, 0x05, 0x06, 0x07]);
    vault.binaryContents.set('image.png', changedBytes);
    const updated = await observer.observeModify('image.png');

    const expectedHash = await hashBlob(changedBytes);
    expect(updated).toMatchObject({
      content: bytesToBase64(changedBytes),
      contentHash: expectedHash,
      contentKind: 'binary',
      kind: 'update',
      path: 'image.png',
    });

    // An identical-bytes modify must dedupe to null (same hash as the mapping).
    const identical = await observer.observeModify('image.png');
    expect(identical).toBeNull();
  });

  it('excludes a binary attachment over MAX_BINARY_FILE_BYTES from create (no commit)', async () => {
    const vault = new MemoryVault();
    const oversized = new Uint8Array(MAX_BINARY_FILE_BYTES + 1);
    vault.binaryContents.set('image.png', oversized);
    const repository = new MemoryRepository();
    const observer = createObserver(vault, repository);

    const created = await observer.observeCreate('image.png');

    expect(created).toBeNull();
    expect(repository.commits).toHaveLength(0);
  });
});

describe('VaultChangeObserver folder events (AUD-04)', () => {
  it('re-paths every child mapping under a renamed folder and preserves each fileId', async () => {
    // Obsidian (or another plugin) can move a whole folder and emit only a
    // TFolder rename event. Without folder-level handling the child notes keep
    // their OLD paths, so a later edit of a moved child fails to resolve and
    // mints a fresh fileId — forking the note on the peer.
    const vault = new MemoryVault();
    vault.contents.set('Archive/Sub/a.md', 'A');
    vault.contents.set('Archive/Sub/b.md', 'B');
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/a.md',
        content: 'A',
        contentHash: 'hash-a',
        fileId: 'file-a',
        path: 'Notes/Sub/a.md',
      },
      {
        collisionKey: 'notes/sub/b.md',
        content: 'B',
        contentHash: 'hash-b',
        fileId: 'file-b',
        path: 'Notes/Sub/b.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const ops = await observer.observeFolderRename('Notes/Sub', 'Archive/Sub');

    expect(ops.map((op) => op.kind)).toEqual(['rename', 'rename']);
    expect(repository.mappings.get('file-a')?.path).toBe('Archive/Sub/a.md');
    expect(repository.mappings.get('file-b')?.path).toBe('Archive/Sub/b.md');

    // A later edit of a moved child resolves to its ORIGINAL fileId (no fork).
    vault.contents.set('Archive/Sub/a.md', 'A changed');
    const edited = await observer.observeModify('Archive/Sub/a.md');
    expect(edited).toMatchObject({ kind: 'update', fileId: 'file-a' });
  });

  it('does not double-process when per-child rename events also fire after the folder rename', async () => {
    // On desktop Obsidian a folder move likely emits the TFolder rename AND a
    // per-child TFile rename for each note. The child that the folder handler
    // already re-pathed must dedupe to a no-op, never a second rename or a fork.
    const vault = new MemoryVault();
    vault.contents.set('Archive/Sub/a.md', 'A');
    vault.contents.set('Archive/Sub/b.md', 'B');
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/a.md',
        content: 'A',
        contentHash: 'hash-a',
        fileId: 'file-a',
        path: 'Notes/Sub/a.md',
      },
      {
        collisionKey: 'notes/sub/b.md',
        content: 'B',
        contentHash: 'hash-b',
        fileId: 'file-b',
        path: 'Notes/Sub/b.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const folderOps = await observer.observeFolderRename('Notes/Sub', 'Archive/Sub');
    expect(folderOps).toHaveLength(2);
    expect(repository.commits).toHaveLength(2);

    const childA = await observer.observeRename(
      'Notes/Sub/a.md',
      'Archive/Sub/a.md',
    );
    const childB = await observer.observeRename(
      'Notes/Sub/b.md',
      'Archive/Sub/b.md',
    );

    expect(childA).toBeNull();
    expect(childB).toBeNull();
    // Exactly one rename per child — the late per-child events are no-ops.
    expect(repository.commits).toHaveLength(2);
    expect(repository.mappings.get('file-a')?.path).toBe('Archive/Sub/a.md');
    expect(repository.mappings.get('file-b')?.path).toBe('Archive/Sub/b.md');
  });

  it('tombstones every child under a deleted folder through the per-file delete path', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/a.md',
        content: 'A',
        contentHash: 'hash-a',
        fileId: 'file-a',
        path: 'Notes/Sub/a.md',
      },
      {
        collisionKey: 'notes/sub/b.md',
        content: 'B',
        contentHash: 'hash-b',
        fileId: 'file-b',
        path: 'Notes/Sub/b.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const ops = await observer.observeFolderDelete('Notes/Sub');

    expect(ops.map((op) => op.kind)).toEqual(['delete', 'delete']);
    expect(repository.mappings.has('file-a')).toBe(false);
    expect(repository.mappings.has('file-b')).toBe(false);
    // Delete reuses the durable snapshot and never reads the removed files.
    expect(vault.reads).toEqual([]);
  });

  it('matches folder prefixes on segment boundaries (Notes/Sub not Notes/Subtle)', async () => {
    const vault = new MemoryVault();
    vault.contents.set('Notes/Moved/x.md', 'X');
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/x.md',
        content: 'X',
        contentHash: 'hash-x',
        fileId: 'file-x',
        path: 'Notes/Sub/x.md',
      },
      {
        collisionKey: 'notes/subtle/y.md',
        content: 'Y',
        contentHash: 'hash-y',
        fileId: 'file-y',
        path: 'Notes/Subtle/y.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const ops = await observer.observeFolderRename('Notes/Sub', 'Notes/Moved');

    expect(ops).toHaveLength(1);
    expect(repository.mappings.get('file-x')?.path).toBe('Notes/Moved/x.md');
    // Notes/Subtle is a sibling, not a child — it must be untouched.
    expect(repository.mappings.get('file-y')?.path).toBe('Notes/Subtle/y.md');
  });
});

function createObserver(
  vault: VaultSnapshotPort,
  repository: LocalChangeRepository,
): VaultChangeObserver {
  return new VaultChangeObserver({
    clock: () => 1_721_000_000_000,
    generateFileId: () => FILE_ID,
    generateOperationId: () => OPERATION_ID,
    repository,
    vault,
  });
}

function mapping(
  path: string,
  content: string,
  contentHash: string,
): LocalFileMapping {
  return {
    collisionKey: path.toLowerCase(),
    content,
    contentHash,
    fileId: FILE_ID,
    path,
  };
}
