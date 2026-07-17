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
      return this.commitCreate(nextPath, to.canonicalPath, to.collisionKey);
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
  return text.replace(/\r\n?/gu, '\n');
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
