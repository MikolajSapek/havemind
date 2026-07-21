import { canonicalizeMarkdown } from '@havemind/protocol';

const RESERVED_TOP_LEVEL_DIRECTORIES = new Set(['Havemind Conflicts']);

export type LocalVaultErrorCode = 'path-collision';

export class LocalVaultError extends Error {
  override readonly name = 'LocalVaultError';

  constructor(
    readonly code: LocalVaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type LocalChangeKind = 'create' | 'update' | 'rename' | 'delete';

export interface LocalFileMapping {
  collisionKey: string;
  content: string;
  contentHash: string;
  fileId: string;
  path: string;
}

export interface LocalChangeOperation {
  content: string | null;
  contentHash: string | null;
  fileId: string;
  kind: LocalChangeKind;
  observedAt: number;
  operationId: string;
  path: string;
  previousContent: string | null;
  previousContentHash: string | null;
  previousPath: string | null;
  /**
   * The real revision id the repository generated and enqueued for this
   * change (`OutboxLocalChangeRepository`'s `built.revisionId`), or `null`
   * when the commit never produced a revision (a delete of a file that was
   * never pushed). This is the id that must be recorded in the Activity feed
   * and used for local/remote-echo dedup — `operationId` is a client-only
   * idempotency key, never a revision id.
   */
  revisionId: string | null;
}

export interface LocalChangeCommit {
  operation: LocalChangeOperation;
  removeFileId: string | null;
  upsertMapping: LocalFileMapping | null;
}

export interface VaultSnapshotPort {
  listMarkdownPaths(): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  /**
   * Every file in the vault, markdown or not. Used only to count non-markdown
   * attachments that `listMarkdownPaths` never surfaces, so the pilot's
   * markdown-only scope stays observable instead of a silent gap (see
   * `isEligiblePath` below). Never read via `readText` and never enqueued.
   */
  listAllPaths(): Promise<readonly string[]>;
}

export interface LocalChangeRepository {
  /**
   * Commits the change and returns the real revision id it enqueued (or
   * `null` when no revision was created — a delete with no prior push). The
   * caller (the observer below) attaches this to the returned
   * `LocalChangeOperation.revisionId` so callers never fall back to the
   * client-only `operationId` for revision identity.
   */
  commitLocalChange(commit: LocalChangeCommit): Promise<string | null>;
  listMappings(): Promise<readonly LocalFileMapping[]>;
}

export type VaultPathClassification =
  | { eligible: false }
  | { canonicalPath: string; collisionKey: string; eligible: true };

export interface VaultChangeObserverOptions {
  clock: () => number;
  generateFileId: () => string;
  generateOperationId: () => string;
  repository: LocalChangeRepository;
  vault: VaultSnapshotPort;
}

export function classifyVaultPath(path: string): VaultPathClassification {
  const canonicalPath = path.normalize('NFC');
  if (!isEligiblePath(canonicalPath)) {
    return { eligible: false };
  }

  return {
    canonicalPath,
    collisionKey: canonicalPath.toLowerCase(),
    eligible: true,
  };
}

function isEligiblePath(canonicalPath: string): boolean {
  // Deliberate MVP scope, not an oversight: the pilot syncs markdown notes only.
  // Non-markdown attachments (images, PDFs, ...) are intentionally excluded here
  // and are never read or enqueued. Full binary/attachment sync is a follow-up
  // (F9) — until then, reconciliation counts and surfaces the exclusion so it
  // stays visible to the user instead of silently dropping attachments.
  if (!canonicalPath.toLowerCase().endsWith('.md')) {
    return false;
  }

  const segments = canonicalPath.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) {
    return false;
  }

  const [top] = segments;
  return top !== undefined && !RESERVED_TOP_LEVEL_DIRECTORIES.has(top);
}

export class VaultChangeObserver {
  private readonly options: VaultChangeObserverOptions;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: VaultChangeObserverOptions) {
    this.options = options;
  }

  async observeCreate(path: string): Promise<LocalChangeOperation | null> {
    return this.enqueue(() => this.handleCreate(path));
  }

  async observeModify(path: string): Promise<LocalChangeOperation | null> {
    return this.enqueue(() => this.handleModify(path));
  }

  async observeRename(
    previousPath: string,
    nextPath: string,
  ): Promise<LocalChangeOperation | null> {
    return this.enqueue(() => this.handleRename(previousPath, nextPath));
  }

  async observeDelete(path: string): Promise<LocalChangeOperation | null> {
    return this.enqueue(() => this.handleDelete(path));
  }

  /**
   * Handles a folder-level rename (Obsidian or another plugin moving a whole
   * folder). Defence-in-depth: it does NOT assume Obsidian emits a per-child
   * TFile rename for every note. It enumerates the mappings under the folder's
   * OLD path prefix and routes each through the existing per-file rename
   * machinery so heads/base state stay consistent. If a per-child event ALSO
   * fires later, that child is already at its new path and dedupes to a no-op
   * (see `handleRename`), so no child is double-processed. Returns the genuine
   * per-child operations (empty when nothing was under the folder).
   */
  async observeFolderRename(
    previousFolderPath: string,
    nextFolderPath: string,
  ): Promise<LocalChangeOperation[]> {
    return this.enqueue(() =>
      this.handleFolderRename(previousFolderPath, nextFolderPath),
    );
  }

  /**
   * Handles a folder-level delete by enumerating the mappings under the deleted
   * folder's prefix and routing each through the existing per-file delete path
   * (tombstoning each note). Idempotent with any per-child TFile delete events.
   */
  async observeFolderDelete(
    folderPath: string,
  ): Promise<LocalChangeOperation[]> {
    return this.enqueue(() => this.handleFolderDelete(folderPath));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(noop, noop);
    return run;
  }

  private async handleCreate(
    path: string,
  ): Promise<LocalChangeOperation | null> {
    const classified = classifyVaultPath(path);
    if (!classified.eligible) return null;
    // A create event for a path Havemind ALREADY maps must never mint a fresh
    // fileId — that forks the file across devices. This is the reflected event a
    // remote-apply write fires: the apply side has adopted the incoming fileId
    // into the producer mapping in lockstep, so this create resolves to that
    // mapping and dedupes to a no-op (content already matches) instead of a
    // re-push. A genuine new local file has no mapping and still creates.
    const existing = await this.findMapping(classified.collisionKey);
    if (existing !== undefined) {
      return this.commitModify(path, classified, existing);
    }
    return this.commitCreate(path, classified.canonicalPath, classified.collisionKey);
  }

  private async commitCreate(
    readPath: string,
    canonicalPath: string,
    collisionKey: string,
  ): Promise<LocalChangeOperation> {
    const content = normalizeContent(await this.options.vault.readText(readPath));
    const contentHash = await sha256Hex(content);
    const fileId = this.options.generateFileId();
    const operation = this.buildOperation({
      content,
      contentHash,
      fileId,
      kind: 'create',
      path: canonicalPath,
      previousContent: null,
      previousContentHash: null,
      previousPath: null,
    });

    const revisionId = await this.options.repository.commitLocalChange({
      operation,
      removeFileId: null,
      upsertMapping: { collisionKey, content, contentHash, fileId, path: canonicalPath },
    });
    return { ...operation, revisionId };
  }

  private async handleModify(
    path: string,
  ): Promise<LocalChangeOperation | null> {
    const classified = classifyVaultPath(path);
    if (!classified.eligible) return null;

    const mapping = await this.findMapping(classified.collisionKey);
    if (mapping === undefined) {
      return this.commitCreate(path, classified.canonicalPath, classified.collisionKey);
    }

    return this.commitModify(path, classified, mapping);
  }

  private async commitModify(
    readPath: string,
    classified: Extract<VaultPathClassification, { eligible: true }>,
    mapping: LocalFileMapping,
  ): Promise<LocalChangeOperation | null> {
    const content = normalizeContent(await this.options.vault.readText(readPath));
    const contentHash = await sha256Hex(content);
    if (contentHash === mapping.contentHash) return null;

    const operation = this.buildOperation({
      content,
      contentHash,
      fileId: mapping.fileId,
      kind: 'update',
      path: classified.canonicalPath,
      previousContent: mapping.content,
      previousContentHash: mapping.contentHash,
      previousPath: null,
    });

    const revisionId = await this.options.repository.commitLocalChange({
      operation,
      removeFileId: null,
      upsertMapping: {
        collisionKey: classified.collisionKey,
        content,
        contentHash,
        fileId: mapping.fileId,
        path: classified.canonicalPath,
      },
    });
    return { ...operation, revisionId };
  }

  private async handleRename(
    previousPath: string,
    nextPath: string,
  ): Promise<LocalChangeOperation | null> {
    const from = classifyVaultPath(previousPath);
    const to = classifyVaultPath(nextPath);

    if (!from.eligible) {
      return to.eligible
        ? this.commitCreate(nextPath, to.canonicalPath, to.collisionKey)
        : null;
    }
    if (!to.eligible) {
      return this.commitDelete(from.collisionKey);
    }

    const mapping = await this.findMapping(from.collisionKey);
    if (mapping === undefined) {
      // The source is no longer mapped. The likely cause is a folder-level
      // rename that already re-pathed this child through the per-file machinery
      // (see handleFolderRename); a late per-child event then arrives with the
      // OLD source path. Route through handleCreate so an event for a path we
      // ALREADY map at the destination dedupes to a no-op instead of minting a
      // fresh fileId (a fork). A genuinely new destination still creates.
      return this.handleCreate(nextPath);
    }

    const occupant = await this.findMapping(to.collisionKey);
    if (occupant !== undefined && occupant.fileId !== mapping.fileId) {
      throw new LocalVaultError(
        'path-collision',
        `A different file already occupies ${to.canonicalPath}.`,
      );
    }

    const content = normalizeContent(await this.options.vault.readText(nextPath));
    const contentHash = await sha256Hex(content);
    const operation = this.buildOperation({
      content,
      contentHash,
      fileId: mapping.fileId,
      kind: 'rename',
      path: to.canonicalPath,
      previousContent: mapping.content,
      previousContentHash: mapping.contentHash,
      previousPath: from.canonicalPath,
    });

    const revisionId = await this.options.repository.commitLocalChange({
      operation,
      removeFileId: null,
      upsertMapping: {
        collisionKey: to.collisionKey,
        content,
        contentHash,
        fileId: mapping.fileId,
        path: to.canonicalPath,
      },
    });
    return { ...operation, revisionId };
  }

  private async handleDelete(
    path: string,
  ): Promise<LocalChangeOperation | null> {
    const classified = classifyVaultPath(path);
    if (!classified.eligible) return null;
    return this.commitDelete(classified.collisionKey);
  }

  private async handleFolderRename(
    previousFolderPath: string,
    nextFolderPath: string,
  ): Promise<LocalChangeOperation[]> {
    const fromPrefix = previousFolderPath.normalize('NFC');
    const toPrefix = nextFolderPath.normalize('NFC');
    const results: LocalChangeOperation[] = [];
    // A snapshot taken up-front; per-child renames below mutate the underlying
    // store, but each child has a distinct path so iterating the snapshot never
    // revisits a child.
    for (const mapping of await this.options.repository.listMappings()) {
      const suffix = pathUnderFolder(mapping.path, fromPrefix);
      if (suffix === null) continue;
      const op = await this.handleRename(mapping.path, `${toPrefix}${suffix}`);
      if (op !== null) results.push(op);
    }
    return results;
  }

  private async handleFolderDelete(
    folderPath: string,
  ): Promise<LocalChangeOperation[]> {
    const prefix = folderPath.normalize('NFC');
    const results: LocalChangeOperation[] = [];
    for (const mapping of await this.options.repository.listMappings()) {
      if (pathUnderFolder(mapping.path, prefix) === null) continue;
      const op = await this.handleDelete(mapping.path);
      if (op !== null) results.push(op);
    }
    return results;
  }

  private async commitDelete(
    collisionKey: string,
  ): Promise<LocalChangeOperation | null> {
    const mapping = await this.findMapping(collisionKey);
    if (mapping === undefined) return null;

    const operation = this.buildOperation({
      content: null,
      contentHash: null,
      fileId: mapping.fileId,
      kind: 'delete',
      path: mapping.path,
      previousContent: mapping.content,
      previousContentHash: mapping.contentHash,
      previousPath: null,
    });

    const revisionId = await this.options.repository.commitLocalChange({
      operation,
      removeFileId: mapping.fileId,
      upsertMapping: null,
    });
    return { ...operation, revisionId };
  }

  private async findMapping(
    collisionKey: string,
  ): Promise<LocalFileMapping | undefined> {
    const mappings = await this.options.repository.listMappings();
    return mappings.find((mapping) => mapping.collisionKey === collisionKey);
  }

  private buildOperation(
    fields: Omit<LocalChangeOperation, 'observedAt' | 'operationId' | 'revisionId'>,
  ): LocalChangeOperation {
    return {
      ...fields,
      observedAt: this.options.clock(),
      operationId: this.options.generateOperationId(),
      // Unknown until the repository commits the change and reports back the
      // real id it enqueued; the caller fills this in on the returned object.
      revisionId: null,
    };
  }
}

function normalizeContent(text: string): string {
  // Single canonical content transform shared with every other hashing/diff
  // site (protocol `canonicalizeMarkdown`): CRLF/CR→LF, strip BOM, exactly one
  // trailing newline. Hash-side only — the user's file on disk is never
  // rewritten. See AUD-03.
  return canonicalizeMarkdown(text);
}

/**
 * Returns the path suffix (leading '/') if `path` lies directly under
 * `folderPrefix`, or `null` otherwise. Segment-exact: `Notes/Sub` matches
 * `Notes/Sub/x.md` but never the sibling `Notes/Subtle/y.md`, because matching
 * requires the trailing '/' boundary.
 */
function pathUnderFolder(path: string, folderPrefix: string): string | null {
  const prefix = `${folderPrefix}/`;
  return path.startsWith(prefix) ? path.slice(folderPrefix.length) : null;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function noop(): undefined {
  return undefined;
}
