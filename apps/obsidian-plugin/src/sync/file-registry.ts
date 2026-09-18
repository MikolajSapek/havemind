/**
 * One record per synced file, one owner, one write.
 *
 * WHY THIS EXISTS
 *
 * The same truth used to be stored twice. The push producer kept
 * `mappings[collisionKey]` (fileId, path, content, contentHash) and
 * `heads[fileId]`; the apply side kept `pathOwners[path]`, `baseHashes[fileId]`
 * and `baseContents[fileId]`, in a different blob, behind a different class.
 * Nothing structural held them together: `vault-apply.ts` alone carried 42
 * writes to the apply side against 20 paired calls into the producer side, so
 * correctness rested on a human remembering the pairing at every new branch.
 * Two "order matters" comments in that file mark production bugs of exactly
 * this class, each fixed by hand-reordering rather than by an invariant.
 *
 * Here a file is ONE record with ONE writer per real-world event, so the pairs
 * that used to drift are now fields set in a single assignment:
 *
 *   - the merge ancestor and its hash (`agreedContent`/`agreedHash`) cannot
 *     disagree, which is what used to make the three-way merge unsatisfiable
 *     and degrade every divergence into a conflict copy;
 *   - a file's identity cannot be half-updated, because path, collision key and
 *     fileId are indexes over one record, rebuilt together.
 *
 * WHAT THE FIELDS MEAN
 *
 *   localContent/localHash  what THIS device last wrote or read for the file.
 *                           Moves on every local edit.
 *   agreedContent/agreedHash what BOTH peers are known to hold. The merge
 *                           ancestor and the on-disk divergence oracle. Moves
 *                           only at a moment agreement is proven: a remote
 *                           apply, a convergence, or the server echoing this
 *                           device's own push back. NEVER on a local write,
 *                           because a local write proves nothing about the peer
 *                           (advancing it there reopens the silent-overwrite
 *                           window: a concurrent peer revision built on an older
 *                           head would arrive with on-disk == agreed and read as
 *                           a clean fast-forward).
 *   headRevisionId          the revision this device last authored or adopted,
 *                           i.e. the parent of its next local edit.
 */

/** Markdown or an allowlisted binary attachment; binaries keep no body. */
export type FileContentKind = 'markdown' | 'binary';

export interface FileRecord {
  readonly fileId: string;
  readonly path: string;
  /** Canonical, case-folded path used to detect two files claiming one slot. */
  readonly collisionKey: string;
  /** Last content this device wrote or read. Null for a binary attachment. */
  readonly localContent: string | null;
  readonly localHash: string;
  /** Last content both peers are known to share. Null when never proven. */
  readonly agreedContent: string | null;
  /** Hash of `agreedContent`; null exactly when there is no agreed state. */
  readonly agreedHash: string | null;
  readonly headRevisionId: string | null;
  readonly contentKind: FileContentKind;
}

/** What a caller supplies for either event; the registry decides what moves. */
export interface FileEvent {
  readonly fileId: string;
  readonly path: string;
  readonly collisionKey: string;
  readonly content: string | null;
  readonly contentHash: string;
  readonly headRevisionId: string | null;
  readonly contentKind?: FileContentKind;
}

function isValidRecord(value: unknown): value is FileRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.fileId === 'string' &&
    typeof record.path === 'string' &&
    typeof record.collisionKey === 'string' &&
    typeof record.localHash === 'string'
  );
}

export class FileRegistry {
  /** The single source of truth; every lookup below is an index over it. */
  readonly #byFileId = new Map<string, FileRecord>();
  readonly #fileIdByPath = new Map<string, string>();
  readonly #fileIdByCollisionKey = new Map<string, string>();

  constructor(records: readonly FileRecord[] = []) {
    for (const record of records) {
      // data.json is untrusted input: a damaged entry is dropped, never thrown
      // on, so one bad row cannot stop the plugin from starting.
      if (!isValidRecord(record)) continue;
      this.#insert(record);
    }
  }

  /**
   * This device wrote the file and queued a revision for it. The local view and
   * the head move; the agreed state does NOT, except on first authorship, where
   * there is no older agreement to protect and a file with no ancestor could
   * never merge at all.
   */
  authoredLocally(event: FileEvent): void {
    const existing = this.#byFileId.get(event.fileId);
    const kind = event.contentKind ?? existing?.contentKind ?? 'markdown';
    const firstAuthorship = existing === undefined || existing.agreedHash === null;
    this.#replace({
      fileId: event.fileId,
      path: event.path,
      collisionKey: event.collisionKey,
      localContent: event.content,
      localHash: event.contentHash,
      agreedContent: firstAuthorship ? event.content : existing.agreedContent,
      agreedHash: firstAuthorship ? event.contentHash : existing.agreedHash,
      headRevisionId: event.headRevisionId,
      contentKind: kind,
    });
  }

  /**
   * Both peers are known to hold this content: a remote revision was applied, a
   * convergence was observed, or the server echoed this device's own push back.
   * Local view, agreed state and head all move together, which is the whole
   * point of this class.
   */
  agreedWithPeer(event: FileEvent): void {
    const existing = this.#byFileId.get(event.fileId);
    this.#replace({
      fileId: event.fileId,
      path: event.path,
      collisionKey: event.collisionKey,
      localContent: event.content,
      localHash: event.contentHash,
      agreedContent: event.content,
      agreedHash: event.contentHash,
      headRevisionId: event.headRevisionId,
      contentKind: event.contentKind ?? existing?.contentKind ?? 'markdown',
    });
  }

  /**
   * Sets individual fields of a record, leaving the others untouched.
   *
   * MIGRATION ONLY. `vault-apply.ts` still writes the agreed state through six
   * separate methods (record/forget over path, hash and content), so a caller
   * sometimes holds just one of those fields. `patch` lets it write that field
   * without blanking its partners, while keeping every field on ONE record, so
   * the drift the six-method shape allowed is impossible even mid-migration.
   * Once the call sites speak in events, this method goes.
   */
  patch(
    fileId: string,
    changes: {
      readonly path?: string;
      readonly collisionKey?: string;
      readonly agreedContent?: string | null;
      readonly agreedHash?: string | null;
      readonly headRevisionId?: string | null;
    },
  ): void {
    const existing = this.#byFileId.get(fileId);
    const path = changes.path ?? existing?.path ?? '';
    this.#replace({
      fileId,
      path,
      collisionKey:
        changes.collisionKey ?? (changes.path !== undefined
          ? changes.path.normalize('NFC').toLowerCase()
          : (existing?.collisionKey ?? path.normalize('NFC').toLowerCase())),
      localContent: existing?.localContent ?? null,
      localHash: existing?.localHash ?? '',
      agreedContent:
        changes.agreedContent !== undefined
          ? changes.agreedContent
          : (existing?.agreedContent ?? null),
      agreedHash:
        changes.agreedHash !== undefined
          ? changes.agreedHash
          : (existing?.agreedHash ?? null),
      headRevisionId:
        changes.headRevisionId !== undefined
          ? changes.headRevisionId
          : (existing?.headRevisionId ?? null),
      contentKind: existing?.contentKind ?? 'markdown',
    });
  }

  /** The file is gone. Every index drops with the record, in one step. */
  removed(fileId: string): void {
    const existing = this.#byFileId.get(fileId);
    if (existing === undefined) return;
    this.#byFileId.delete(fileId);
    this.#fileIdByPath.delete(existing.path);
    this.#fileIdByCollisionKey.delete(existing.collisionKey);
  }

  byFileId(fileId: string): FileRecord | undefined {
    return this.#byFileId.get(fileId);
  }

  byPath(path: string): FileRecord | undefined {
    const fileId = this.#fileIdByPath.get(path);
    return fileId === undefined ? undefined : this.#byFileId.get(fileId);
  }

  byCollisionKey(collisionKey: string): FileRecord | undefined {
    const fileId = this.#fileIdByCollisionKey.get(collisionKey);
    return fileId === undefined ? undefined : this.#byFileId.get(fileId);
  }

  all(): IterableIterator<FileRecord> {
    return this.#byFileId.values();
  }

  /** The persisted form: a plain array, so the blob stays inspectable by hand. */
  toJSON(): FileRecord[] {
    return [...this.#byFileId.values()];
  }

  /**
   * Installs `record` as the sole owner of its fileId, path and collision key,
   * retiring whatever held those slots before. This is where the old split's
   * ordering bugs lived: a rename had to forget the old path and record the new
   * one in the right order, and a path changing hands had to retire the previous
   * owner's state before adopting the new one. Both are now one operation that
   * cannot be half-performed.
   */
  #replace(record: FileRecord): void {
    const previousSelf = this.#byFileId.get(record.fileId);
    if (previousSelf !== undefined) {
      this.#fileIdByPath.delete(previousSelf.path);
      this.#fileIdByCollisionKey.delete(previousSelf.collisionKey);
    }
    // A different file currently holding this slot is retired entirely: exactly
    // one record may own a path, and an orphan would resurface as a phantom.
    for (const displacedId of [
      this.#fileIdByPath.get(record.path),
      this.#fileIdByCollisionKey.get(record.collisionKey),
    ]) {
      if (displacedId === undefined || displacedId === record.fileId) continue;
      this.removed(displacedId);
    }
    this.#insert(record);
  }

  #insert(record: FileRecord): void {
    this.#byFileId.set(record.fileId, record);
    this.#fileIdByPath.set(record.path, record.fileId);
    this.#fileIdByCollisionKey.set(record.collisionKey, record.fileId);
  }
}
