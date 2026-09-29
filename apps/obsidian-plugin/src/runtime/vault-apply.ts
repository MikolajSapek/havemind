import { ancestors, commonAncestor, type RevisionHistory } from './revision-history';
import { ApplyDeferredError } from './apply-deferred';
/**
 * Bridges the runner's `VaultApplyPort` to the Obsidian Vault: materializes
 * remote revisions, including files that only exist on the other device, at the
 * path of the decoded payload (`resolveRevision`). It never blindly overwrites:
 *  - a path owned by a DIFFERENT local file is a collision: the content goes to
 *    `Havemind Conflicts/` and the live file is untouched;
 *  - a delete tombstone removes a file only if the same fileId owns that path.
 * While an editor holds unsaved text for the file, the runner and `applyRemote`
 * both defer.
 */

import {
  canonicalizeMarkdown,
  hashBlob,
  isSyncableConfigPath,
  pathExtension,
  type SyncContentKind,
} from '@havemind/protocol';
import { mergeText, type DecodedRevisionPayload } from '@havemind/sync-core';

import {
  bytesToBase64,
  classifyVaultPath,
} from '../obsidian/vault-adapter';

import { withKeys, KeyedMutex, type KeyedLock } from './keyed-mutex';

import type {
  OpenBuffer,
  RemoteApplyOptions,
  RemoteApplyOutcome,
  RemoteEvent,
  VaultApplyPort,
} from '../sync/sync-runner';

/**
 * Thrown by a `VaultFilePort` create when an ancestor of the target path is a
 * FILE. PERMANENT and per-item: apply diverts the content to a conflict
 * artifact, since bubbling it to the sync cycle reads as 'offline' and wedges
 * the pull loop. A transient write error (disk full, IO) still throws.
 */
export class ParentFolderOccupiedError extends Error {
  readonly occupiedPath: string;
  constructor(occupiedPath: string) {
    super(`Cannot create parent folder: path occupied by a file: ${occupiedPath}`);
    this.name = 'ParentFolderOccupiedError';
    this.occupiedPath = occupiedPath;
  }
}

export interface VaultFilePort {
  openBufferStates(fileId: string): readonly OpenBuffer[] | Promise<readonly OpenBuffer[]>;
  fileIdAtPath(path: string): string | null;
  readByPath(path: string): Promise<string | null>;
  readBinaryByPath(path: string): Promise<Uint8Array | null>;
  writeByPath(path: string, content: string, expectedContent?: string | null): Promise<void>;
  writeBinaryByPath(path: string, bytes: Uint8Array): Promise<void>;
  deleteByPath(path: string): Promise<void>;
  writeConflictArtifact(path: string, content: string): Promise<void>;
  writeBinaryConflictArtifact(path: string, bytes: Uint8Array): Promise<void>;
  recordPathOwner(fileId: string, path: string): Promise<void>;
  /** One write (P1): `fileId` owns `path`; base `hash` and, unless null, `content`. */
  recordApplied(
    fileId: string,
    path: string,
    hash: string,
    content: string | null,
  ): Promise<void>;
  forgetPath(path: string): Promise<void>;
  baseHashFor(fileId: string): string | null;
  forgetBaseHash(fileId: string): Promise<void>;
  /** The merge ancestor (MRG-01), or null. Markdown only: a binary never merges. */
  baseContentFor(fileId: string): string | null;
  forgetBaseContent(fileId: string): Promise<void>;
  /** True when a file already exists at `path` (conflict-name collision probe). */
  conflictArtifactExists(path: string): Promise<boolean>;
  /** Copy path recorded for `revisionId`, or null; a re-delivery reuses it (MRG-02). */
  conflictArtifactPathFor(revisionId: string): string | null;
  /**
   * Durably record the conflict-artifact path chosen for `revisionId`, and the
   * file it belongs to so the auto-sweep never guesses the target by name.
   */
  recordConflictArtifactPath(
    revisionId: string,
    path: string,
    fileId?: string,
  ): Promise<void>;
}

/** Naming inputs for a readable conflict copy (MRG-02), injected for tests. */
export interface ConflictNaming {
  /** Wall clock for the `YYYY-MM-DD HHmm` stamp; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Short display name for the revision's author (roster name or device label). */
  readonly resolveAuthorName?: (event: RemoteEvent) => string | undefined;
  /** Label used when no author can be resolved. Defaults to `'peer'`. */
  readonly fallbackAuthorName?: string;
}

/** Longest a note basename may be inside a conflict filename (keeps paths sane). */
const MAX_CONFLICT_BASENAME_LENGTH = 60;

/**
 * Whether a divergence at `path` resolves LAST-WRITER-WINS instead of by a
 * conflict copy: true for allowlisted `.obsidian/` settings files, false for
 * every note and attachment.
 *
 * USER DECISION, 2026-08-12. Rule 3 guards NOTES: typed prose can never be
 * reconstructed, so a divergent note goes to `Havemind Conflicts/`. A settings
 * value is set again in one click, and its conflict copy protected nothing
 * (Obsidian never reads it) while the synced colour groups kept losing to the
 * churn. So a config divergence resolves by RECENCY: revisions apply in the
 * server's total order (`serverSequence`) and the last one applied wins. A local
 * settings change still in the outbox becomes the later writer once accepted.
 */
function resolvesLastWriterWins(path: string): boolean {
  return isSyncableConfigPath(path);
}

export type RemoteAppliedOrigin = 'bootstrap' | 'live';

/** The raw fields reported for a genuinely applied remote revision (FIX 1). */
export interface RemoteAppliedEvent {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly operation: DecodedRevisionPayload['operation'];
  /** `bootstrap`: initial catch-up (Activity stays quiet); `live` afterwards. */
  readonly origin: RemoteAppliedOrigin;
  /** Authoring membership, from the pull receipt (P4); never inferred here. */
  readonly authorMembershipId?: string;
}

/**
 * Keeps the push producer's fileId↔path↔content map in lockstep with what apply
 * writes: adopting the incoming fileId + content BEFORE a write dedupes its vault
 * event, which would otherwise be re-pushed as a local revision, recorded as
 * LOCAL activity and (for a remote-only create) given a new random fileId.
 */
export interface RemoteApplyProducerSync {
  checkpointApply?(fileId: string, paths: readonly string[]): Promise<(() => Promise<void>) & { complete?: () => Promise<void> }>;
  /** Adopt `fileId`/`content` for `path`, parenting future local edits on
   * `revisionId`. `contentHash` is the SHA-256 hex of the note text, or the
   * raw-byte hash of a binary. `contentKind` keeps the binary/markdown
   * discriminator (else a RECEIVED binary would be persisted as markdown and
   * corrupted by the canonicalization rebase); absent means markdown. */
  onRemoteWrite(input: {
    readonly fileId: string;
    readonly path: string;
    readonly content: string;
    readonly contentHash: string;
    readonly revisionId: string;
    readonly contentKind?: SyncContentKind;
  }): Promise<void>;
  /** Forget the producer mapping+head for a remotely deleted `path`/`fileId`. */
  onRemoteDelete(input: {
    readonly fileId: string;
    readonly path: string;
  }): Promise<void>;
  /**
   * This device's head revisionId for `fileId` (the last it authored or adopted),
   * or null. Lets apply tell a causal fast-forward (the revision descends from
   * our head) from a concurrent divergence (rule 3). Optional in tests.
   */
  localHeadFor?(fileId: string): Promise<string | null>;
  /** Content and identity captured together from the producer's current revision. */
  localVersionFor?(fileId: string): Promise<{
    readonly revisionId: string;
    readonly contentHash: string;
  } | null>;
  /** Durably enqueue the merge before its reflected file event can be deduped. */
  onMergedWrite?(input: {
    readonly fileId: string;
    readonly path: string;
    readonly content: string;
    readonly contentHash: string;
    readonly remoteRevisionId: string;
    readonly remoteParentRevisionIds: readonly string[];
  }): Promise<boolean>;
}

export interface VaultApplyAdapterOptions {
  readonly history?: RevisionHistory;
  readonly files: VaultFilePort;
  readonly conflictFolder: string;
  readonly resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
  /** The runtime's SHA-256 helper (no new crypto), so hashes match on-disk reads. */
  readonly hashContent: (content: string) => Promise<string>;
  /**
   * Called once per remote revision actually written or deleted on disk (the
   * 'applied' outcome only, never 'noop' or 'conflict'), so the Activity feed can
   * record a remote-attributed entry. Note contents are never passed.
   */
  readonly onRemoteApplied?: (event: RemoteAppliedEvent) => void;
  /** The re-entrancy guard, see {@link RemoteApplyProducerSync}. Optional in tests. */
  readonly producerSync?: RemoteApplyProducerSync;
  /** Readable conflict-copy naming (MRG-02). Sensible defaults when omitted. */
  readonly conflictNaming?: ConflictNaming;
  /**
   * Per-file lock serialising remote apply against the LOCAL change producer
   * (observer → hash → enqueue), so a local write cannot land and be clobbered
   * between apply's read and write (the rule-3 TOCTOU window). Production shares
   * ONE {@link KeyedMutex} with it, keyed by the canonical collision key.
   */
  readonly lock?: KeyedLock;
  /**
   * Fired once per genuinely NEW conflict copy (MRG-05), never on a re-delivery
   * reusing its copy path, so it can schedule an auto-repair sweep without a
   * copy write re-triggering itself.
   */
  readonly onConflictWritten?: () => void;
}

/** A note's text, or an attachment's raw bytes (F9). */
type Content = string | Uint8Array;

export class VaultApplyAdapter implements VaultApplyPort {
  private readonly files: VaultFilePort;
  private readonly conflictFolder: string;
  private readonly resolveRevision: (
    event: RemoteEvent,
  ) => Promise<DecodedRevisionPayload>;
  private readonly hashContent: (content: string) => Promise<string>;
  private readonly onRemoteApplied?: (event: RemoteAppliedEvent) => void;
  private readonly producerSync?: RemoteApplyProducerSync;
  private readonly now: () => Date;
  private readonly resolveAuthorName?: (event: RemoteEvent) => string | undefined;
  private readonly fallbackAuthorName: string;
  private readonly onConflictWritten?: () => void;
  private readonly lock: KeyedLock;
  private readonly history: RevisionHistory | undefined;

  constructor(options: VaultApplyAdapterOptions) {
    this.history = options.history;
    this.files = options.files;
    this.conflictFolder = options.conflictFolder;
    this.resolveRevision = options.resolveRevision;
    this.hashContent = options.hashContent;
    if (options.onRemoteApplied !== undefined) {
      this.onRemoteApplied = options.onRemoteApplied;
    }
    if (options.producerSync !== undefined) {
      this.producerSync = options.producerSync;
    }
    this.now = options.conflictNaming?.now ?? (() => new Date());
    if (options.conflictNaming?.resolveAuthorName !== undefined) {
      this.resolveAuthorName = options.conflictNaming.resolveAuthorName;
    }
    this.fallbackAuthorName =
      options.conflictNaming?.fallbackAuthorName ?? 'peer';
    if (options.onConflictWritten !== undefined) {
      this.onConflictWritten = options.onConflictWritten;
    }
    this.lock = options.lock ?? new KeyedMutex();
  }

  async openBuffers(fileId: string): Promise<readonly OpenBuffer[]> {
    return this.files.openBufferStates(fileId);
  }

  /** Lock key: the canonical collision key, shared with the local producer's lock. */
  private lockKey(path: string): string {
    const classified = classifyVaultPath(path);
    return classified.eligible ? classified.collisionKey : path;
  }

  async applyRemote(
    event: RemoteEvent,
    options?: RemoteApplyOptions,
  ): Promise<RemoteApplyOutcome> {
    const fileId = event.revision.fileId;
    // P2: in the initial catch-up, skip an obsolete intermediate revision of a
    // file this device never had before downloading it (re-checked under the lock).
    if (this.history !== undefined && options?.bootstrap === true) {
      await this.history.ensureEvent(event);
      if ((await this.producerSync?.localHeadFor?.(fileId)) == null) {
        const heads = await this.history.heads(fileId);
        if (!heads.some((head) => head.revision.revisionId === event.revision.revisionId)) return 'noop';
      }
    }
    const decoded = await this.resolveRevision(event);
    await this.history?.ensureEvent(event);
    const origin: RemoteAppliedOrigin =
      options?.bootstrap === true ? 'bootstrap' : 'live';
    // Hold the per-file lock across the WHOLE read→decide→write (rule 3): the
    // local producer cannot enqueue a concurrent edit mid-apply.
    return withKeys(this.lock, [this.lockKey(decoded.path), ...(decoded.previousPath === null ? [] : [this.lockKey(decoded.previousPath)])], async () => {
      // Fetching the blob and waiting for the file lock may take seconds.
      // Check live editors again after both, not only at the runner entry.
      if ((await this.openBuffers(fileId)).some((buffer) => buffer.unsaved)) return 'deferred';
      const localHead = await this.producerSync?.localHeadFor?.(fileId);
      if (this.history !== undefined && options?.bootstrap === true && localHead == null) {
        const heads = await this.history.heads(fileId);
        if (!heads.some((head) => head.revision.revisionId === event.revision.revisionId)) return 'noop';
      }
      if (this.history !== undefined && localHead != null) {
        const graph = await this.history.graph(fileId);
        if (ancestors(graph, localHead).has(event.revision.revisionId)) return 'noop';
      }
      const rollback = await this.producerSync?.checkpointApply?.(fileId,
        [decoded.path, ...(decoded.previousPath === null ? [] : [decoded.previousPath])]);
      try {
        const result = await this.applyDecoded(event, decoded, fileId, origin);
        if ((result === 'applied' || result === 'noop') && decoded.operation === 'rename' &&
          decoded.previousPath !== null && decoded.previousPath !== decoded.path &&
          this.files.fileIdAtPath(decoded.previousPath) === fileId) {
          // The destination must exist successfully before removing the source.
          // A failed create or occupied parent folder must never lose the note.
          await this.files.deleteByPath(decoded.previousPath);
          await this.files.forgetPath(decoded.previousPath);
        }
        if (result === 'conflict') await rollback?.();
        else await rollback?.complete?.();
        return result;
      } catch (error) {
        await rollback?.();
        if (error instanceof ApplyDeferredError) return 'deferred';
        throw error;
      }
    });
  }

  private async applyDecoded(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
    fileId: string,
    origin: RemoteAppliedOrigin,
  ): Promise<RemoteApplyOutcome> {
    // Settings files resolve a divergence by recency: see `resolvesLastWriterWins`.
    const lastWriterWins = resolvesLastWriterWins(decoded.path);
    if (decoded.operation === 'delete') {
      if (this.files.fileIdAtPath(decoded.path) !== fileId) return 'applied';
      // Owning the path is not enough to destroy it (rule 3, P1): a file edited
      // on THIS device while closed holds an unsent change that a remote
      // tombstone must not take with no copy left (settings files are deleted
      // regardless). A tombstone is always tagged markdown, so the path decides
      // how the file is read: an attachment's bytes must be hashed as bytes.
      const target = classifyVaultPath(decoded.path);
      const onDisk = lastWriterWins ? null : await this.read(target.eligible ? target.kind : 'markdown', decoded.path);
      if (onDisk !== null && await this.holdsLocalEdit(fileId, event, onDisk)) {
        return this.writeConflict(event, decoded);
      }
      // Forget the producer mapping BEFORE the delete, so its reflected event is
      // not re-pushed as a local tombstone (re-entrancy guard).
      await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
      await this.files.deleteByPath(decoded.path);
      await this.files.forgetPath(decoded.path);
      await this.files.forgetBaseHash(fileId);
      // Forget the base CONTENT too (F3), or every remote delete leaks an entry.
      await this.files.forgetBaseContent(fileId);
      return this.reportApplied(event, decoded, origin);
    }

    // Notes and attachments (F9) share this flow: an attachment is compared and
    // hashed as RAW bytes, mapped as base64, records no base content and never
    // merges. The decisions that still differ by kind are marked where taken.
    const incoming = incomingContent(decoded);
    const text = typeof incoming === 'string' ? incoming : null;
    const incomingHash = await this.hash(incoming);
    // Adopt into the producer mapping (see `RemoteApplyProducerSync`).
    const adopt = async (): Promise<void> => {
      await this.producerSync?.onRemoteWrite({
        fileId,
        path: decoded.path,
        content: typeof incoming === 'string' ? incoming : bytesToBase64(incoming),
        contentHash: incomingHash,
        contentKind: decoded.kind ?? 'markdown',
        revisionId: event.revision.revisionId,
      });
    };
    // Both sides hold the incoming content: advance the base and adopt, no write.
    const converge = async (): Promise<'noop'> => {
      await this.files.recordApplied(fileId, decoded.path, incomingHash, text);
      await adopt();
      return 'noop';
    };

    // A rename moves the owned previous path before writing the new one. Deleting
    // the OLD path must never discard a local edit made there while closed (rule
    // 3): if it diverged from the base, route the revision to a conflict artifact.
    if (
      decoded.operation === 'rename' &&
      decoded.previousPath !== null &&
      this.files.fileIdAtPath(decoded.previousPath) === fileId
    ) {
      const previousOnDisk = await this.read(decoded.kind, decoded.previousPath);
      if (previousOnDisk !== null && !lastWriterWins &&
        await this.holdsLocalEdit(fileId, event, previousOnDisk)) {
        return this.writeConflict(event, decoded);
      }
      // Destination collision, checked BEFORE the source is destroyed (P2), so a
      // rename onto an occupied path never reports a conflict with the source
      // already gone. Identical content at the target is no collision: it is the
      // F3 adopt path, which converges in place and must still vacate the source.
      if (!lastWriterWins) {
        const destinationOnDisk = await this.read(decoded.kind, decoded.path);
        if (destinationOnDisk !== null && !contentMatches(destinationOnDisk, incoming)) {
          return this.writeConflict(event, decoded);
        }
      }
      // Move the producer mapping off the OLD path BEFORE deleting it, or the
      // reflected 'delete' reads as a LOCAL delete and wipes the renamed fileId's
      // base HASH and CONTENT (keyed by fileId), so the next edit spuriously
      // conflicts.
      await this.producerSync?.onRemoteDelete({
        fileId,
        path: decoded.previousPath,
      });
      // Source removal is deferred until the destination succeeds in applyRemote.
    }

    const onDisk = await this.read(decoded.kind, decoded.path);
    const converged = onDisk !== null && contentMatches(onDisk, incoming);
    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      // F3, content-addressed reconciliation on connect: two devices that held
      // the SAME note each minted their own fileId. Identical on-disk content is
      // the same logical file: adopt the remote fileId and seed the shared base
      // (a REMOTE convergence, the only safe moment to seed one) and converge in
      // place; the base CONTENT is a valid merge ancestor.
      if (converged && this.history !== undefined && owner < fileId &&
        (await this.history.heads(owner)).length > 0) return 'noop';
      // Different content is a real divergence: never overwrite it or claim
      // ownership, preserve both via a conflict artifact (F2). Two minted fileIds
      // share no ancestor, so no merge is tried. A SETTINGS file takes the path.
      if (!converged && !lastWriterWins) return this.writeConflict(event, decoded);
      // The path switches from the superseded fileId (`owner`) to the incoming
      // one: forget the old one's mapping/head and base FIRST, so exactly one
      // fileId owns the path. Order matters: before onRemoteWrite, whose upsert a
      // later same-collision-key forget of the old owner would otherwise undo.
      await this.producerSync?.onRemoteDelete({ fileId: owner, path: decoded.path });
      await this.files.forgetBaseHash(owner);
      // Differs by kind: an attachment adopted by identical bytes keeps the old
      // owner's base content (attachments record none).
      if (!converged || decoded.kind !== 'binary') await this.files.forgetBaseContent(owner);
      // A later LOCAL edit must push under the adopted shared fileId.
      if (converged) return converge();
    }

    // On-disk overwrite guard (rule 3): the runner's guard only sees editor
    // buffers, but a file edited on THIS device while closed holds on-disk
    // content the peer must not clobber. Compared with the base:
    //  - no file (remote-only create): write it;
    //  - equals the incoming content: converged, advance the base, no write;
    //  - equals the base: no local divergence, write;
    //  - differs from BOTH (a null base counts, we cannot prove the file clean):
    //    a concurrent divergence. Try a three-way merge first (MRG-01,
    //    `tryMergeApply`); only an overlapping change becomes a conflict copy.
    const onDiskHash = onDisk === null ? null : await this.hash(onDisk);
    const cleanCausalHash = onDiskHash === null ? null : await this.cleanCausalHash(
      fileId, event, onDiskHash,
    );
    if (converged) return converge();
    const base = this.files.baseHashFor(fileId);
    // A divergence is on-disk drifted from the base, OR on-disk equals the base
    // but the revision is no provable causal fast-forward (the 7b22b61
    // concurrent-overwrite window): merge, else a conflict copy (rule 3). Differs
    // by kind: a note whose disk holds the version the revision was built on
    // (`cleanCausalHash`) needs neither check; an attachment is held to the
    // fast-forward.
    if (onDisk !== null && (cleanCausalHash === null || decoded.kind === 'binary') &&
      ((cleanCausalHash === null && onDiskHash !== base) ||
        !(await this.isCausalFastForward(fileId, event)))) {
      const merged = await this.tryMergeApply(event, decoded, onDisk, base, origin);
      if (merged !== null) return merged;
      // A settings file has no conflict copy: the later revision wins, so write it.
      if (!lastWriterWins) return this.writeConflict(event, decoded);
    }

    // Adopt BEFORE the write, so the producer dedupes the write's own event.
    await adopt();
    // TOCTOU close (rule 3): re-read the on-disk content right before the write.
    // The first read was several awaits ago, and an external editor save (which
    // the per-file lock does not keep out) may have landed since. If the disk now
    // diverges from the base, roll back the adoption and merge, or preserve both
    // in a conflict copy. A note write passes the content read here and the port
    // re-checks it atomically; an attachment write cannot (Obsidian has no
    // atomic binary compare-and-write), so a local edit landing between this
    // read and the write is not caught.
    const preWriteOnDisk = await this.read(decoded.kind, decoded.path);
    // A settings file skips the diversion: last-writer-wins replaces whatever landed.
    if (preWriteOnDisk !== null && !lastWriterWins && !contentMatches(preWriteOnDisk, incoming)) {
      const preWriteBase = this.files.baseHashFor(fileId);
      const preWriteHash = await this.hash(preWriteOnDisk);
      if (preWriteHash !== preWriteBase && preWriteHash !== cleanCausalHash) {
        await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
        const merged = await this.tryMergeApply(event, decoded, preWriteOnDisk, preWriteBase, origin);
        return merged ?? this.writeConflict(event, decoded);
      }
    }
    try {
      await (typeof incoming === 'string'
        ? this.files.writeByPath(decoded.path, incoming, lastWriterWins ? undefined : preWriteOnDisk as string | null)
        : this.files.writeBinaryByPath(decoded.path, incoming));
    } catch (error) {
      // A file occupies an ancestor of the target path, so the parent folders
      // cannot be created: roll back the adoption and preserve the content in a
      // conflict artifact (per item: the pull cycle continues). A settings file
      // is never diverted there: config writes go through the DataAdapter, which
      // cannot raise this error, and the guard keeps a future config write path
      // throwing (retried) rather than depositing one among the conflict copies.
      if (!(error instanceof ParentFolderOccupiedError) || lastWriterWins) throw error;
      await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
      return this.writeConflict(event, decoded);
    }
    // Persist the base CONTENT too: the ancestor for a later merge (MRG-01).
    await this.files.recordApplied(fileId, decoded.path, incomingHash, text);
    return this.reportApplied(event, decoded, origin);
  }

  /** Reads `path` as note text, or as an attachment's RAW bytes (F9). */
  private read(kind: SyncContentKind | undefined, path: string): Promise<Content | null> {
    return kind === 'binary' ? this.files.readBinaryByPath(path) : this.files.readByPath(path);
  }

  /** Note text via the runtime's SHA-256 helper; attachment bytes via `hashBlob`. */
  private hash(content: Content): Promise<string> {
    return typeof content === 'string' ? this.hashContent(content) : hashBlob(content);
  }

  /**
   * Whether `onDisk` may hold a local edit the incoming revision never saw: it
   * differs from the recorded base (a null base cannot prove the file clean)
   * and is not the version that revision was built on (`cleanCausalHash`).
   */
  private async holdsLocalEdit(
    fileId: string,
    event: RemoteEvent,
    onDisk: Content,
  ): Promise<boolean> {
    const base = this.files.baseHashFor(fileId);
    const onDiskHash = await this.hash(onDisk);
    return onDiskHash !== base && await this.cleanCausalHash(fileId, event, onDiskHash) === null;
  }

  /** Reports a revision this adapter genuinely wrote or deleted on disk (FIX 1). */
  private reportApplied(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
    origin: RemoteAppliedOrigin,
  ): 'applied' {
    const { revisionId, fileId, authorMembershipId } = event.revision;
    this.onRemoteApplied?.({
      revisionId,
      fileId,
      path: decoded.path,
      operation: decoded.operation,
      origin,
      ...(authorMembershipId === undefined ? {} : { authorMembershipId }),
    });
    return 'applied';
  }

  /**
   * The common ancestor text of this device's head for `fileId` and
   * `revisionId`, from the revision history, when it is a markdown note at
   * `path`; null when there is none to trust. Also used by the conflict sweep.
   */
  async mergeAncestor(
    fileId: string,
    revisionId: string,
    path: string,
  ): Promise<string | null> {
    if (this.history === undefined) return null;
    const head = await this.producerSync?.localHeadFor?.(fileId);
    if (head == null) return null;
    const graph = await this.history.graph(fileId);
    const shared = commonAncestor(graph, head, revisionId);
    if (shared === null) return null;
    const payload = await this.history.payload(shared);
    if (payload.kind === 'binary' || payload.operation === 'delete' || payload.path !== path) return null;
    return payload.content;
  }

  /**
   * Attempts a line-level three-way merge (MRG-01) of a diverged markdown file
   * before any conflict copy. Returns `'applied'` if it merged and wrote in
   * place, or `null` when no merge is possible (an attachment (F9), no shared
   * base, ancestor missing or not matching the base hash, overlapping changes):
   * the caller then writes a conflict copy. Keep the ancestor while branches are
   * concurrent. A merged file is not an accepted remote revision: publish it
   * (with its resolved parents) BEFORE changing the disk, so the observer
   * dedupes the reflected write.
   */
  private async tryMergeApply(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
    onDisk: Content,
    base: string | null,
    origin: RemoteAppliedOrigin,
  ): Promise<RemoteApplyOutcome | null> {
    if (typeof onDisk !== 'string') return null;
    const fileId = event.revision.fileId;
    let ancestor: string | null;
    if (this.history !== undefined) {
      ancestor = await this.mergeAncestor(fileId, event.revision.revisionId, decoded.path);
    } else {
      if (base === null) return null;
      ancestor = this.files.baseContentFor(fileId);
      if (ancestor === null || (await this.hashContent(ancestor)) !== base) return null;
    }
    if (ancestor === null) return null;
    const result = mergeText(ancestor, onDisk, decoded.content ?? '');
    if (result.status !== 'merged') {
      return null;
    }
    const merged = result.text;
    const mergedHash = await this.hashContent(merged);
    if (this.producerSync?.onMergedWrite !== undefined) {
      const queued = await this.producerSync.onMergedWrite({
        fileId,
        path: decoded.path,
        content: merged,
        contentHash: mergedHash,
        remoteRevisionId: event.revision.revisionId,
        remoteParentRevisionIds: event.revision.parentRevisionIds ?? [],
      });
      if (!queued) return null;
    }

    // A merge that collapses to the current on-disk content (the remote side
    // carried no change vs the ancestor) has nothing to write or attribute to the
    // peer (F4). The publication above still records the resolved branches; keep
    // the ancestor and skip the write and the remote-applied activity entry.
    if (merged === onDisk) {
      await this.files.recordPathOwner(fileId, decoded.path);
      return 'noop';
    }
    await this.files.writeByPath(decoded.path, merged, onDisk);
    await this.files.recordPathOwner(fileId, decoded.path);
    return this.reportApplied(event, decoded, origin);
  }

  /** Server acceptance alone never proves that an offline peer saw our version. */
  private async cleanCausalHash(
    fileId: string,
    event: RemoteEvent,
    diskHash: string,
  ): Promise<string | null> {
    const local = await this.producerSync?.localVersionFor?.(fileId);
    if (local == null || diskHash !== local.contentHash) return null;
    if (event.revision.parentRevisionIds?.includes(local.revisionId) === true) return diskHash;
    if (this.history !== undefined && ancestors(await this.history.graph(fileId), event.revision.revisionId).has(local.revisionId)) return diskHash;
    return null;
  }

  /**
   * Causal apply-vs-conflict decision (rule 3): true when the revision provably
   * fast-forwards this device's head for `fileId`, or carries no
   * `parentRevisionIds` (causality cannot be evaluated, see `RemoteRevision`).
   * With parents present, true only if `producerSync.localHeadFor` yields a head
   * AND the revision descends from it; any missing piece fails SAFE (false)
   * rather than risk silently overwriting a concurrent peer edit.
   */
  private async isCausalFastForward(
    fileId: string,
    event: RemoteEvent,
  ): Promise<boolean> {
    const parents = event.revision.parentRevisionIds;
    if (parents === undefined) {
      // No parentage surfaced at all: nothing contradicts the caller's on-disk ==
      // base evidence, so keep the clean-apply path for such transports.
      return true;
    }
    const localHeadFor = this.producerSync?.localHeadFor;
    if (localHeadFor === undefined) {
      return false;
    }
    const localHead = await localHeadFor(fileId);
    if (localHead === null) {
      return false;
    }
    return parents.includes(localHead) || (this.history !== undefined &&
      ancestors(await this.history.graph(fileId), event.revision.revisionId).has(localHead));
  }

  /**
   * Writes the revision to a readable conflict copy (MRG-02). Idempotent per
   * revision: a re-delivery reuses its recorded path, so a retry never spawns a
   * fresh timestamped duplicate (the conflict-cascade guard).
   */
  private async writeConflict(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
  ): Promise<'conflict'> {
    const existing = this.files.conflictArtifactPathFor(event.revision.revisionId);
    const target = existing ?? (await this.buildConflictPath(event, decoded));
    const content = incomingContent(decoded);
    await (typeof content === 'string'
      ? this.files.writeConflictArtifact(target, content)
      : this.files.writeBinaryConflictArtifact(target, content));
    if (existing === null) {
      await this.files.recordConflictArtifactPath(
        event.revision.revisionId,
        target,
        event.revision.fileId,
      );
      // A genuinely new copy: signal the auto-repair sweep (MRG-05).
      this.onConflictWritten?.();
    }
    return 'conflict';
  }

  /**
   * Builds the conflict-copy path per the fixed naming contract, inside the
   * reserved folder: `<basename> (conflict <author> <YYYY-MM-DD HHmm>).<ext>`.
   * A name collision appends ` 2`, ` 3`, … to the note basename.
   */
  private async buildConflictPath(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
  ): Promise<string> {
    const isBinary = decoded.kind === 'binary';
    const extension = isBinary ? pathExtension(decoded.path) || 'bin' : 'md';
    const basename = noteBasename(decoded.path).slice(
      0,
      MAX_CONFLICT_BASENAME_LENGTH,
    );
    const author =
      this.resolveAuthorName?.(event) ?? this.fallbackAuthorName;
    const stamp = formatConflictTimestamp(this.now());
    const suffix = ` (conflict ${author} ${stamp})`;

    let candidate = `${this.conflictFolder}/${basename}${suffix}.${extension}`;
    let counter = 2;
    while (await this.files.conflictArtifactExists(candidate)) {
      candidate = `${this.conflictFolder}/${basename} ${counter}${suffix}.${extension}`;
      counter += 1;
    }
    return candidate;
  }
}

/** The note basename (leaf, extension stripped) used in a conflict-copy name. */
function noteBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  const leaf = slash === -1 ? path : path.slice(slash + 1);
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? leaf : leaf.slice(0, dot);
}

/** Formats a `Date` as the local-time `YYYY-MM-DD HHmm` conflict-name stamp. */
function formatConflictTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function incomingContent(decoded: DecodedRevisionPayload): Content {
  return decoded.kind === 'binary'
    ? decoded.binaryContent ?? new Uint8Array(0)
    : decoded.content ?? '';
}

/**
 * Convergence/noop equality of on-disk content and an incoming revision. Note
 * text compares CANONICAL forms (AUD-03): a formatter that only touched line
 * endings, a BOM or trailing newlines must read as "already converged", not as a
 * divergence spawning a conflict artifact. Attachment bytes compare exactly (F9).
 */
function contentMatches(onDisk: Content, incoming: Content): boolean {
  if (typeof onDisk === 'string') {
    return typeof incoming === 'string' && canonicalizeMarkdown(onDisk) === canonicalizeMarkdown(incoming);
  }
  if (typeof incoming === 'string' || onDisk.byteLength !== incoming.byteLength) return false;
  for (let index = 0; index < onDisk.byteLength; index += 1) {
    if (onDisk[index] !== incoming[index]) return false;
  }
  return true;
}
