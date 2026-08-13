import { canonicalizeMarkdown, hashBlob } from '@havemind/protocol';

import { CONFLICT_FOLDER } from '../runtime/conflict-resolution';
import { isSyncableConfigPath } from '../sync/appearance-scope';
import { normalizeConfigContent } from '../sync/config-normalize';

/**
 * Top-level folders the producer never syncs. The reserved conflict folder is
 * imported from its single definition in `runtime/conflict-resolution.ts` rather
 * than re-typed here: the name is load-bearing in three places (this exclusion,
 * the resolution flow, and the apply adapter's `conflictFolder`), and a
 * divergence would make every conflict copy sync back as an ordinary note — an
 * endless echo. `conflict-resolution.ts` has no runtime imports of its own
 * (Obsidian types only), so this direction introduces no cycle.
 */
const RESERVED_TOP_LEVEL_DIRECTORIES = new Set([CONFLICT_FOLDER]);

/**
 * Non-markdown file extensions the pilot syncs as whole-file binary attachments
 * (F9). Lowercase, no leading dot. Every other non-markdown extension stays
 * excluded (counted as an attachment in reconciliation, never read or enqueued).
 */
export const SYNCABLE_BINARY_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'pdf',
] as const;

/**
 * Hard per-file byte ceiling for a binary attachment. A file above this is
 * excluded-with-notice by reconciliation and skipped by the live observer — it
 * is intentionally NOT an error, so a single oversized asset never aborts a scan
 * or wedges the loop. The base64 payload of a file this size (~33 MB) is covered
 * by the raised payload ceiling in `outbox-repository.ts`.
 */
export const MAX_BINARY_FILE_BYTES = 25 * 1024 * 1024;

/** Whether a synced file carries markdown text or raw binary bytes (F9). */
export type SyncContentKind = 'markdown' | 'binary';

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
  /**
   * Canonical markdown text, or — for a binary attachment (F9) — the base64 of
   * the raw file bytes. Optional discriminator `contentKind` says which; absent
   * means markdown, so every legacy mapping keeps its meaning unchanged.
   */
  content: string;
  /**
   * SHA-256 hex. For markdown this is the hash of the canonical text; for a
   * binary attachment it is the hash of the RAW bytes (`hashBlob`), never a
   * canonicalised form.
   */
  contentHash: string;
  contentKind?: SyncContentKind;
  fileId: string;
  path: string;
}

export interface LocalChangeOperation {
  content: string | null;
  contentHash: string | null;
  /**
   * Markdown vs binary attachment (F9). Absent means markdown. For a binary
   * change, `content` carries base64 of the raw bytes and `contentHash` is the
   * raw-byte hash.
   */
  contentKind?: SyncContentKind;
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
  /**
   * Every syncable path — markdown notes AND allowlisted binary attachments
   * (F9). Renamed from the markdown-only `listMarkdownPaths`; callers must
   * classify each path with `classifyVaultPath` to learn its `kind`.
   */
  listSyncablePaths(): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  /** Raw bytes of a binary attachment at `path` (F9). */
  readBinary(path: string): Promise<Uint8Array>;
  /**
   * Whether a file currently exists on disk at `path`. `readText` cannot tell a
   * missing file from an empty one (it returns '' for both), so a settled modify
   * arriving after a rename/delete would otherwise read '' and push a phantom
   * empty create. This lets the observer distinguish the two and skip a create
   * for a file that is no longer there.
   */
  exists(path: string): Promise<boolean>;
  /**
   * Every file in the vault, of any type. Used only to count non-syncable
   * attachments that `listSyncablePaths` never surfaces, so the pilot's sync
   * scope stays observable instead of a silent gap. Never read/enqueued.
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
  | {
      canonicalPath: string;
      collisionKey: string;
      eligible: true;
      kind: SyncContentKind;
    };

type EligibleClassification = Extract<VaultPathClassification, { eligible: true }>;

export interface VaultChangeObserverOptions {
  clock: () => number;
  generateFileId: () => string;
  generateOperationId: () => string;
  repository: LocalChangeRepository;
  vault: VaultSnapshotPort;
}

/**
 * The single canonical wire-path transform: Windows backslash separators →
 * forward slashes, then NFC. This is the exact form Obsidian indexes files
 * under (`getAbstractFileByPath`), the form the wire contract mandates, and the
 * form every stored `mapping.path` / `collisionKey` is derived from. Every
 * producer-side path comparison and disk read MUST run through this so a
 * backslash-delivered path (a Windows event, a folder-rename prefix, a plugin
 * quirk) is self-consistent with stored mappings and resolves on disk.
 */
export function normalizeWirePath(path: string): string {
  return path.replace(/\\/gu, '/').normalize('NFC');
}

export function classifyVaultPath(path: string): VaultPathClassification {
  // Producer boundary: normalise Windows backslash separators to the forward
  // slashes the wire contract mandates BEFORE any classification. Obsidian's
  // vault API normally yields forward slashes, but a backslash path (from a
  // Windows path join, a plugin, or an OS quirk) would otherwise be classified
  // eligible here and then throw inside `canonicalizeVaultPath` at envelope-build
  // time — a throw that kills the entire push cycle and latches the device
  // "Offline" forever (the Windows field bug). Normalising first keeps the wire
  // path forward-slash and self-consistent with the peer's collision key. The
  // on-disk read (see `resolveReadPath`) tries this canonical form FIRST and
  // only falls back to the caller's original path, so a backslash path resolves
  // against Obsidian's forward-slash index instead of silently reading ''.
  const canonicalPath = normalizeWirePath(path);
  const kind = eligibleKind(canonicalPath);
  if (kind === null) {
    return { eligible: false };
  }

  return {
    canonicalPath,
    collisionKey: canonicalPath.toLowerCase(),
    eligible: true,
    kind,
  };
}

/**
 * Extension of a path, lowercased, without the dot; `''` when there is none.
 * A dotfile like `.gitignore` has no extension by this definition — its leading
 * dot is caught by the dotpath guard, never mistaken for an attachment.
 */
export function pathExtension(canonicalPath: string): string {
  const dot = canonicalPath.lastIndexOf('.');
  const slash = canonicalPath.lastIndexOf('/');
  if (dot <= slash + 1) return '';
  return canonicalPath.slice(dot + 1).toLowerCase();
}

const SYNCABLE_BINARY_EXTENSION_SET: ReadonlySet<string> = new Set(
  SYNCABLE_BINARY_EXTENSIONS,
);

/**
 * Text extensions the `.obsidian/` appearance mirror carries through the
 * text/'markdown' content path (canonicalised, hashed as UTF-8). A binary
 * config asset (an extension in {@link SYNCABLE_BINARY_EXTENSION_SET}) rides the
 * existing base64 + size-cap path instead; that set is checked FIRST so a
 * genuinely binary format is never routed through the text path (which would
 * corrupt it). An extension in NEITHER set stays excluded-with-notice — kept as
 * defence in depth even though the scope allowlist admits no such extension
 * today, so widening the allowlist can never silently corrupt a new format.
 */
const CONFIG_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'json',
  'css',
  'js',
  'txt',
]);

/**
 * Content kind for a `.obsidian/` config path already admitted by
 * {@link isSyncableConfigPath}. Binary formats first (exact bytes, size cap),
 * then text formats, else `null` (excluded-with-notice — never forced through
 * the text path).
 */
function configContentKind(canonicalPath: string): SyncContentKind | null {
  const extension = pathExtension(canonicalPath);
  if (SYNCABLE_BINARY_EXTENSION_SET.has(extension)) return 'binary';
  if (CONFIG_TEXT_EXTENSIONS.has(extension)) return 'markdown';
  return null;
}

/**
 * Returns the sync kind of a path, or `null` when it is not syncable. Markdown
 * notes and the allowlisted binary attachments (F9) are eligible; the dotpath
 * and reserved-`Havemind Conflicts` exclusions are UNCHANGED, so a Havemind
 * conflict artifact is never re-synced (rule: no cycles).
 */
function eligibleKind(canonicalPath: string): SyncContentKind | null {
  // `.obsidian/` APPEARANCE ALLOWLIST (theme CSS, snippets, hotkeys,
  // appearance/app settings) — ONLY the explicit set named inside
  // `isSyncableConfigPath`. Third-party plugin code and state
  // (`.obsidian/plugins/**`), the enabled-plugins registry and per-machine
  // `workspace.json` are NOT in scope: mirroring a peer's plugin code let any
  // vault member overwrite another member's installed plugin, which Obsidian
  // then executes on reload (audit #3 finding 2).
  // Admitted here — and ONLY here — BEFORE the dotpath guard below that
  // (correctly) rejects every other dot-path. The content kind is chosen by
  // EXTENSION, not forced to text: a binary config asset uses the base64 path,
  // an unknown binary stays excluded-with-notice, only genuine text config is
  // canonicalised. The reserved `Havemind Conflicts/` exclusion below is
  // untouched — no config path lives there — so no re-sync cycle is introduced.
  if (isSyncableConfigPath(canonicalPath)) {
    return configContentKind(canonicalPath);
  }

  const extension = pathExtension(canonicalPath);
  const kind: SyncContentKind | null =
    extension === 'md'
      ? 'markdown'
      : SYNCABLE_BINARY_EXTENSION_SET.has(extension)
        ? 'binary'
        : null;
  if (kind === null) {
    return null;
  }

  const segments = canonicalPath.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) {
    return null;
  }

  const [top] = segments;
  if (top === undefined || RESERVED_TOP_LEVEL_DIRECTORIES.has(top)) {
    return null;
  }
  return kind;
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
    return this.commitCreate(path, classified);
  }

  /**
   * Resolves the on-disk path to read from, canonical-first (FINDING 3). The
   * canonical (forward-slash, NFC) form matches Obsidian's own path index, so it
   * is tried first; the caller's original path is a belt-and-braces fallback for
   * an exotic filesystem where only the raw form resolves. Returns `null` when
   * NEITHER variant exists on disk — a genuine miss. Reading via the original
   * (possibly backslash) path alone would miss on real Obsidian and either drop a
   * live edit or read '' and push a phantom empty file over the peer's copy.
   */
  private async resolveReadPath(
    canonicalPath: string,
    originalPath: string,
  ): Promise<string | null> {
    if (await this.options.vault.exists(canonicalPath)) return canonicalPath;
    if (
      originalPath !== canonicalPath &&
      (await this.options.vault.exists(originalPath))
    ) {
      return originalPath;
    }
    return null;
  }

  /**
   * Reads a file's content and content hash according to its sync kind: markdown
   * is canonicalised text hashed with SHA-256; a binary attachment is read as raw
   * bytes, carried as base64 in `content`, and hashed over the RAW bytes
   * (`hashBlob`) — never a canonicalised form (F9). The read uses the canonical
   * path first, falling back to the original (FINDING 3). Returns `null` when the
   * file resolves at neither path (a genuine miss — never push a phantom '') or
   * when a binary file is over {@link MAX_BINARY_FILE_BYTES} (excluded, not an
   * error).
   */
  private async readContentForKind(
    canonicalPath: string,
    originalPath: string,
    kind: SyncContentKind,
  ): Promise<{ content: string; contentHash: string } | null> {
    const readPath = await this.resolveReadPath(canonicalPath, originalPath);
    if (readPath === null) return null;
    if (kind === 'binary') {
      const bytes = await this.options.vault.readBinary(readPath);
      if (bytes.byteLength > MAX_BINARY_FILE_BYTES) return null;
      return { content: bytesToBase64(bytes), contentHash: await hashBlob(bytes) };
    }
    // A config file with machine-local VIEW STATE syncs only its semantic part
    // (`config-normalize.ts`): `.obsidian/graph.json` carries the graph view's
    // current zoom and panel-fold flags, which Obsidian rewrites merely because
    // the view was opened. Hashing the NORMALIZED form is what makes such a
    // rewrite compare EQUAL to the mapping, so it produces no revision at all —
    // and it is the normalized form that is pushed, so a peer never adopts this
    // machine's zoom level. Identity for every other path.
    const content = normalizeContent(
      normalizeConfigContent(canonicalPath, await this.options.vault.readText(readPath)),
    );
    return { content, contentHash: await sha256Hex(content) };
  }

  private async commitCreate(
    readPath: string,
    classified: EligibleClassification,
  ): Promise<LocalChangeOperation | null> {
    const read = await this.readContentForKind(
      classified.canonicalPath,
      readPath,
      classified.kind,
    );
    if (read === null) return null;
    const { content, contentHash } = read;
    const fileId = this.options.generateFileId();
    const operation = this.buildOperation({
      content,
      contentHash,
      contentKind: classified.kind,
      fileId,
      kind: 'create',
      path: classified.canonicalPath,
      previousContent: null,
      previousContentHash: null,
      previousPath: null,
    });

    const revisionId = await this.options.repository.commitLocalChange({
      operation,
      removeFileId: null,
      upsertMapping: {
        collisionKey: classified.collisionKey,
        content,
        contentHash,
        contentKind: classified.kind,
        fileId,
        path: classified.canonicalPath,
      },
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
      // A settled modify can arrive after the same path was renamed away or
      // deleted (the debounce cancel is the primary guard; this is the cheap
      // safety net). `commitCreate` reads canonical-first and returns null when
      // the file resolves at NEITHER the canonical nor the original path, so a
      // vacated path never pushes a phantom empty create — while a genuinely
      // new, unmapped file that IS on disk (at its canonical path) still creates.
      // Resolving via `readContentForKind` (not a raw `exists(path)` on the
      // possibly-backslash original) is what stops a real Windows edit being
      // silently dropped (FINDING 3).
      return this.commitCreate(path, classified);
    }

    return this.commitModify(path, classified, mapping);
  }

  private async commitModify(
    readPath: string,
    classified: EligibleClassification,
    mapping: LocalFileMapping,
  ): Promise<LocalChangeOperation | null> {
    const read = await this.readContentForKind(
      classified.canonicalPath,
      readPath,
      classified.kind,
    );
    if (read === null) return null;
    const { content, contentHash } = read;
    if (contentHash === mapping.contentHash) return null;

    const operation = this.buildOperation({
      content,
      contentHash,
      contentKind: classified.kind,
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
        contentKind: classified.kind,
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
      return to.eligible ? this.commitCreate(nextPath, to) : null;
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

    const read = await this.readContentForKind(
      to.canonicalPath,
      nextPath,
      to.kind,
    );
    if (read === null) return null;
    const { content, contentHash } = read;
    const operation = this.buildOperation({
      content,
      contentHash,
      contentKind: to.kind,
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
        contentKind: to.kind,
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
    // FINDING 2: normalise backslash→slash (+ NFC), the SAME transform every
    // stored `mapping.path` went through. A backslash-delivered folder prefix
    // that only gets NFC'd never matches a forward-slash mapping.path, so every
    // child is silently skipped and left forked at its old path.
    const fromPrefix = normalizeWirePath(previousFolderPath);
    const toPrefix = normalizeWirePath(nextFolderPath);
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
    // FINDING 2: same backslash→slash (+ NFC) normalisation as the folder rename
    // so a backslash-delivered delete prefix matches the stored forward-slash
    // mapping.path instead of silently skipping every child.
    const prefix = normalizeWirePath(folderPath);
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
      ...(mapping.contentKind === undefined ? {} : { contentKind: mapping.contentKind }),
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

/**
 * Base64 of raw bytes, binary-safe (every byte 0x00–0xFF preserved). This is the
 * exact bijection the wire codec (`@havemind/sync-core`) uses, so the base64 an
 * observer stores in `content` round-trips to identical bytes on decode (F9).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
