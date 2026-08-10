import { canonicalizeMarkdown } from '@havemind/protocol';

import { isSyncableConfigPath } from './appearance-scope';
import {
  bytesToBase64,
  classifyVaultPath,
  LocalVaultError,
  MAX_BINARY_FILE_BYTES,
  pathExtension,
  SYNCABLE_BINARY_EXTENSIONS,
  type LocalChangeRepository,
  type LocalFileMapping,
  type SyncContentKind,
  type VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';

const SYNCABLE_EXTENSION_SET: ReadonlySet<string> = new Set<string>([
  'md',
  ...SYNCABLE_BINARY_EXTENSIONS,
]);

export interface ReconcileVaultStateOptions {
  observer: VaultChangeObserver;
  repository: LocalChangeRepository;
  vault: VaultSnapshotPort;
}

/**
 * Upper bound on how many per-file skip reasons a single reconcile reports. The
 * `skipped` COUNT stays exact; only the named detail list is capped, so a vault
 * with thousands of failing files can neither balloon this result nor flood the
 * console. Ten is enough to diagnose a pattern by hand.
 */
const MAX_SKIPPED_DETAILS = 10;

/** One per-file reconcile failure: which file, and why it was skipped. */
export interface SkippedFileDetail {
  path: string;
  reason: string;
}

export interface ReconcileResult {
  /**
   * Count of vault files whose type the pilot never syncs — anything that is
   * neither a markdown note nor an allowlisted binary attachment (F9). Narrowed
   * from the old "every non-markdown file": images/PDFs in the allowlist are now
   * synced, so this figure is the honest "still excluded" count for the notice.
   * Enumerated for visibility only — never read or enqueued.
   */
  attachmentsExcluded: number;
  /**
   * Count of allowlisted binary attachments excluded because their on-disk size
   * exceeds {@link MAX_BINARY_FILE_BYTES}. Excluded-with-notice, never an error:
   * enumeration continues so one oversized asset cannot abort the scan (F9).
   */
  binaryExcluded: number;
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
  /**
   * The first {@link MAX_SKIPPED_DETAILS} skipped files, each with the reason its
   * observation failed. A bare count is undiagnosable — neither the user nor a
   * maintainer reading the console could tell which file was dropped or why — so
   * every failure records its path and message. Bounded on purpose: the count
   * above stays exact, but this list never grows with the vault.
   */
  skippedPaths: readonly SkippedFileDetail[];
  unchanged: number;
  updated: number;
}

const MAX_BINARY_FILE_MB = MAX_BINARY_FILE_BYTES / (1024 * 1024);

/**
 * Renders the two exclusion counts from a {@link ReconcileResult} as
 * user-facing notice strings — pure, so the wording can be unit-tested without
 * an `App`/`Notice` in scope. Each reason gets its OWN sentence: an unsupported
 * file type and an oversized allowlisted binary (F9) are distinct causes, and
 * conflating them (or the old "markdown only" phrasing, stale since binary
 * attachment sync shipped) would misinform the user about what to do next.
 * Returns an empty array when nothing was excluded.
 */
export function formatReconcileNotices(result: ReconcileResult): string[] {
  const notices: string[] = [];
  if (result.attachmentsExcluded > 0) {
    notices.push(
      `Havemind: ${result.attachmentsExcluded} attachment(s) not synced (unsupported file type(s)).`,
    );
  }
  if (result.binaryExcluded > 0) {
    notices.push(
      `Havemind: ${result.binaryExcluded} attachment(s) not synced (over the ${MAX_BINARY_FILE_MB} MB size limit).`,
    );
  }
  return notices;
}

/**
 * Writes one console line per skipped file behind the count-only Notice, so the
 * failure is diagnosable after the fact. Deliberately NOT a Notice: a 40-file
 * toast storm is worse than no toast at all, whereas the console is where the
 * rest of this plugin already reports per-item failures. Inherently bounded —
 * {@link ReconcileResult.skippedPaths} is capped at {@link MAX_SKIPPED_DETAILS}.
 */
export function warnSkippedPaths(result: ReconcileResult): void {
  for (const { path, reason } of result.skippedPaths) {
    console.warn(`Havemind: skipped ${path}: ${reason}`);
  }
}

interface EligibleVaultFile {
  collisionKey: string;
  content: string;
  readPath: string;
}

/**
 * Reads an eligible file's content for comparison, honouring its sync kind. A
 * binary attachment (F9) is compared over its RAW bytes (hashed with `hashBlob`,
 * carried as base64) so a byte-identical asset reads as unchanged; markdown is
 * canonicalised text. A binary file over {@link MAX_BINARY_FILE_BYTES} returns
 * `'too-large'` — excluded-with-notice, never an error.
 */
async function readEligibleContent(
  vault: VaultSnapshotPort,
  readPath: string,
  kind: SyncContentKind,
): Promise<{ content: string } | 'too-large'> {
  if (kind === 'binary') {
    const bytes = await vault.readBinary(readPath);
    if (bytes.byteLength > MAX_BINARY_FILE_BYTES) return 'too-large';
    return { content: bytesToBase64(bytes) };
  }
  return { content: normalizeContent(await vault.readText(readPath)) };
}

export async function reconcileVaultState(
  options: ReconcileVaultStateOptions,
): Promise<ReconcileResult> {
  const { observer, repository, vault } = options;

  const allPaths = await vault.listAllPaths();
  const attachmentsExcluded = allPaths.filter((path) => {
    const normalized = path.normalize('NFC');
    // An allowlisted appearance-config file (F-appearance) is now syncable, so
    // it must not be counted among the "still excluded" attachments even though
    // its json/css extension is outside SYNCABLE_EXTENSION_SET.
    if (isSyncableConfigPath(normalized)) return false;
    return !SYNCABLE_EXTENSION_SET.has(pathExtension(normalized));
  }).length;

  const paths = await vault.listSyncablePaths();
  const eligible = new Map<string, { readPath: string; kind: SyncContentKind }>();
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
    eligible.set(classified.collisionKey, {
      readPath: rawPath,
      kind: classified.kind,
    });
  }

  const mappingsByCollision = new Map<string, LocalFileMapping>();
  for (const mapping of await repository.listMappings()) {
    mappingsByCollision.set(mapping.collisionKey, mapping);
  }

  let unchanged = 0;
  let updated = 0;
  let skipped = 0;
  let binaryExcluded = 0;
  const skippedPaths: SkippedFileDetail[] = [];
  const recordSkip = (detail: SkippedFileDetail): void => {
    // Bounded on purpose: past the cap the count carries the scale and the
    // detail list stays a fixed-size diagnostic sample (see MAX_SKIPPED_DETAILS).
    if (skippedPaths.length < MAX_SKIPPED_DETAILS) skippedPaths.push(detail);
  };
  const unmatchedVault: EligibleVaultFile[] = [];

  for (const [collisionKey, { readPath, kind }] of eligible) {
    const read = await readEligibleContent(vault, readPath, kind);
    if (read === 'too-large') {
      // Over the per-file cap: dropped from the mappings match set below so it is
      // never observed/enqueued, and never counted as a deletion either.
      binaryExcluded += 1;
      mappingsByCollision.delete(collisionKey);
      continue;
    }
    const { content } = read;
    const mapping = mappingsByCollision.get(collisionKey);
    if (mapping === undefined) {
      unmatchedVault.push({ collisionKey, content, readPath });
      continue;
    }

    mappingsByCollision.delete(collisionKey);
    if (mapping.content === content) {
      unchanged += 1;
    } else if (
      await observeResilient(readPath, recordSkip, () => observer.observeModify(readPath))
    ) {
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
  } = await applyRenamesCreatesDeletes(
    observer,
    unmatchedVault,
    unmatchedMappings,
    recordSkip,
  );

  return {
    attachmentsExcluded,
    binaryExcluded,
    completed: true,
    created,
    deleted,
    ignored,
    renamed,
    skipped: skipped + tailSkipped,
    skippedPaths,
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
 *
 * Every skip reports `path` and the failure's message through `onSkip`: dropping
 * the error here left the count as the only evidence, which named no file and
 * told nobody why it failed.
 */
async function observeResilient(
  path: string,
  onSkip: (detail: SkippedFileDetail) => void,
  task: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    if (error instanceof LocalVaultError) throw error;
    onSkip({ path, reason: describeSkipReason(error) });
    return false;
  }
}

/**
 * The one-line reason for a per-file skip. A thrown non-`Error` (or an `Error`
 * with an empty message) still has to say something, hence the explicit fallback
 * rather than an empty half-sentence in the log.
 */
function describeSkipReason(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'unknown error';
}

async function applyRenamesCreatesDeletes(
  observer: VaultChangeObserver,
  unmatchedVault: readonly EligibleVaultFile[],
  unmatchedMappings: readonly LocalFileMapping[],
  onSkip: (detail: SkippedFileDetail) => void,
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
      // Report the CURRENT on-disk path: that is the one the user can find.
      if (
        await observeResilient(file.readPath, onSkip, () =>
          observer.observeRename(mapping.path, file.readPath),
        )
      ) {
        renamed += 1;
      } else {
        skipped += 1;
      }
    }
  }

  let created = 0;
  for (const file of unmatchedVault) {
    if (consumedVault.has(file)) continue;
    if (
      await observeResilient(file.readPath, onSkip, () =>
        observer.observeCreate(file.readPath),
      )
    ) {
      created += 1;
    } else {
      skipped += 1;
    }
  }

  let deleted = 0;
  for (const mapping of unmatchedMappings) {
    if (consumedMappings.has(mapping)) continue;
    if (
      await observeResilient(mapping.path, onSkip, () =>
        observer.observeDelete(mapping.path),
      )
    ) {
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
  // Same canonical transform every hashing/diff site uses (AUD-03), so a
  // content-match comparison here is on equal terms with the producer mapping.
  return canonicalizeMarkdown(text);
}
