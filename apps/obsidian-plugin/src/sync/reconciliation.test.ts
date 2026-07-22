import { canonicalizeMarkdown } from '@havemind/protocol';
import { describe, expect, it } from 'vitest';

import { RevisionPayloadTooLargeError } from '@havemind/sync-core';

import {
  bytesToBase64,
  MAX_BINARY_FILE_BYTES,
  pathExtension,
  SYNCABLE_BINARY_EXTENSIONS,
  type LocalChangeCommit,
  type LocalChangeRepository,
  type LocalFileMapping,
  VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { reconcileVaultState } from './reconciliation';

const SYNCABLE_EXTENSION_SET = new Set<string>(['md', ...SYNCABLE_BINARY_EXTENSIONS]);

class ReconciliationVault implements VaultSnapshotPort {
  readonly contents = new Map<string, string>();
  readonly binaryContents = new Map<string, Uint8Array>();

  async listSyncablePaths(): Promise<readonly string[]> {
    // Mirrors the real Obsidian vault scan by extension only (markdown +
    // allowlisted binary, F9) — same as `Vault.getMarkdownFiles()` plus
    // attachment enumeration; reconciliation itself applies `classifyVaultPath`
    // for the dotpath/reserved-directory exclusions (so those still count as
    // `ignored`, not silently dropped here).
    return [...this.contents.keys(), ...this.binaryContents.keys()].filter((path) =>
      SYNCABLE_EXTENSION_SET.has(pathExtension(path.normalize('NFC'))),
    );
  }

  async readText(path: string): Promise<string> {
    const value = this.contents.get(path);
    if (value === undefined) throw new Error(`Missing: ${path}`);
    return value;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const value = this.binaryContents.get(path);
    if (value === undefined) throw new Error(`Missing: ${path}`);
    return value;
  }

  async listAllPaths(): Promise<readonly string[]> {
    return [...this.contents.keys(), ...this.binaryContents.keys()];
  }

  async exists(path: string): Promise<boolean> {
    return this.contents.has(path) || this.binaryContents.has(path);
  }
}

class ReconciliationRepository implements LocalChangeRepository {
  readonly commits: LocalChangeCommit[] = [];
  readonly mappings = new Map<string, LocalFileMapping>();

  constructor(initial: readonly LocalFileMapping[] = []) {
    for (const mapping of initial) this.mappings.set(mapping.fileId, mapping);
  }

  async listMappings(): Promise<readonly LocalFileMapping[]> {
    return [...this.mappings.values()];
  }

  async commitLocalChange(commit: LocalChangeCommit): Promise<string | null> {
    this.commits.push(structuredClone(commit));
    if (commit.removeFileId !== null) this.mappings.delete(commit.removeFileId);
    if (commit.upsertMapping !== null) {
      this.mappings.set(commit.upsertMapping.fileId, commit.upsertMapping);
    }
    return `rev-${this.commits.length}`;
  }
}

/** Fails `commitLocalChange` for one content marker, succeeds for the rest. */
class ThrowingRepository extends ReconciliationRepository {
  private readonly failContent: string;

  constructor(failContent: string) {
    super();
    // The observer hands operations the CANONICAL content, so match on that.
    this.failContent = canonicalizeMarkdown(failContent);
  }

  override async commitLocalChange(
    commit: LocalChangeCommit,
  ): Promise<string | null> {
    if (commit.operation.content === this.failContent) {
      throw new RevisionPayloadTooLargeError(commit.operation.path, 999, 100);
    }
    return super.commitLocalChange(commit);
  }
}

describe('startup reconciliation', () => {
  it('commits create, update, and delete observations before reporting completion', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/Unchanged.md', 'same');
    vault.contents.set('Notes/Changed.md', 'after');
    vault.contents.set('Notes/New.md', 'new');
    vault.contents.set('.obsidian/Private.md', 'secret');
    // A non-allowlisted extension (F9 syncs png/jpg/etc, never .zip) so this stays
    // an excluded attachment under the narrowed `attachmentsExcluded` definition.
    vault.contents.set('Asset.zip', 'binary');
    const repository = new ReconciliationRepository([
      mapping('file-unchanged', 'Notes/Unchanged.md', 'same'),
      mapping('file-changed', 'Notes/Changed.md', 'before'),
      mapping('file-deleted', 'Notes/Deleted.md', 'recoverable'),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      attachmentsExcluded: 1,
      binaryExcluded: 0,
      completed: true,
      created: 1,
      deleted: 1,
      ignored: 1,
      renamed: 0,
      unchanged: 1,
      updated: 1,
    });
    expect(repository.commits.map((entry) => entry.operation.kind).sort()).toEqual(
      ['create', 'delete', 'update'],
    );
    expect(
      repository.commits.find((entry) => entry.operation.kind === 'delete')
        ?.operation.previousContent,
    ).toBe('recoverable\n');
  });

  it('infers only an unambiguous same-content rename and preserves its file identity', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/New name.md', 'same content');
    const repository = new ReconciliationRepository([
      mapping('stable-file-id', 'Notes/Old name.md', 'same content'),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({ completed: true, renamed: 1 });
    expect(repository.commits).toHaveLength(1);
    expect(repository.commits[0]?.operation).toMatchObject({
      fileId: 'stable-file-id',
      kind: 'rename',
      path: 'Notes/New name.md',
      previousPath: 'Notes/Old name.md',
    });
  });

  it('does not guess identity when duplicate content makes rename inference ambiguous', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/New A.md', 'duplicate');
    vault.contents.set('Notes/New B.md', 'duplicate');
    const repository = new ReconciliationRepository([
      mapping('old-a', 'Notes/Old A.md', 'duplicate'),
      mapping('old-b', 'Notes/Old B.md', 'duplicate'),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      completed: true,
      created: 2,
      deleted: 2,
      renamed: 0,
    });
  });

  it('skips a per-file failure and still enumerates the rest of the scan', async () => {
    // One pre-existing note is too large to build a revision for. A single bad
    // file must not abort enumeration: the healthy files are still enqueued and
    // the oversized one is surfaced via the skipped count.
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/Good1.md', 'good one');
    vault.contents.set('Notes/Oversized.md', 'OVERSIZED');
    vault.contents.set('Notes/Good2.md', 'good two');
    const repository = new ThrowingRepository('OVERSIZED');
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result.completed).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(2);
    const createdPaths = repository.commits
      .filter((entry) => entry.operation.kind === 'create')
      .map((entry) => entry.operation.path)
      .sort();
    expect(createdPaths).toEqual(['Notes/Good1.md', 'Notes/Good2.md']);
  });

  it('counts non-syncable attachments as excluded without reading or enqueuing them', async () => {
    // Only markdown and the allowlisted binary extensions (F9) are syncable. A
    // vault with a markdown note plus a ZIP and a canvas file must still sync the
    // note normally, while the two non-allowlisted attachments are counted as
    // excluded so the omission is visible instead of silent — they must never be
    // read (readText/readBinary would throw for them) or enqueued.
    const vault = new ReconciliationVault();
    vault.contents.set('a.md', 'hello');
    vault.contents.set('archive.zip', 'zip-bytes');
    vault.contents.set('board.canvas', 'canvas-json');
    const repository = new ReconciliationRepository();
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      attachmentsExcluded: 2,
      binaryExcluded: 0,
      completed: true,
      created: 1,
      ignored: 0,
    });
    expect(repository.commits).toHaveLength(1);
    expect(repository.commits[0]?.operation.path).toBe('a.md');
    expect(repository.commits.some((entry) => entry.operation.path.endsWith('.zip'))).toBe(
      false,
    );
    expect(repository.commits.some((entry) => entry.operation.path.endsWith('.canvas'))).toBe(
      false,
    );
  });

  it('treats a byte-identical binary attachment as unchanged and never re-observes it', async () => {
    // Content-match for a binary attachment compares RAW-byte hashes (via base64),
    // never a canonicalised form (F9). A byte-identical asset must read as
    // unchanged, exactly like an untouched markdown note.
    const vault = new ReconciliationVault();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vault.binaryContents.set('Images/pic.png', bytes);
    const repository = new ReconciliationRepository([
      binaryMapping('file-pic', 'Images/pic.png', bytes),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      completed: true,
      created: 0,
      unchanged: 1,
      updated: 0,
    });
    expect(repository.commits).toHaveLength(0);
  });

  it('observes an update when a binary attachment’s raw bytes change', async () => {
    const vault = new ReconciliationVault();
    const newBytes = new Uint8Array([9, 9, 9]);
    vault.binaryContents.set('Images/pic.png', newBytes);
    const repository = new ReconciliationRepository([
      binaryMapping('file-pic', 'Images/pic.png', new Uint8Array([1, 2, 3])),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({ completed: true, unchanged: 0, updated: 1 });
    expect(repository.commits).toHaveLength(1);
    expect(repository.commits[0]?.operation.kind).toBe('update');
    expect(repository.commits[0]?.operation.contentKind).toBe('binary');
    expect(repository.commits[0]?.operation.content).toBe(bytesToBase64(newBytes));
  });

  it('counts a non-allowlisted attachment as excluded while an allowlisted binary is synced', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('a.md', 'hello');
    vault.contents.set('archive.zip', 'zip-bytes'); // non-allowlisted: stays excluded
    vault.binaryContents.set('img.png', new Uint8Array([1, 2, 3])); // allowlisted: synced

    const repository = new ReconciliationRepository();
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      attachmentsExcluded: 1,
      binaryExcluded: 0,
      completed: true,
      created: 2,
    });
    expect(
      repository.commits.some((entry) => entry.operation.path === 'archive.zip'),
    ).toBe(false);
    expect(repository.commits.some((entry) => entry.operation.path === 'img.png')).toBe(
      true,
    );
  });

  it('excludes an oversized binary attachment with a notice, never creating/updating/deleting it', async () => {
    const vault = new ReconciliationVault();
    const oversized = new Uint8Array(MAX_BINARY_FILE_BYTES + 1);
    vault.binaryContents.set('huge.png', oversized);
    const repository = new ReconciliationRepository();
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      binaryExcluded: 1,
      completed: true,
      created: 0,
      deleted: 0,
      updated: 0,
    });
    expect(repository.commits).toHaveLength(0);
  });

  it('rejects case-insensitive live path collisions without reporting Synced', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/Plan.md', 'one');
    vault.contents.set('notes/PLAN.md', 'two');
    const repository = new ReconciliationRepository();
    const observer = createObserver(vault, repository);

    await expect(
      reconcileVaultState({ observer, repository, vault }),
    ).rejects.toMatchObject({ code: 'path-collision' });
    expect(repository.commits).toHaveLength(0);
  });
});

function createObserver(
  vault: VaultSnapshotPort,
  repository: LocalChangeRepository,
): VaultChangeObserver {
  let nextId = 0;
  return new VaultChangeObserver({
    clock: () => 1_721_000_000_000,
    generateFileId: () => `new-file-${nextId += 1}`,
    generateOperationId: () => `operation-${nextId}`,
    repository,
    vault,
  });
}

function mapping(
  fileId: string,
  path: string,
  content: string,
): LocalFileMapping {
  // Stored mappings hold the CANONICAL content form in production (the producer
  // canonicalises on write and the AUD-03 startup rebase canonicalises existing
  // state), so the fixture must too — otherwise a content-match comparison
  // against the now-canonicalised vault read would drift and mint a spurious
  // revision only in the test, never in production.
  const canonical = canonicalizeMarkdown(content);
  return {
    collisionKey: path.toLowerCase(),
    content: canonical,
    contentHash: `hash:${canonical}`,
    fileId,
    path,
  };
}

/**
 * A stored binary-attachment mapping (F9): `content` is base64 of the RAW
 * bytes (never canonicalised), matching what `bytesToBase64` produces for the
 * same bytes on the vault-read side.
 */
function binaryMapping(
  fileId: string,
  path: string,
  bytes: Uint8Array,
): LocalFileMapping {
  return {
    collisionKey: path.toLowerCase(),
    content: bytesToBase64(bytes),
    contentHash: `hash:${path}`,
    contentKind: 'binary',
    fileId,
    path,
  };
}
