import { describe, expect, it } from 'vitest';

import {
  type LocalChangeCommit,
  type LocalChangeRepository,
  type LocalFileMapping,
  VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { reconcileVaultState } from './reconciliation';

class ReconciliationVault implements VaultSnapshotPort {
  readonly contents = new Map<string, string>();

  async listMarkdownPaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }

  async readText(path: string): Promise<string> {
    const value = this.contents.get(path);
    if (value === undefined) throw new Error(`Missing: ${path}`);
    return value;
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

  async commitLocalChange(commit: LocalChangeCommit): Promise<void> {
    this.commits.push(structuredClone(commit));
    if (commit.removeFileId !== null) this.mappings.delete(commit.removeFileId);
    if (commit.upsertMapping !== null) {
      this.mappings.set(commit.upsertMapping.fileId, commit.upsertMapping);
    }
  }
}

describe('startup reconciliation', () => {
  it('commits create, update, and delete observations before reporting completion', async () => {
    const vault = new ReconciliationVault();
    vault.contents.set('Notes/Unchanged.md', 'same');
    vault.contents.set('Notes/Changed.md', 'after');
    vault.contents.set('Notes/New.md', 'new');
    vault.contents.set('.obsidian/Private.md', 'secret');
    vault.contents.set('Asset.png', 'binary');
    const repository = new ReconciliationRepository([
      mapping('file-unchanged', 'Notes/Unchanged.md', 'same'),
      mapping('file-changed', 'Notes/Changed.md', 'before'),
      mapping('file-deleted', 'Notes/Deleted.md', 'recoverable'),
    ]);
    const observer = createObserver(vault, repository);

    const result = await reconcileVaultState({ observer, repository, vault });

    expect(result).toMatchObject({
      completed: true,
      created: 1,
      deleted: 1,
      ignored: 2,
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
    ).toBe('recoverable');
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
  return {
    collisionKey: path.toLowerCase(),
    content,
    contentHash: `hash:${content}`,
    fileId,
    path,
  };
}
