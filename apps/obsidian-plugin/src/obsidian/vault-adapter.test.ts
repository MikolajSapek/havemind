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
import { CONFLICT_FOLDER } from '../runtime/conflict-resolution';
import {
  ModifyDebouncer,
  type DebounceTimer,
} from '../runtime/modify-debounce';

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

  async exists(path: string): Promise<boolean> {
    return this.contents.has(path) || this.binaryContents.has(path);
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

  it('re-paths children when a folder rename is delivered with backslash separators (FINDING 2)', async () => {
    // A folder move on Windows can arrive with a backslash-separated prefix,
    // while every stored mapping.path is backslash-normalised to forward slashes.
    // Without normalising the prefix, pathUnderFolder never matches and every
    // child is silently skipped.
    const vault = new MemoryVault();
    vault.contents.set('Archive/Sub/a.md', 'A');
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/a.md',
        content: 'A',
        contentHash: 'hash-a',
        fileId: 'file-a',
        path: 'Notes/Sub/a.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const ops = await observer.observeFolderRename('Notes\\Sub', 'Archive\\Sub');

    expect(ops.map((op) => op.kind)).toEqual(['rename']);
    // The child is re-pathed to a forward-slash wire path (never a backslash one).
    expect(repository.mappings.get('file-a')?.path).toBe('Archive/Sub/a.md');
  });

  it('tombstones children when a folder delete is delivered with backslash separators (FINDING 2)', async () => {
    const vault = new MemoryVault();
    const repository = new MemoryRepository([
      {
        collisionKey: 'notes/sub/a.md',
        content: 'A',
        contentHash: 'hash-a',
        fileId: 'file-a',
        path: 'Notes/Sub/a.md',
      },
    ]);
    const observer = createObserver(vault, repository);

    const ops = await observer.observeFolderDelete('Notes\\Sub');

    expect(ops.map((op) => op.kind)).toEqual(['delete']);
    expect(repository.mappings.has('file-a')).toBe(false);
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

/**
 * A vault whose `readText` returns '' for a missing path — exactly how the real
 * Obsidian snapshot adapter behaves (`file === null ? '' : …`). This is what
 * turns a stale settled modify into a phantom EMPTY create, so it is the fixture
 * that reproduces AUD phantom-create bug faithfully.
 */
class PhantomVault implements VaultSnapshotPort {
  readonly files = new Map<string, string>();
  async listSyncablePaths(): Promise<readonly string[]> {
    return [...this.files.keys()];
  }
  async listAllPaths(): Promise<readonly string[]> {
    return [...this.files.keys()];
  }
  async readText(path: string): Promise<string> {
    return this.files.get(path) ?? '';
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

/** Deterministic fake timer mirroring the debouncer test's clock. */
class TestTimer implements DebounceTimer {
  private seq = 0;
  private now = 0;
  private readonly tasks = new Map<number, { at: number; cb: () => void }>();
  set(callback: () => void, ms: number): number {
    const handle = (this.seq += 1);
    this.tasks.set(handle, { at: this.now + ms, cb: callback });
    return handle;
  }
  clear(handle: number): void {
    this.tasks.delete(handle);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [handle, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(handle);
        task.cb();
      }
    }
  }
}

/** Flush the observer's async queue so a fired settle settles before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('settled modify vs rename/delete of the same path (phantom-create guard)', () => {
  it('does not phantom-create the old path when a rename fires within the settle window', async () => {
    // Arrange: an existing, mapped note, wired exactly as production wires the
    // debounced modify → observer.observeModify seam.
    const vault = new PhantomVault();
    vault.files.set('Notes/A.md', 'Body\n');
    const repo = new MemoryRepository();
    const observer = createObserver(vault, repo);
    await observer.observeCreate('Notes/A.md');

    const timer = new TestTimer();
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => {
        void observer.observeModify(path);
      },
      delayMs: 1500,
      timer,
    });

    // Act: the user edits (modify), then renames the file within the window.
    vault.files.set('Notes/A.md', 'Body edited\n');
    debouncer.trigger('Notes/A.md');
    timer.advance(500);
    // The production onRename handler fires the rename immediately AND cancels
    // the pending modify for the old path.
    vault.files.set('Notes/B.md', 'Body edited\n');
    vault.files.delete('Notes/A.md');
    await observer.observeRename('Notes/A.md', 'Notes/B.md');
    debouncer.cancel('Notes/A.md');
    // The settle window now elapses.
    timer.advance(2000);
    await flush();

    // Assert: exactly one create (the setup) and one rename — no phantom create
    // for the vacated old path.
    const kinds = repo.commits.map((commit) => commit.operation.kind);
    expect(kinds).toEqual(['create', 'rename']);
    expect(
      repo.commits.filter(
        (commit) =>
          commit.operation.kind === 'create' && commit.operation.path === 'Notes/A.md',
      ),
    ).toHaveLength(1);
    // The edited content landed at the new path.
    const renamed = [...repo.mappings.values()].find((m) => m.path === 'Notes/B.md');
    expect(renamed?.content).toBe('Body edited\n');
  });

  it('does not phantom-create the old path when a delete fires within the settle window', async () => {
    const vault = new PhantomVault();
    vault.files.set('Notes/A.md', 'Body\n');
    const repo = new MemoryRepository();
    const observer = createObserver(vault, repo);
    await observer.observeCreate('Notes/A.md');

    const timer = new TestTimer();
    const debouncer = new ModifyDebouncer({
      onSettled: (path) => {
        void observer.observeModify(path);
      },
      delayMs: 1500,
      timer,
    });

    // Act: edit then delete within the window.
    vault.files.set('Notes/A.md', 'Body edited\n');
    debouncer.trigger('Notes/A.md');
    timer.advance(500);
    vault.files.delete('Notes/A.md');
    await observer.observeDelete('Notes/A.md');
    debouncer.cancel('Notes/A.md');
    timer.advance(2000);
    await flush();

    // Assert: create (setup) then delete only — the deleted note never resurrects
    // as a phantom empty create.
    const kinds = repo.commits.map((commit) => commit.operation.kind);
    expect(kinds).toEqual(['create', 'delete']);
  });

  it('a settled modify for a path no longer on disk never becomes a phantom create (safety net)', async () => {
    // Belt-and-braces: even without the debounce cancel, an observeModify for a
    // path that is neither mapped nor on disk must resolve to nothing — never a
    // fresh fileId + empty create pushed to the peer.
    const vault = new PhantomVault(); // 'Notes/Gone.md' is absent
    const repo = new MemoryRepository();
    const observer = createObserver(vault, repo);

    const op = await observer.observeModify('Notes/Gone.md');

    expect(op).toBeNull();
    expect(repo.commits).toEqual([]);
  });
});

describe('reserved conflict folder exclusion', () => {
  it('keys the reserved-root exclusion on the shared CONFLICT_FOLDER constant', () => {
    // Drift regression: the folder name used to be a private literal here, a
    // second literal in `conflict-resolution.ts` and a third in
    // `obsidian-adapters.ts`. Renaming one would have started re-syncing every
    // conflict copy — an infinite echo. Assert the exclusion tracks the ONE
    // exported constant instead of a copy of its current value.
    expect(classifyVaultPath(`${CONFLICT_FOLDER}/copy.md`).eligible).toBe(false);
    expect(
      classifyVaultPath(`${CONFLICT_FOLDER}/Nested/copy.png`).eligible,
    ).toBe(false);
  });

  it('excludes only the exact reserved root, never a lookalike sibling folder', () => {
    expect(classifyVaultPath(`${CONFLICT_FOLDER} Archive/note.md`).eligible).toBe(
      true,
    );
    expect(classifyVaultPath(`Notes/${CONFLICT_FOLDER}/note.md`).eligible).toBe(
      true,
    );
  });
});
