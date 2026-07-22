/**
 * One-time startup rebase of persisted hashes after the AUD-03 canonicalization
 * change (PART 2 — CRITICAL MIGRATION, live pilot with real user data).
 *
 * Two devices are already live-synced with base hashes and producer-mapping
 * content hashes computed under the OLD canonicalization (CRLF-only). The new
 * canonicalization (CRLF + BOM strip + single trailing newline) changes those
 * hashes for any file whose bytes differ only by a trailing newline or a BOM.
 * Without a rebase, the first sync cycle after the upgrade would see every such
 * file as "changed" (stored old hash ≠ freshly canonicalized hash) and push a
 * spurious revision — the exact false-conflict cascade the pilot must avoid.
 *
 * So on the first startup under the new code, BEFORE the first sync cycle, we
 * recompute — from the current on-disk bytes, under the NEW canonicalization —
 * the stored producer-mapping `content`/`contentHash` and the `baseHashes` for
 * every entry whose file still exists on disk, and overwrite the stored value.
 * A version marker persisted in plugin data guarantees this runs exactly once.
 *
 * Files missing on disk are intentionally LEFT as-is: their bytes are gone, so
 * there is nothing to recompute from. A later delete tombstone or a fresh
 * create/rename will reconcile them; leaving the stale hash cannot cause a
 * silent overwrite because no on-disk content exists to compare against.
 *
 * This is hash-side only — no user file is ever rewritten by the rebase.
 */

import { pathExtension, SYNCABLE_BINARY_EXTENSIONS } from '../obsidian/vault-adapter';

/** The current rebase schema version; bump only if the canonical form changes. */
export const CANONICALIZATION_REBASE_VERSION = 1;

/** Allowlisted binary extensions (F9), lowercased, no dot — for the fallback below. */
const BINARY_EXTENSION_SET: ReadonlySet<string> = new Set(SYNCABLE_BINARY_EXTENSIONS);

/**
 * Whether a stored mapping refers to a binary attachment (F9). Prefers the
 * durable `contentKind` discriminator, but ALSO treats any path with an
 * allowlisted binary extension as binary — so even a legacy, kind-less mapping
 * (persisted before the discriminator was durable) is never markdown-rebased
 * and its raw-byte hash never corrupted. Belt-and-braces for the BLOCKER.
 */
function mappingIsBinary(mapping: StoredMapping): boolean {
  return (
    mapping.contentKind === 'binary' ||
    BINARY_EXTENSION_SET.has(pathExtension(mapping.path))
  );
}

/** Read-only vault access the rebase needs. `read` returns raw on-disk bytes. */
export interface RebaseVaultPort {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
}

/** Plugin-data blob persistence (wraps `Plugin.loadData`/`saveData`). */
export interface RebaseDataPort {
  load(): Promise<unknown>;
  save(data: Record<string, unknown>): Promise<void>;
}

export interface RebaseKeys {
  /** Top-level marker key recording the rebase version already applied. */
  readonly markerKey: string;
  /** Key under which the durable sync-state blob lives (holds `baseHashes`). */
  readonly persistKey: string;
  /** Key under which the producer state lives (holds `mappings`). */
  readonly producerKey: string;
}

export interface RebaseDependencies {
  readonly data: RebaseDataPort;
  readonly vault: RebaseVaultPort;
  /** SHA-256 over the canonical content — the plugin's `hashPlaintext`. */
  readonly hash: (content: string) => Promise<string>;
  /** The canonical content transform — the plugin's `canonicalizeMarkdown`. */
  readonly canonicalize: (content: string) => string;
  readonly keys: RebaseKeys;
  /** Defaults to `CANONICALIZATION_REBASE_VERSION`. */
  readonly targetVersion?: number;
}

export interface RebaseResult {
  readonly ran: boolean;
  readonly mappingsRebased: number;
  readonly baseHashesRebased: number;
  readonly missingFiles: number;
}

interface StoredMapping {
  readonly collisionKey: string;
  readonly content: string;
  readonly contentHash: string;
  readonly contentKind?: string;
  readonly fileId: string;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMapping(entry: unknown): StoredMapping | null {
  if (
    !isRecord(entry) ||
    typeof entry.collisionKey !== 'string' ||
    typeof entry.content !== 'string' ||
    typeof entry.contentHash !== 'string' ||
    typeof entry.fileId !== 'string' ||
    typeof entry.path !== 'string'
  ) {
    return null;
  }
  return {
    collisionKey: entry.collisionKey,
    content: entry.content,
    contentHash: entry.contentHash,
    ...(typeof entry.contentKind === 'string'
      ? { contentKind: entry.contentKind }
      : {}),
    fileId: entry.fileId,
    path: entry.path,
  };
}

/**
 * Runs the one-time rebase if the stored marker is below `targetVersion`.
 * Idempotent: a second call after a successful run is a no-op (`ran: false`).
 */
export async function rebaseCanonicalizedHashes(
  deps: RebaseDependencies,
): Promise<RebaseResult> {
  const targetVersion = deps.targetVersion ?? CANONICALIZATION_REBASE_VERSION;
  const raw = await deps.data.load();
  const data = isRecord(raw) ? raw : {};

  const marker = data[deps.keys.markerKey];
  if (typeof marker === 'number' && marker >= targetVersion) {
    return { ran: false, mappingsRebased: 0, baseHashesRebased: 0, missingFiles: 0 };
  }

  let mappingsRebased = 0;
  let baseHashesRebased = 0;
  let missingFiles = 0;

  // fileId → on-disk path, so a base hash keyed only by fileId can be resolved.
  const pathByFileId = new Map<string, string>();
  // Binary attachments (F9) are hashed over RAW bytes, which are
  // canonicalisation-independent, so they must NOT be rebased — recomputing them
  // via the markdown `canonicalize`/`hash` path would corrupt their byte hash.
  const binaryFileIds = new Set<string>();

  // --- Producer mappings: content + contentHash ---
  const producer = data[deps.keys.producerKey];
  let nextProducer: Record<string, unknown> | undefined;
  if (isRecord(producer) && Array.isArray(producer.mappings)) {
    const nextMappings: unknown[] = [];
    for (const entry of producer.mappings) {
      const mapping = readMapping(entry);
      if (mapping === null) {
        nextMappings.push(entry);
        continue;
      }
      pathByFileId.set(mapping.fileId, mapping.path);
      if (mappingIsBinary(mapping)) {
        binaryFileIds.add(mapping.fileId);
        nextMappings.push(entry);
        continue;
      }
      if (!deps.vault.exists(mapping.path)) {
        missingFiles += 1;
        nextMappings.push(entry);
        continue;
      }
      const canonical = deps.canonicalize(await deps.vault.read(mapping.path));
      const contentHash = await deps.hash(canonical);
      nextMappings.push({ ...mapping, content: canonical, contentHash });
      mappingsRebased += 1;
    }
    nextProducer = { ...producer, mappings: nextMappings };
  }

  // --- Sync-state base hashes ---
  const persist = data[deps.keys.persistKey];
  let nextPersist: Record<string, unknown> | undefined;
  if (isRecord(persist) && isRecord(persist.baseHashes)) {
    // A path owner map (path → fileId) supplements the mapping-derived paths so
    // a base hash for a remote-only file with no producer mapping still resolves.
    if (isRecord(persist.pathOwners)) {
      for (const [ownerPath, ownerFileId] of Object.entries(persist.pathOwners)) {
        if (typeof ownerFileId === 'string' && !pathByFileId.has(ownerFileId)) {
          pathByFileId.set(ownerFileId, ownerPath);
        }
      }
    }
    const nextBaseHashes: Record<string, unknown> = {};
    for (const [fileId, hash] of Object.entries(persist.baseHashes)) {
      // A binary attachment's base hash is over raw bytes (F9) — leave it exactly
      // as stored, never recompute it through the markdown canonicalise path.
      if (binaryFileIds.has(fileId)) {
        nextBaseHashes[fileId] = hash;
        continue;
      }
      const path = pathByFileId.get(fileId);
      if (typeof hash !== 'string' || path === undefined || !deps.vault.exists(path)) {
        if (typeof hash === 'string' && (path === undefined || !deps.vault.exists(path))) {
          missingFiles += 1;
        }
        nextBaseHashes[fileId] = hash;
        continue;
      }
      const canonical = deps.canonicalize(await deps.vault.read(path));
      nextBaseHashes[fileId] = await deps.hash(canonical);
      baseHashesRebased += 1;
    }
    nextPersist = { ...persist, baseHashes: nextBaseHashes };
  }

  await deps.data.save({
    ...data,
    ...(nextProducer === undefined ? {} : { [deps.keys.producerKey]: nextProducer }),
    ...(nextPersist === undefined ? {} : { [deps.keys.persistKey]: nextPersist }),
    [deps.keys.markerKey]: targetVersion,
  });

  return { ran: true, mappingsRebased, baseHashesRebased, missingFiles };
}
