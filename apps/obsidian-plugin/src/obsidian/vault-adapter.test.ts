import { describe, expect, it, vi } from 'vitest';

import {
  VaultChangeObserver,
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
  readonly reads: string[] = [];

  async listMarkdownPaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }

  async readText(path: string): Promise<string> {
    this.reads.push(path);
    const content = this.contents.get(path);
    if (content === undefined) throw new Error(`Missing test file: ${path}`);
    return content;
  }

  async listAllPaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }
}

describe('vault path eligibility', () => {
  it('accepts canonical Markdown paths and ignores reserved, unsafe, and non-Markdown paths', () => {
    expect(classifyVaultPath('Notes/Cafe\u0301.md')).toEqual({
      canonicalPath: 'Notes/Café.md',
      collisionKey: 'notes/café.md',
      eligible: true,
    });

    for (const path of [
      '.obsidian/plugins/example/data.json',
      '.trash/Deleted.md',
      'Havemind Conflicts/Plan.md',
      'image.png',
      '../escape.md',
    ]) {
      expect(classifyVaultPath(path)).toEqual({ eligible: false });
    }
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
      content: 'First\nline',
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
      content: 'First\nline',
      fileId: FILE_ID,
      path: 'Notes/Plan.md',
    });
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
      content: 'new text',
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
    await expect(first).resolves.toMatchObject({ content: 'one' });
    await expect(second).resolves.toMatchObject({
      content: 'two',
      previousContent: 'one',
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
