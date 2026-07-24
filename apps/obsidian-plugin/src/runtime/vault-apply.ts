/**
 * Bridges the runner's `VaultApplyPort` to the real Obsidian Vault, materializing
 * remote revisions — including files that only ever existed on the other device.
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

import { canonicalizeMarkdown, hashBlob } from '@havemind/protocol';
import { mergeText, type DecodedRevisionPayload } from '@havemind/sync-core';

import {
  bytesToBase64,
  pathExtension,
  type SyncContentKind,
} from '../obsidian/vault-adapter';

import type {
  OpenBuffer,
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
 * cycle — a bubble there is misread as 'offline' and wedges the whole pull loop
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
  openBufferStates(fileId: string): readonly OpenBuffer[];
  /** The fileId of the live file currently at `path`, or null if none. */
  fileIdAtPath(path: string): string | null;
  /** The current on-disk content at `path`, or null if no file exists there. */
  readByPath(path: string): Promise<string | null>;
  /** The current on-disk RAW bytes at `path`, or null if no file exists (F9). */
  readBinaryByPath(path: string): Promise<Uint8Array | null>;
  /** Create or overwrite the live file at a vault-relative path. */
  writeByPath(path: string, content: string): Promise<void>;
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
  /** Durably forget the owner of `path` (after a delete or rename move). */
  forgetPath(path: string): Promise<void>;
  /** The last synced base content hash for `fileId`, or null if none recorded. */
  baseHashFor(fileId: string): string | null;
  /** Durably record the last synced base content hash for `fileId`. */
  recordBaseHash(fileId: string, hash: string): Promise<void>;
  /** Durably forget the base content hash for `fileId` (after a delete). */
  forgetBaseHash(fileId: string): Promise<void>;
  /**
   * The exact base CONTENT for `fileId` (the merge ancestor, MRG-01), or null.
   * Markdown-only: a binary file never merges and records no base content.
   */
  baseContentFor(fileId: string): string | null;
  /** Durably record the base CONTENT for `fileId` (paired with the base hash). */
  recordBaseContent(fileId: string, content: string): Promise<void>;
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
  /** Durably record the conflict-artifact path chosen for `revisionId`. */
  recordConflictArtifactPath(revisionId: string, path: string): Promise<void>;
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

/** The raw fields reported for a genuinely applied remote revision (FIX 1). */
export interface RemoteAppliedEvent {
  readonly revisionId: string;
  readonly fileId: string;
  readonly path: string;
  readonly operation: DecodedRevisionPayload['operation'];
}

/**
 * Keeps the push producer's fileId↔path↔content map in lockstep with what the
 * apply side writes to the vault. Without it, the vault event a remote-apply
 * write triggers is re-observed by the producer and (a) re-pushed as a fresh
 * local revision, (b) recorded as LOCAL activity, and (c) — for a remote-only
 * create — given a brand-new random fileId (a duplicate fileId across devices).
 * Adopting the incoming fileId + content into the producer mapping BEFORE the
 * write dedupes that reflected event to a no-op.
 */
export interface RemoteApplyProducerSync {
  /** Adopt `fileId`/`content` for `path`, parenting future local edits on
   * `revisionId`. `contentHash` is the SHA-256 hex of the note text for
   * markdown, or the raw-byte hash for a binary attachment. `contentKind`
   * carries the decoded payload's kind so the adopted producer mapping keeps
   * the binary/markdown discriminator — without it a RECEIVED binary would be
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
   * silent overwrite — rule 3). Optional so unit tests that don't exercise the
   * causal path can omit it.
   */
  localHeadFor?(fileId: string): Promise<string | null>;
}

export interface VaultApplyAdapterOptions {
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
   * disk — the 'applied' outcome only. Never called for 'noop' (already
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
   * Fired once each time a genuinely NEW conflict copy is written to the reserved
   * folder (MRG-05). Never fired when a re-delivered revision reuses its existing
   * copy path (the cascade guard), so it can safely schedule an auto-repair sweep
   * without a copy write re-triggering itself. Optional; unit tests omit it.
   */
  readonly onConflictWritten?: () => void;
}

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

  constructor(options: VaultApplyAdapterOptions) {
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
  }

  async openBuffers(fileId: string): Promise<readonly OpenBuffer[]> {
    return this.files.openBufferStates(fileId);
  }

  async applyRemote(event: RemoteEvent): Promise<RemoteApplyOutcome> {
    const decoded = await this.resolveRevision(event);
    const fileId = event.revision.fileId;

    if (decoded.operation === 'delete') {
      // Only remove a file this revision actually owns.
      if (this.files.fileIdAtPath(decoded.path) === fileId) {
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
        this.onRemoteApplied?.({
          revisionId: event.revision.revisionId,
          fileId,
          path: decoded.path,
          operation: decoded.operation,
        });
      }
      return 'applied';
    }

    // Binary attachments (F9) are whole-file byte replaces: a separate path that
    // compares/hashes RAW bytes (never `canonicalizeMarkdown`, which is
    // markdown-only) and writes through the byte vault API. It preserves every
    // data-safety invariant of the markdown path below — divergent on-disk bytes
    // become a conflict artifact (with the original extension), never an
    // overwrite; the base advances only on a clean apply or convergence.
    if (decoded.kind === 'binary') {
      return this.applyRemoteBinary(event, decoded, fileId);
    }

    const text = decoded.content ?? '';

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
      const previousOnDisk = await this.files.readByPath(decoded.previousPath);
      if (previousOnDisk !== null) {
        const base = this.files.baseHashFor(fileId);
        const previousHash = await this.hashContent(previousOnDisk);
        if (base === null || previousHash !== base) {
          await this.writeConflict(event, decoded);
          return 'conflict';
        }
      }
      // Move the producer mapping off the OLD path BEFORE deleting it, exactly as
      // the top-level delete branch does. The delete of the vacated path fires a
      // reflected vault 'delete' event; if the producer still mapped the old path
      // to this fileId, that event is observed as a genuine LOCAL delete, whose
      // `forgetLocalMaterialization` wipes the base HASH and CONTENT for the
      // still-live renamed fileId (keyed by fileId, not path). The merge ancestor
      // then vanishes and the next edit round on the renamed file spuriously
      // conflicts (the base advances only on remote apply — nothing re-seeds it).
      // Whether that forget lands before or after this apply's own base re-record
      // is pure microtask timing, so the corruption surfaced only under load. The
      // write path below re-adopts the mapping at the new path via onRemoteWrite.
      await this.producerSync?.onRemoteDelete({
        fileId,
        path: decoded.previousPath,
      });
      await this.files.deleteByPath(decoded.previousPath);
      await this.files.forgetPath(decoded.previousPath);
    }

    // Read the on-disk content once; both the F3 adoption check below and the
    // rule-3 overwrite guard consume it.
    const onDisk = await this.files.readByPath(decoded.path);

    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      // Content-addressed reconciliation on connect (F3). Two devices that
      // already held the SAME note each minted an independent random fileId for
      // it, so the incoming revision's canonical path is "owned" by a fileId that
      // is not this revision's. If the on-disk content is byte-identical to the
      // incoming revision it is genuinely the same logical file: adopt the remote
      // fileId for this path and seed the shared base (a REMOTE convergence, the
      // only safe moment to seed a base — never on a local push). Both peers
      // already hold the content, so this converges in place with no write and no
      // conflict artifact.
      if (onDisk !== null && contentMatches(onDisk, text)) {
        const contentHash = await this.hashContent(text);
        // The path is switching from the superseded local fileId (`owner`) to
        // the incoming remote fileId. Forget the superseded fileId's state
        // FIRST — its producer mapping/head (keyed by fileId, not path) and its
        // apply-side base hash — so exactly one fileId ends up owning this path
        // and no orphaned heads[owner]/baseHashes[owner] survives the adopt.
        // Order matters: this must run before onRemoteWrite below, since that
        // call's own upsert would otherwise be undone by a later same-collision
        // -key forget targeting the old owner.
        await this.producerSync?.onRemoteDelete({ fileId: owner, path: decoded.path });
        await this.files.forgetBaseHash(owner);
        // Forget the superseded owner's base CONTENT too (F3): only its base hash
        // was being cleared, leaking one baseContents entry per adoption.
        await this.files.forgetBaseContent(owner);
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.files.recordBaseHash(fileId, contentHash);
        // Persist the base CONTENT too (not just its hash): both sides already
        // hold `text` as the adopted content, so it is a valid three-way merge
        // ancestor. Without this, `baseContentFor(fileId)` stays null after
        // adoption and the next concurrent edit falls through `tryMergeApply`
        // straight to a conflict copy even though a clean merge was possible.
        await this.files.recordBaseContent(fileId, text);
        // Adopt the remote fileId into the producer mapping too (no disk write
        // fires here, but a later LOCAL edit must push under the shared fileId,
        // never the old random one this device minted for the same note).
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: text,
          contentHash,
          contentKind: 'markdown',
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      // The path holds genuinely different content — a real divergence. Never
      // overwrite it and never claim ownership: preserve both via a conflict
      // artifact (the F2 conflict path). No shared ancestor exists across two
      // independently-minted fileIds, so a three-way merge is not attempted here.
      await this.writeConflict(event, decoded);
      return 'conflict';
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
    //    (A null base with divergent on-disk content is treated the same way —
    //    we cannot prove the local file is clean, so we never overwrite it.)
    // This is the on-disk analogue of the open-buffer check. Before falling back
    // to a conflict copy, an on-disk divergence FIRST attempts a line-level
    // three-way merge (MRG-01, `tryMergeApply`): non-overlapping edits are
    // combined in place and only a genuinely overlapping change becomes a
    // conflict copy.
    if (onDisk !== null) {
      if (contentMatches(onDisk, text)) {
        // Both sides already hold the incoming content: advance the base and
        // skip the write entirely (test: on-disk == incoming → no write).
        const contentHash = await this.hashContent(text);
        await this.files.recordBaseHash(fileId, contentHash);
        await this.files.recordBaseContent(fileId, text);
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: text,
          contentHash,
          contentKind: 'markdown',
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      const base = this.files.baseHashFor(fileId);
      const onDiskHash = await this.hashContent(onDisk);
      // A divergence is either: on-disk drifted from the shared base, OR on-disk
      // still equals the base but the incoming revision is not a provable causal
      // fast-forward (the 7b22b61 concurrent-overwrite window). Both cases take
      // the same path: try to merge, else preserve both in a conflict copy —
      // never a silent overwrite (rule 3).
      const diverged = base === null || onDiskHash !== base;
      if (diverged || !(await this.isCausalFastForward(fileId, event))) {
        const merged = await this.tryMergeApply(
          event,
          decoded,
          fileId,
          onDisk,
          text,
          base,
        );
        if (merged !== null) {
          return merged;
        }
        await this.writeConflict(event, decoded);
        return 'conflict';
      }
    }

    const contentHash = await this.hashContent(text);
    // Adopt the incoming fileId+content into the producer mapping BEFORE the
    // vault write, so the 'modify'/'create' event that write triggers is deduped
    // by the producer (content already matches) instead of being re-pushed,
    // re-attributed to the local member, or given a fresh random fileId.
    await this.producerSync?.onRemoteWrite({
      fileId,
      path: decoded.path,
      content: text,
      contentHash,
      contentKind: 'markdown',
      revisionId: event.revision.revisionId,
    });
    try {
      await this.files.writeByPath(decoded.path, text);
    } catch (error) {
      if (error instanceof ParentFolderOccupiedError) {
        // A file occupies an ancestor of the target path, so the parent-folder
        // hierarchy cannot be created. Roll back the pre-write producer
        // adoption and preserve the incoming content in a conflict artifact.
        // Per-item: this single revision is diverted and the pull cycle
        // continues to the next event — never a cycle-killing throw.
        await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
        await this.writeConflict(event, decoded);
        return 'conflict';
      }
      throw error;
    }
    await this.files.recordPathOwner(fileId, decoded.path);
    await this.files.recordBaseHash(fileId, contentHash);
    // Persist the base CONTENT too so a later divergence has the ancestor the
    // three-way merge needs (MRG-01).
    await this.files.recordBaseContent(fileId, text);
    this.onRemoteApplied?.({
      revisionId: event.revision.revisionId,
      fileId,
      path: decoded.path,
      operation: decoded.operation,
    });
    return 'applied';
  }

  /**
   * Attempts a line-level three-way merge (MRG-01) of a diverged markdown file
   * before any conflict copy. Returns `'applied'` when it merged and wrote the
   * combined content in place, or `null` when no merge is possible (no shared
   * base, the ancestor text is not locally persisted, the stored ancestor no
   * longer matches the base hash, or the changes overlap) — the caller then
   * writes a conflict copy.
   *
   * ANCESTOR is the locally-persisted base content; LOCAL is the current on-disk
   * content; REMOTE is the incoming revision. A successful merge IS a
   * convergence event, so the base advances to the merged state. The merged
   * content is deliberately NOT adopted into the producer mapping: it is a NEW
   * local revision this device authored, so letting the reflected vault write
   * flow through the normal local-edit path pushes the merged result to the peer
   * (who converges by content-equality — no ping-pong).
   */
  private async tryMergeApply(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
    fileId: string,
    onDisk: string,
    incoming: string,
    base: string | null,
  ): Promise<RemoteApplyOutcome | null> {
    if (base === null) {
      return null;
    }
    const ancestor = this.files.baseContentFor(fileId);
    if (ancestor === null) {
      return null;
    }
    // The stored ancestor must still correspond to the recorded base hash;
    // anything else is inconsistent state, so fail SAFE to a conflict copy.
    if ((await this.hashContent(ancestor)) !== base) {
      return null;
    }
    const result = mergeText(ancestor, onDisk, incoming);
    if (result.status !== 'merged') {
      return null;
    }
    const merged = result.text;
    const mergedHash = await this.hashContent(merged);
    // When the merge collapses to exactly the current on-disk content (e.g. the
    // remote side carried no change relative to the ancestor), there is nothing
    // new to write and nothing to attribute to the peer (F4). Treat it as a
    // convergence: advance the base to the merged state, but skip the redundant
    // write and the remote-applied activity entry.
    if (merged === onDisk) {
      await this.files.recordPathOwner(fileId, decoded.path);
      await this.files.recordBaseHash(fileId, mergedHash);
      await this.files.recordBaseContent(fileId, merged);
      return 'noop';
    }
    await this.files.writeByPath(decoded.path, merged);
    await this.files.recordPathOwner(fileId, decoded.path);
    await this.files.recordBaseHash(fileId, mergedHash);
    await this.files.recordBaseContent(fileId, merged);
    this.onRemoteApplied?.({
      revisionId: event.revision.revisionId,
      fileId,
      path: decoded.path,
      operation: decoded.operation,
    });
    return 'applied';
  }

  /**
   * Causal apply-vs-conflict decision (rule 3): true when the incoming
   * revision is either provably a fast-forward from this device's current
   * head for `fileId`, or when causality simply cannot be evaluated because
   * the incoming revision carries no `parentRevisionIds` at all (a transport
   * that does not yet surface causal parentage — see `RemoteRevision`).
   *
   * When `parentRevisionIds` IS present, this only returns true if a
   * `producerSync` is wired with `localHeadFor`, that lookup resolves to a
   * known (non-null) local head, AND the incoming revision's parents include
   * it — i.e. the peer built its revision directly on top of (or through)
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
    return parents.includes(localHead);
  }

  /**
   * Applies a whole-file binary revision (F9). Structurally mirrors the markdown
   * `applyRemote` above but operates on RAW bytes: comparison and base hashing
   * use `hashBlob`/byte-equality (never `canonicalizeMarkdown`), writes go
   * through the byte vault API, and any conflict artifact keeps the original
   * file extension. Every data-safety invariant is preserved — diverged on-disk
   * bytes become a conflict artifact, never an overwrite (rule 3); the base
   * advances only on a clean apply or convergence, never on a divergence.
   */
  private async applyRemoteBinary(
    event: RemoteEvent,
    decoded: DecodedRevisionPayload,
    fileId: string,
  ): Promise<RemoteApplyOutcome> {
    const bytes = decoded.binaryContent ?? new Uint8Array(0);
    const incomingHash = await hashBlob(bytes);
    // Producer-mapping content for a binary file is base64 of the raw bytes —
    // the same form the observer stores, so a reflected vault event dedupes.
    const incomingBase64 = bytesToBase64(bytes);

    if (
      decoded.operation === 'rename' &&
      decoded.previousPath !== null &&
      this.files.fileIdAtPath(decoded.previousPath) === fileId
    ) {
      const previousOnDisk = await this.files.readBinaryByPath(decoded.previousPath);
      if (previousOnDisk !== null) {
        const base = this.files.baseHashFor(fileId);
        const previousHash = await hashBlob(previousOnDisk);
        if (base === null || previousHash !== base) {
          await this.writeConflict(event, decoded);
          return 'conflict';
        }
      }
      // Move the producer mapping off the OLD path before deleting it (F9), so the
      // reflected vault 'delete' event for the vacated path is not observed as a
      // local delete that forgets the still-live renamed fileId's base — the same
      // re-entrancy guard as the markdown rename branch above.
      await this.producerSync?.onRemoteDelete({
        fileId,
        path: decoded.previousPath,
      });
      await this.files.deleteByPath(decoded.previousPath);
      await this.files.forgetPath(decoded.previousPath);
    }

    const onDisk = await this.files.readBinaryByPath(decoded.path);

    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      if (onDisk !== null && bytesEqual(onDisk, bytes)) {
        await this.producerSync?.onRemoteDelete({ fileId: owner, path: decoded.path });
        await this.files.forgetBaseHash(owner);
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.files.recordBaseHash(fileId, incomingHash);
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: incomingBase64,
          contentHash: incomingHash,
          contentKind: 'binary',
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      await this.writeConflict(event, decoded);
      return 'conflict';
    }

    if (onDisk !== null) {
      if (bytesEqual(onDisk, bytes)) {
        await this.files.recordBaseHash(fileId, incomingHash);
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: incomingBase64,
          contentHash: incomingHash,
          contentKind: 'binary',
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      const base = this.files.baseHashFor(fileId);
      const onDiskHash = await hashBlob(onDisk);
      if (base === null || onDiskHash !== base) {
        await this.writeConflict(event, decoded);
        return 'conflict';
      }
      if (!(await this.isCausalFastForward(fileId, event))) {
        await this.writeConflict(event, decoded);
        return 'conflict';
      }
    }

    await this.producerSync?.onRemoteWrite({
      fileId,
      path: decoded.path,
      content: incomingBase64,
      contentHash: incomingHash,
      contentKind: 'binary',
      revisionId: event.revision.revisionId,
    });
    try {
      await this.files.writeBinaryByPath(decoded.path, bytes);
    } catch (error) {
      if (error instanceof ParentFolderOccupiedError) {
        // Same per-item divertion as the markdown path, over raw bytes and
        // preserving the original extension. Never a cycle-killing throw.
        await this.producerSync?.onRemoteDelete({ fileId, path: decoded.path });
        await this.writeConflict(event, decoded);
        return 'conflict';
      }
      throw error;
    }
    await this.files.recordPathOwner(fileId, decoded.path);
    await this.files.recordBaseHash(fileId, incomingHash);
    this.onRemoteApplied?.({
      revisionId: event.revision.revisionId,
      fileId,
      path: decoded.path,
      operation: decoded.operation,
    });
    return 'applied';
  }

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
  ): Promise<void> {
    const isBinary = decoded.kind === 'binary';
    const existing = this.files.conflictArtifactPathFor(event.revision.revisionId);
    const target = existing ?? (await this.buildConflictPath(event, decoded));
    if (isBinary) {
      await this.files.writeBinaryConflictArtifact(
        target,
        decoded.binaryContent ?? new Uint8Array(0),
      );
    } else {
      await this.files.writeConflictArtifact(target, decoded.content ?? '');
    }
    if (existing === null) {
      await this.files.recordConflictArtifactPath(
        event.revision.revisionId,
        target,
      );
      // A genuinely new copy landed: signal the auto-repair sweep (MRG-05). A
      // re-delivered revision reuses `existing` and never reaches here, so the
      // sweep is never re-triggered by an idempotent rewrite of the same copy.
      this.onConflictWritten?.();
    }
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

/** Byte-exact equality for two binary buffers (F9). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Convergence/noop equality between on-disk content and an incoming revision.
 * Compares the CANONICAL forms (AUD-03): a formatter that only touched line
 * endings, a BOM or trailing newlines after Havemind's last apply must read as
 * "already converged" here, not as a divergence that spawns a conflict artifact
 * or a spurious overwrite. Byte-exact disk content is untouched either way.
 */
function contentMatches(onDisk: string, incoming: string): boolean {
  return canonicalizeMarkdown(onDisk) === canonicalizeMarkdown(incoming);
}
