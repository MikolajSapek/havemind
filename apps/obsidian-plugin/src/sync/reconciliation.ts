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
  /**
   * Count of non-markdown vault files (images, PDFs, ...) that the markdown-only
   * MVP scope never syncs. Enumerated for visibility only — never read or
   * enqueued. Distinct from `ignored`, which counts markdown files excluded for
   * other reasons (dotfiles, reserved folders).
   */
  attachmentsExcluded: number;
  completed: boolean;
  created: number;
  deleted: number;
  ignored: number;
  renamed: number;
  /**
   * Count of files whose observation failed for a per-file reason (an oversized
   * payload or an envelope build error). The bad file is skipped and surfaced
   * here; enumeration of the rest of the vault continues uninterrupted so a
   * single note can never abort the whole scan.
   */
  skipped: number;
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

  const allPaths = await vault.listAllPaths();
  const attachmentsExcluded = allPaths.filter(
    (path) => !path.toLowerCase().endsWith('.md'),
  ).length;

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
  let skipped = 0;
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
    } else if (await observeResilient(() => observer.observeModify(readPath))) {
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  const unmatchedMappings = [...mappingsByCollision.values()];
  const {
    created,
    deleted,
    renamed,
    skipped: tailSkipped,
  } = await applyRenamesCreatesDeletes(observer, unmatchedVault, unmatchedMappings);

  return {
    attachmentsExcluded,
    completed: true,
    created,
    deleted,
    ignored,
    renamed,
    skipped: skipped + tailSkipped,
    unchanged,
    updated,
  };
}

/**
 * Runs a single per-file observation, isolating its failure so one bad file can
 * never abort the whole scan. Returns true if the observation committed, false
 * if it was skipped for a per-file reason (an oversized payload or an envelope
 * build error). A structural vault collision stays fatal — it is a data-integrity
 * problem the user must resolve, matching the enumeration-phase collision guard.
 */
async function observeResilient(task: () => Promise<unknown>): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    if (error instanceof LocalVaultError) throw error;
    return false;
  }
}

async function applyRenamesCreatesDeletes(
  observer: VaultChangeObserver,
  unmatchedVault: readonly EligibleVaultFile[],
  unmatchedMappings: readonly LocalFileMapping[],
): Promise<{ created: number; deleted: number; renamed: number; skipped: number }> {
  const vaultByContent = groupBy(unmatchedVault, (file) => file.content);
  const mappingsByContent = groupBy(unmatchedMappings, (m) => m.content);

  const consumedVault = new Set<EligibleVaultFile>();
  const consumedMappings = new Set<LocalFileMapping>();
  let renamed = 0;
  let skipped = 0;

  for (const [content, files] of vaultByContent) {
    const candidates = mappingsByContent.get(content) ?? [];
    const [file] = files;
    const [mapping] = candidates;
    if (files.length === 1 && candidates.length === 1 && file && mapping) {
      // Consume the pair either way: on failure the file is skipped, not retried
      // as a create+delete (which would fail identically for an oversized note).
      consumedVault.add(file);
      consumedMappings.add(mapping);
      if (await observeResilient(() => observer.observeRename(mapping.path, file.readPath))) {
        renamed += 1;
      } else {
        skipped += 1;
      }
    }
  }

  let created = 0;
  for (const file of unmatchedVault) {
    if (consumedVault.has(file)) continue;
    if (await observeResilient(() => observer.observeCreate(file.readPath))) {
      created += 1;
    } else {
      skipped += 1;
    }
  }

  let deleted = 0;
  for (const mapping of unmatchedMappings) {
    if (consumedMappings.has(mapping)) continue;
    if (await observeResilient(() => observer.observeDelete(mapping.path))) {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }

  return { created, deleted, renamed, skipped };
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
