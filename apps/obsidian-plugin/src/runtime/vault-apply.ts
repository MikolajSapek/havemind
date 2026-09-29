import { ancestors, commonAncestor, type RevisionHistory } from './revision-history';
import { ApplyDeferredError } from './apply-deferred';
/**
 * Bridges the runner's `VaultApplyPort` to the real Obsidian Vault, materializing
 * remote revisions, including files that only ever existed on the other device.
 *
 * The remote payload is decoded (`@havemind/sync-core` `decodeRevisionPayload`)
 * into an operation + canonical path + content by the injected `resolveRevision`,
 * so this adapter writes at the payload's own path. It never blindly overwrites:
 *  - a path already owned by a DIFFERENT local file is a collision → the incoming
 *    content is written to `Havemind Conflicts/` and the live file is untouched;
 *  - a delete tombstone removes a file only if that path is owned by the same
 *    fileId; otherwise it is skipped (rule 4, zero silent overwrites/deletes).
 * The runner has already ruled out overwriting a divergent OPEN buffer before it
 * calls `applyRemote`; `recordConflict` handles that separate case.
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
 * Thrown by a `VaultFilePort` create-materialization when an ancestor of the
 * target path is occupied by a FILE (not a folder), so the parent-folder
 * hierarchy cannot be created. It is a PERMANENT, per-item failure (retrying
 * will never succeed), so the apply side catches it and diverts the incoming
 * content to a conflict artifact rather than letting it bubble to the sync
 * cycle, a bubble there is misread as 'offline' and wedges the whole pull loop
 * in infinite backoff (the same class of field outage this file guards against
 * for the conflict-folder writer). A transient write error (disk full, IO)
 * still throws normally so the cycle retries it.
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
  /** Open editor buffer states for the file, or an empty list if none open. */
  openBufferStates(fileId: string): readonly OpenBuffer[] | Promise<readonly OpenBuffer[]>;
  /** The fileId of the live file currently at `path`, or null if none. */
  fileIdAtPath(path: string): string | null;
  /** The current on-disk content at `path`, or null if no file exists there. */
  readByPath(path: string): Promise<string | null>;
  /** The current on-disk RAW bytes at `path`, or null if no file exists (F9). */
  readBinaryByPath(path: string): Promise<Uint8Array | null>;
  /** Create or overwrite the live file at a vault-relative path. */
  writeByPath(path: string, content: string, expectedContent?: string | null): Promise<void>;
  /** Create or overwrite the live binary file at a vault-relative path (F9). */
  writeBinaryByPath(path: string, bytes: Uint8Array): Promise<void>;
  /** Delete the live file at a vault-relative path. */
  deleteByPath(path: string): Promise<void>;
  /** Write a conflict artifact at an explicit vault-relative path. */
  writeConflictArtifact(path: string, content: string): Promise<void>;
  /** Write a binary conflict artifact at an explicit vault-relative path (F9). */
  writeBinaryConflictArtifact(path: string, bytes: Uint8Array): Promise<void>;
  /** Durably record that `fileId` now owns `path` (for in-place updates). */
  recordPathOwner(fileId: string, path: string): Promise<void>;
  /**
   * Durably record, in one write, that `fileId` owns `path` with base `hash`
   * and, unless null, base `content` (P1).
   */
  recordApplied(
    fileId: string,
    path: string,
    hash: string,
    content: string | null,
  ): Promise<void>;
  /** Durably forget the owner of `path` (after a delete or rename move). */
  forgetPath(path: string): Promise<void>;
  /** The last synced base content hash for `fileId`, or null if none recorded. */
  baseHashFor(fileId: string): string | null;
  /** Durably forget the base content hash for `fileId` (after a delete). */
  forgetBaseHash(fileId: string): Promise<void>;
  /**
   * The exact base CONTENT for `fileId` (the merge ancestor, MRG-01), or null.
   * Markdown-only: a binary file never merges and records no base content.
   */
  baseContentFor(fileId: string): string | null;
  /** Durably forget the base content for `fileId` (after a delete). */
  forgetBaseContent(fileId: string): Promise<void>;
  /** True when a file already exists at `path` (conflict-name collision probe). */
  conflictArtifactExists(path: string): Promise<boolean>;
  /**
   * The conflict-artifact path already recorded for `revisionId`, or null. Lets a
   * re-delivered revision reuse its existing copy instead of spawning a new
   * timestamped duplicate (MRG-02 cascade guard).
   */
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

/**
 * Naming inputs for a readable conflict copy (MRG-02). Injected so the timestamp
 * is deterministic in tests and the author name can be resolved from the roster.
 */
export interface ConflictNaming {
  /** Wall clock for the `YYYY-MM-DD HHmm` stamp; defaults to `new Date()`. */
  readonly now?: () => Date;
  /**
   * Resolves the incoming revision's author to a short display name (roster
   * `displayName` when known, else a short device label). When it returns
   * undefined the fallback label is used. The revision itself carries no author
   * id in the current transport, so production wiring supplies this from what
   * the client already knows about the peer.
   */
  readonly resolveAuthorName?: (event: RemoteEvent) => string | undefined;
  /** Label used when no author can be resolved. Defaults to `'peer'`. */
  readonly fallbackAuthorName?: string;
}

/** Longest a note basename may be inside a conflict filename (keeps paths sane). */
const MAX_CONFLICT_BASENAME_LENGTH = 60;

/**
 * Whether a divergence at `path` is resolved LAST-WRITER-WINS instead of by a
 * conflict copy, true for the allowlisted `.obsidian/` settings files, false for
 * every note and vault attachment.
 *
 * USER DECISION, 2026-08-12. Rule 3 ("zero silent overwrites") is a guarantee
 * about NOTES: a divergent note is preserved in `Havemind Conflicts/` because
 * prose a person typed can never be reconstructed. A settings file is different
 * on both counts. There is nothing to reconstruct, the losing side is a value the
 * user can set again in one click, and the conflict copy was actively harmful:
 * `Havemind Conflicts/graph (conflict …).md` is not a settings file Obsidian will
 * ever read, so the copy protected nothing while the colour groups the user wanted
 * synced kept losing to the churn and never landed on the second device. So a
 * config divergence resolves by RECENCY: revisions are pulled and applied in the
 * server's total order (ascending `serverSequence`), so the last revision applied
 * for a file is the last writer, and its content wins. A local settings change
 * already sitting in the outbox is not discarded by this, it keeps its place in
 * the queue and, once the server accepts it, becomes the later writer in turn.
 *
 * Notes and attachments keep the conflict-copy behaviour byte-identical.
 */
function resolvesLastWriterWins(path: string): boolean {
  return isSyncableConfigPath(path);
}

/** Whether an applied remote revision came from the initial catch-up or a live edit. */
export type RemoteAppliedOrigin = 'bootstrap' | 'live';

/** The raw fields reported for a genuinely applied remote revision (FIX 1). */
export interface RemoteAppliedEvent {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly operation: DecodedRevisionPayload['operation'];
  /**
   * `bootstrap` when this apply is part of the one-time initial catch-up that
   * materialises a pre-existing vault onto the device (a joining device, or the
   * owner re-pulling after a data.json wipe); `live` for every remote apply after
   * that. The Activity feed collapses `bootstrap` applies to silence so the
   * bootstrap does not flood the feed with one row per pre-existing file, while
   * `live` applies still record a normal entry. Materialisation is identical
   * either way, only the Activity presentation depends on this.
   */
  readonly origin: RemoteAppliedOrigin;
  /**
   * The membership that authored the revision, relayed from the pull receipt
   * (P4). Absent when the revision carried none, in which case the Activity
   * feed records a neutral remote entry; the author is NEVER inferred here.
   */
  readonly authorMembershipId?: string;
}

/**
 * Keeps the push producer's fileId↔path↔content map in lockstep with what the
 * apply side writes to the vault. Without it, the vault event a remote-apply
 * write triggers is re-observed by the producer and (a) re-pushed as a fresh
 * local revision, (b) recorded as LOCAL activity, and (c), for a remote-only
 * create, given a brand-new random fileId (a duplicate fileId across devices).
 * Adopting the incoming fileId + content into the producer mapping BEFORE the
 * write dedupes that reflected event to a no-op.
 */
export interface RemoteApplyProducerSync {
  checkpointApply?(fileId: string, paths: readonly string[]): Promise<(() => Promise<void>) & { complete?: () => Promise<void> }>;
  /** Adopt `fileId`/`content` for `path`, parenting future local edits on
   * `revisionId`. `contentHash` is the SHA-256 hex of the note text for
   * markdown, or the raw-byte hash for a binary attachment. `contentKind`
   * carries the decoded payload's kind so the adopted producer mapping keeps
   * the binary/markdown discriminator, without it a RECEIVED binary would be
   * persisted as markdown and later corrupted by the canonicalization rebase.
   * Absent means markdown (legacy callers unchanged). */
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
   * This device's current head revisionId for `fileId` (the last revision it
   * authored or adopted), or null if none is known. Read by the apply-vs-conflict
   * decision to tell a causal fast-forward (the incoming revision descends from
   * our head → the peer had our version) from a concurrent divergence (never a
   * silent overwrite, rule 3). Optional so unit tests that don't exercise the
   * causal path can omit it.
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
  /**
   * Content-addressed hash over the note text. Reuses the runtime's existing
   * SHA-256 helper (no new crypto) so the on-disk base hash it records is
   * comparable to a later on-disk read of the same content.
   */
  readonly hashContent: (content: string) => Promise<string>;
  /**
   * Called once per remote revision this adapter actually wrote or deleted on
   * disk, the 'applied' outcome only. Never called for 'noop' (already
   * converged, nothing written) or 'conflict' (diverted to a conflict
   * artifact, the live file untouched). Lets the Activity feed record a
   * remote-attributed entry without this adapter knowing anything about
   * Activity; note contents are never passed.
   */
  readonly onRemoteApplied?: (event: RemoteAppliedEvent) => void;
  /**
   * Bridges every remote-apply vault write into the push producer's durable
   * mapping so the reflected vault event is never re-pushed, re-attributed, or
   * given a fresh fileId (the re-entrancy guard). Optional; unit tests that only
   * exercise the vault side omit it.
   */
  readonly producerSync?: RemoteApplyProducerSync;
  /** Readable conflict-copy naming (MRG-02). Sensible defaults when omitted. */
  readonly conflictNaming?: ConflictNaming;
  /**
   * Per-file async lock serialising remote apply against the LOCAL change
   * producer (the vault observer → hash → outbox enqueue) for the SAME file, so
   * a local write can never land and be clobbered between apply's on-disk read
   * and its write (the rule-3 TOCTOU window). Production wiring passes the SAME
   * {@link KeyedMutex} instance to both this adapter and the producer, keyed by
   * the file's canonical collision key. Omitted in unit tests → a private
   * instance is created so concurrent applies to one file still serialise.
   */
  readonly lock?: KeyedLock;
  /**
   * Fired once each time a genuinely NEW conflict copy is written to the reserved
   * folder (MRG-05). Never fired when a re-delivered revision reuses its existing
   * copy path (the cascade guard), so it can safely schedule an auto-repair sweep
   * without a copy write re-triggering itself. Optional; unit tests omit it.
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

  /**
   * The per-file lock key: the file's canonical collision key, so remote apply
   * and the local producer (which keys on the same collision key) share ONE
   * critical section per file. Falls back to the raw path for a non-syncable
   * path (never reached in practice, apply only sees syncable revisions).
   */
  private lockKey(path: string): string {
    const classified = classifyVaultPath(path);
    return classified.eligible ? classified.collisionKey : path;
  }

  async applyRemote(
    event: RemoteEvent,
    options?: RemoteApplyOptions,
  ): Promise<RemoteApplyOutcome> {
    const fileId = event.revision.fileId;
    // P2: an obsolete intermediate revision of a file this device never had
    // is skipped during the initial catch-up; decide that before downloading
    // its payload. The same check runs again under the file lock below.
    if (this.history !== undefined && options?.bootstrap === true) {
      await this.history.ensureEvent(event);
      if ((await this.producerSync?.localHeadFor?.(fileId)) == null) {
        const heads = await this.history.heads(fileId);
        if (!heads.some((head) => head.revision.revisionId === event.revision.revisionId)) return 'noop';
      }
    }
    const decoded = await this.resolveRevision(event);
    await this.history?.ensureEvent(event);
    // The runner flags an apply from the initial catch-up so the Activity feed can
    // stay quiet for the bootstrap replay; every other apply is a live peer edit.
    const origin: RemoteAppliedOrigin =
      options?.bootstrap === true ? 'bootstrap' : 'live';
    // Hold the per-file lock across the WHOLE read→decide→write so the local
    // producer cannot observe+enqueue a concurrent edit to this file mid-apply
    // (rule 3). Distinct files keep syncing in parallel (no global lock).
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
    // An allowlisted `.obsidian/` settings file resolves a divergence by recency
    // rather than by a conflict copy (see `resolvesLastWriterWins`). Every guard
    // below is unchanged for notes and attachments; for a settings file the
    // diversion is skipped and the incoming (later) revision is written.
    const lastWriterWins = resolvesLastWriterWins(decoded.path);
    if (decoded.operation === 'delete') {
      // Only remove a file this revision actually owns.
      if (this.files.fileIdAtPath(decoded.path) !== fileId) return 'applied';
      // Owning the path is not enough to destroy it (rule 3, P1). A file
      // edited on THIS device while closed holds an unsent local change; a
      // remote tombstone must not take it with no copy left behind. Same
      // shape as the rename source check below. An allowlisted `.obsidian/`
      // settings file keeps resolving by recency and is deleted regardless.
      // A tombstone is always tagged markdown, so the path decides how the
      // file is read: an attachment's bytes must be hashed as bytes.
      const target = classifyVaultPath(decoded.path);
      const onDisk = lastWriterWins ? null : await this.read(target.eligible ? target.kind : 'markdown', decoded.path);
      if (onDisk !== null && await this.holdsLocalEdit(fileId, event, onDisk)) {
        return this.writeConflict(event, decoded);
      }
      // Forget the producer mapping BEFORE the delete so the reflected vault
      // 'delete' event finds no mapping and is not re-pushed as a local
      // tombstone (re-entrancy guard).
      await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
      await this.files.deleteByPath(decoded.path);
      await this.files.forgetPath(decoded.path);
      await this.files.forgetBaseHash(fileId);
      // Forget the base CONTENT too (F3): the local-delete path already does
      // this (`forgetLocalMaterialization`); omitting it here leaked one
      // baseContents entry per remote delete, growing data.json unbounded.
      await this.files.forgetBaseContent(fileId);
      return this.reportApplied(event, decoded, origin);
    }

    // Notes and binary attachments (F9) share this flow. Reading, comparing,
    // hashing and writing follow the content kind: an attachment is compared
    // and hashed as RAW bytes (never `canonicalizeMarkdown`, which is
    // markdown-only), is mapped as base64 (the form the observer stores),
    // records no base content and never merges. The two decisions that still
    // differ by kind are marked where they are taken.
    const incoming = incomingContent(decoded);
    const text = typeof incoming === 'string' ? incoming : null;
    const incomingHash = await this.hash(incoming);
    // Adopting the incoming fileId+content into the producer mapping keeps it in
    // lockstep with the vault: the event a write triggers is deduped (content
    // already matches) instead of being re-pushed, re-attributed to the local
    // member, or given a fresh random fileId.
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
    // Both sides already hold the incoming content: advance the base and adopt
    // it, skipping the write entirely (never a destructive rewrite).
    const converge = async (): Promise<'noop'> => {
      await this.files.recordApplied(fileId, decoded.path, incomingHash, text);
      await adopt();
      return 'noop';
    };

    // A rename moves the owned previous path before writing the new one. The
    // base hash is keyed by fileId, so it survives the move unchanged. But the
    // delete of the OLD path must never silently discard a local edit made
    // there while closed (rule 3): if the old path's on-disk content has
    // diverged from the recorded base, route the incoming revision to a conflict
    // artifact instead of deleting.
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
      // Destination collision, checked BEFORE the source is destroyed (P2).
      // Ownership of the TARGET used to be read only after this delete, so a
      // rename onto a path held by another fileId reported a conflict with the
      // source already gone: the content survived only as a conflict copy and
      // the user's original file had vanished from where they left it. The
      // divergence check above protects the SOURCE; this one protects against
      // moving into an occupied destination at all. Identical content at the
      // target is not a collision, it is the F3 adopt path, which converges in
      // place below and must still vacate the source.
      if (!lastWriterWins) {
        const destinationOnDisk = await this.read(decoded.kind, decoded.path);
        if (destinationOnDisk !== null && !contentMatches(destinationOnDisk, incoming)) {
          return this.writeConflict(event, decoded);
        }
      }
      // Move the producer mapping off the OLD path BEFORE deleting it, exactly as
      // the top-level delete branch does. The delete of the vacated path fires a
      // reflected vault 'delete' event; if the producer still mapped the old path
      // to this fileId, that event is observed as a genuine LOCAL delete, whose
      // `forgetLocalMaterialization` wipes the base HASH and CONTENT for the
      // still-live renamed fileId (keyed by fileId, not path). The merge ancestor
      // then vanishes and the next edit round on the renamed file spuriously
      // conflicts (the base advances only on remote apply, nothing re-seeds it).
      // Whether that forget lands before or after this apply's own base re-record
      // is pure microtask timing, so the corruption surfaced only under load. The
      // write path below re-adopts the mapping at the new path via onRemoteWrite.
      await this.producerSync?.onRemoteDelete({
        fileId,
        path: decoded.previousPath,
      });
      // Source removal is deferred until the destination succeeds in applyRemote.
    }

    // Read the on-disk content once; both the F3 adoption check below and the
    // rule-3 overwrite guard consume it.
    const onDisk = await this.read(decoded.kind, decoded.path);
    const converged = onDisk !== null && contentMatches(onDisk, incoming);
    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      // Content-addressed reconciliation on connect (F3). Two devices that
      // already held the SAME note each minted an independent random fileId for
      // it, so the incoming revision's canonical path is "owned" by a fileId that
      // is not this revision's. If the on-disk content is identical to the
      // incoming revision it is genuinely the same logical file: adopt the remote
      // fileId for this path and seed the shared base (a REMOTE convergence, the
      // only safe moment to seed a base, never on a local push). Both peers
      // already hold the content, so this converges in place with no write and no
      // conflict artifact. The seeded base CONTENT is a valid three-way merge
      // ancestor, so the next concurrent edit can merge instead of conflicting.
      if (converged && this.history !== undefined && owner < fileId &&
        (await this.history.heads(owner)).length > 0) return 'noop';
      // Different content is a real divergence. Never overwrite it and never
      // claim ownership: preserve both via a conflict artifact (the F2 conflict
      // path). No shared ancestor exists across two independently-minted
      // fileIds, so a three-way merge is not attempted here. A SETTINGS file
      // instead resolves by recency: the incoming revision is the later writer,
      // so it takes the path over and falls through to the ordinary write.
      if (!converged && !lastWriterWins) return this.writeConflict(event, decoded);
      // The path is switching from the superseded fileId (`owner`) to the
      // incoming one. Forget the superseded fileId's state FIRST, its producer
      // mapping/head (keyed by fileId, not path) and its apply-side base hash and
      // content, so exactly one fileId ends up owning this path and no orphaned
      // heads[owner]/baseHashes[owner] survives the adopt. Order matters: this
      // must run before onRemoteWrite, since that call's own upsert would
      // otherwise be undone by a later same-collision-key forget targeting the
      // old owner.
      await this.producerSync?.onRemoteDelete({ fileId: owner, path: decoded.path });
      await this.files.forgetBaseHash(owner);
      // Differs by kind: an attachment adopted by identical bytes keeps the old
      // owner's base content (attachments record none), as the former separate
      // binary flow did.
      if (!converged || decoded.kind !== 'binary') await this.files.forgetBaseContent(owner);
      // A later LOCAL edit must push under the adopted shared fileId, never the
      // old random one this device minted for the same file.
      if (converged) return converge();
    }

    // On-disk overwrite guard (rule 3, zero silent overwrites). The runner's
    // open-buffer guard only sees editor buffers; a file edited on THIS device
    // while closed still has divergent on-disk content the peer must not clobber.
    // Compare the current on-disk content against the last synced base:
    //  - no file on disk (remote-only create) → nothing to protect, write it;
    //  - on-disk already equals the incoming content → converged, advance base
    //    with no write (never a destructive rewrite);
    //  - on-disk equals the recorded base → no local divergence, safe to write;
    //  - on-disk differs from BOTH the base and the incoming content → a genuine
    //    concurrent divergence: divert to a conflict artifact so both survive.
    //    (A null base with divergent on-disk content is treated the same way,
    //    we cannot prove the local file is clean, so we never overwrite it.)
    // This is the on-disk analogue of the open-buffer check. Before falling back
    // to a conflict copy, an on-disk divergence FIRST attempts a line-level
    // three-way merge (MRG-01, `tryMergeApply`): non-overlapping edits are
    // combined in place and only a genuinely overlapping change becomes a
    // conflict copy.
    const onDiskHash = onDisk === null ? null : await this.hash(onDisk);
    const cleanCausalHash = onDiskHash === null ? null : await this.cleanCausalHash(
      fileId, event, onDiskHash,
    );
    if (converged) return converge();
    const base = this.files.baseHashFor(fileId);
    // A divergence is either: on-disk drifted from the shared base, OR on-disk
    // still equals the base but the incoming revision is not a provable causal
    // fast-forward (the 7b22b61 concurrent-overwrite window). Both cases take
    // the same path: try to merge, else preserve both in a conflict copy,
    // never a silent overwrite (rule 3). Differs by kind: a note whose disk holds
    // exactly the version the revision was built on (`cleanCausalHash`) needs
    // neither check, while an attachment is still held to the fast-forward, as
    // the former separate binary flow was.
    if (onDisk !== null && (cleanCausalHash === null || decoded.kind === 'binary') &&
      ((cleanCausalHash === null && onDiskHash !== base) ||
        !(await this.isCausalFastForward(fileId, event)))) {
      const merged = await this.tryMergeApply(event, decoded, onDisk, base, origin);
      if (merged !== null) return merged;
      // A settings file has no conflict copy: the incoming revision is the
      // later writer, so fall through to the write below and let it win.
      if (!lastWriterWins) return this.writeConflict(event, decoded);
    }

    // Adopt BEFORE the vault write, so the 'modify'/'create' event that write
    // triggers is deduped by the producer (see `adopt`).
    await adopt();
    // TOCTOU close (rule 3): re-read the file's CURRENT on-disk content
    // immediately before the write. The first read above happened
    // several awaits ago; a local edit to the (closed) file could have landed on
    // disk since, the shared per-file lock keeps OUR producer out, but an
    // external editor save is only caught here. If the disk now diverges from
    // the recorded base, this is a genuine concurrent edit: roll back the
    // pre-write producer adoption and merge (or preserve both in a conflict
    // copy) instead of clobbering it. No `await` separates this read from the
    // write below, so nothing can interleave between them.
    const preWriteOnDisk = await this.read(decoded.kind, decoded.path);
    // A settings file skips the diversion entirely (last-writer-wins): the write
    // below replaces the semantic content whatever landed since the first read.
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
      // A file occupies an ancestor of the target path, so the parent-folder
      // hierarchy cannot be created. Roll back the pre-write producer adoption
      // and preserve the incoming content in a conflict artifact (an attachment
      // keeps its extension). Per-item: this single revision is diverted and the
      // pull cycle continues to the next event, never a cycle-killing throw.
      // A settings file never lands in the conflict folder, so it is not
      // diverted here either. Config writes go through the DataAdapter, which
      // tolerates an existing directory and cannot raise this error at all, the
      // guard is kept so that a future config write path can only ever throw
      // (and be retried), never quietly deposit a settings file among the
      // conflict copies.
      if (!(error instanceof ParentFolderOccupiedError) || lastWriterWins) throw error;
      await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
      return this.writeConflict(event, decoded);
    }
    // Persist the base CONTENT too so a later divergence has the ancestor the
    // three-way merge needs (MRG-01).
    await this.files.recordApplied(fileId, decoded.path, incomingHash, text);
    return this.reportApplied(event, decoded, origin);
  }

  /** Reads `path` as note text, or as an attachment's RAW bytes (F9). */
  private read(kind: SyncContentKind | undefined, path: string): Promise<Content | null> {
    return kind === 'binary' ? this.files.readBinaryByPath(path) : this.files.readByPath(path);
  }

  /** Note text through the runtime's SHA-256 helper; an attachment's raw bytes through `hashBlob`. */
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
   * before any conflict copy. Returns `'applied'` when it merged and wrote the
   * combined content in place, or `null` when no merge is possible (an
   * attachment, which never merges (F9), no shared base, the ancestor text is
   * not locally persisted, the stored ancestor no longer matches the base hash,
   * or the changes overlap), the caller then writes a conflict copy.
   *
   * Keep the ancestor while branches are concurrent. A merged file is not an
   * accepted remote revision: publish it explicitly, with its resolved parents,
   * before changing the disk. The observer then deduplicates the reflected write.
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

    // When the merge collapses to exactly the current on-disk content (e.g. the
    // remote side carried no change relative to the ancestor), there is nothing
    // new to write and nothing to attribute to the peer (F4). The explicit
    // publication above still records the resolved branches; keep the ancestor
    // and skip the redundant write and remote-applied activity entry.
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
   * Causal apply-vs-conflict decision (rule 3): true when the incoming
   * revision is either provably a fast-forward from this device's current
   * head for `fileId`, or when causality simply cannot be evaluated because
   * the incoming revision carries no `parentRevisionIds` at all (a transport
   * that does not yet surface causal parentage, see `RemoteRevision`).
   *
   * When `parentRevisionIds` IS present, this only returns true if a
   * `producerSync` is wired with `localHeadFor`, that lookup resolves to a
   * known (non-null) local head, AND the incoming revision's parents include
   * it, i.e. the peer built its revision directly on top of (or through)
   * what we last knew. Any missing piece there means causality cannot be
   * established, so this fails SAFE (false) rather than risk a silent
   * overwrite of a concurrent peer edit.
   */
  private async isCausalFastForward(
    fileId: string,
    event: RemoteEvent,
  ): Promise<boolean> {
    const parents = event.revision.parentRevisionIds;
    if (parents === undefined) {
      // Best-effort: no causal parentage was surfaced for this revision at
      // all, so there is nothing to contradict the on-disk == base evidence
      // already gathered by the caller. This preserves the pre-existing
      // clean-apply path for transports that do not (yet) carry parentage.
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
   * The runner's separate open-BUFFER divergence path: the incoming revision is
   * preserved as a conflict copy without touching the live file. Unreachable for
   * an allowlisted `.obsidian/` settings file, which is why it needs no
   * last-writer-wins branch, Obsidian never opens a hidden config file as an
   * editor buffer, so `openBuffers` can never report one for a config fileId.
   */
  async recordConflict(event: RemoteEvent): Promise<void> {
    const decoded = await this.resolveRevision(event);
    await this.writeConflict(event, decoded);
  }

  /**
   * Writes the incoming revision to a readable conflict copy (MRG-02) under the
   * reserved folder, preserving both sides. Idempotent per revision: a
   * re-delivered revision reuses the path already recorded for it, so a retry can
   * never spawn a fresh timestamped duplicate (the conflict-cascade guard).
   * Markdown and binary are handled uniformly via the decoded payload's kind.
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
      // A genuinely new copy landed: signal the auto-repair sweep (MRG-05). A
      // re-delivered revision reuses `existing` and never reaches here, so the
      // sweep is never re-triggered by an idempotent rewrite of the same copy.
      this.onConflictWritten?.();
    }
    return 'conflict';
  }

  /**
   * Builds the readable conflict-copy path per the fixed naming contract:
   * `<basename> (conflict <author> <YYYY-MM-DD HHmm>).<ext>` inside the reserved
   * folder. Binary copies keep the source extension; markdown copies use `md`.
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

/** The revision's content: note text, or an attachment's raw bytes (F9). */
function incomingContent(decoded: DecodedRevisionPayload): Content {
  return decoded.kind === 'binary'
    ? decoded.binaryContent ?? new Uint8Array(0)
    : decoded.content ?? '';
}

/**
 * Convergence/noop equality between on-disk content and an incoming revision.
 * Note text compares the CANONICAL forms (AUD-03): a formatter that only
 * touched line endings, a BOM or trailing newlines after Havemind's last apply
 * must read as "already converged" here, not as a divergence that spawns a
 * conflict artifact or a spurious overwrite. Byte-exact disk content is
 * untouched either way. Attachment bytes compare byte-for-byte (F9).
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
