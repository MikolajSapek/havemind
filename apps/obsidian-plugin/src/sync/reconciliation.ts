import {
  classifyVaultPath,
  LocalVaultError,
  type LocalChangeRepository,
  type LocalFileMapping,
  type VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';

export interface ReconcileVaultStateOptions {
  observer: VaultChangeObserver;
  repository: LocalChangeRepository;
  vault: VaultSnapshotPort;
}

export interface ReconcileResult {
  completed: boolean;
  created: number;
  deleted: number;
  ignored: number;
  renamed: number;
  unchanged: number;
  updated: number;
}

interface EligibleVaultFile {
  collisionKey: string;
  content: string;
  readPath: string;
}

export async function reconcileVaultState(
  options: ReconcileVaultStateOptions,
): Promise<ReconcileResult> {
  const { observer, repository, vault } = options;

  const paths = await vault.listMarkdownPaths();
  const eligible = new Map<string, string>();
  let ignored = 0;

  for (const rawPath of paths) {
    const classified = classifyVaultPath(rawPath);
    if (!classified.eligible) {
      ignored += 1;
      continue;
    }
    if (eligible.has(classified.collisionKey)) {
      throw new LocalVaultError(
        'path-collision',
        `Two live vault files map to ${classified.collisionKey}.`,
      );
    }
    eligible.set(classified.collisionKey, rawPath);
  }

  const mappingsByCollision = new Map<string, LocalFileMapping>();
  for (const mapping of await repository.listMappings()) {
    mappingsByCollision.set(mapping.collisionKey, mapping);
  }

  let unchanged = 0;
  let updated = 0;
  const unmatchedVault: EligibleVaultFile[] = [];

  for (const [collisionKey, readPath] of eligible) {
    const content = normalizeContent(await vault.readText(readPath));
    const mapping = mappingsByCollision.get(collisionKey);
    if (mapping === undefined) {
      unmatchedVault.push({ collisionKey, content, readPath });
      continue;
    }

    mappingsByCollision.delete(collisionKey);
    if (mapping.content === content) {
      unchanged += 1;
    } else {
      await observer.observeModify(readPath);
      updated += 1;
    }
  }

  const unmatchedMappings = [...mappingsByCollision.values()];
  const { created, deleted, renamed } = await applyRenamesCreatesDeletes(
    observer,
    unmatchedVault,
    unmatchedMappings,
  );

  return {
    completed: true,
    created,
    deleted,
    ignored,
    renamed,
    unchanged,
    updated,
  };
}

async function applyRenamesCreatesDeletes(
  observer: VaultChangeObserver,
  unmatchedVault: readonly EligibleVaultFile[],
  unmatchedMappings: readonly LocalFileMapping[],
): Promise<{ created: number; deleted: number; renamed: number }> {
  const vaultByContent = groupBy(unmatchedVault, (file) => file.content);
  const mappingsByContent = groupBy(unmatchedMappings, (m) => m.content);

  const consumedVault = new Set<EligibleVaultFile>();
  const consumedMappings = new Set<LocalFileMapping>();
  let renamed = 0;

  for (const [content, files] of vaultByContent) {
    const candidates = mappingsByContent.get(content) ?? [];
    const [file] = files;
    const [mapping] = candidates;
    if (files.length === 1 && candidates.length === 1 && file && mapping) {
      await observer.observeRename(mapping.path, file.readPath);
      renamed += 1;
      consumedVault.add(file);
      consumedMappings.add(mapping);
    }
  }

  let created = 0;
  for (const file of unmatchedVault) {
    if (consumedVault.has(file)) continue;
    await observer.observeCreate(file.readPath);
    created += 1;
  }

  let deleted = 0;
  for (const mapping of unmatchedMappings) {
    if (consumedMappings.has(mapping)) continue;
    await observer.observeDelete(mapping.path);
    deleted += 1;
  }

  return { created, deleted, renamed };
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

function normalizeContent(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}
