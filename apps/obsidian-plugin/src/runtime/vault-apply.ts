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
import type { DecodedRevisionPayload } from '@havemind/sync-core';

import { bytesToBase64, pathExtension } from '../obsidian/vault-adapter';

import type {
  OpenBuffer,
  RemoteApplyOutcome,
  RemoteEvent,
  VaultApplyPort,
} from '../sync/sync-runner';

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
}

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
   * `revisionId`. `contentHash` is the SHA-256 hex of the note text. */
  onRemoteWrite(input: {
    readonly fileId: string;
    readonly path: string;
    readonly content: string;
    readonly contentHash: string;
    readonly revisionId: string;
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
          await this.files.writeConflictArtifact(this.conflictPath(event), text);
          return 'conflict';
        }
      }
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
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.files.recordBaseHash(fileId, contentHash);
        // Adopt the remote fileId into the producer mapping too (no disk write
        // fires here, but a later LOCAL edit must push under the shared fileId,
        // never the old random one this device minted for the same note).
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: text,
          contentHash,
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      // The path holds genuinely different content — a real divergence. Never
      // overwrite it and never claim ownership: preserve both via a conflict
      // artifact (the F2 conflict path).
      await this.files.writeConflictArtifact(this.conflictPath(event), text);
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
    // This is the on-disk analogue of the open-buffer check; a full three-way
    // text merge (@havemind/sync-core mergeSnapshots) would refine the conflict
    // branch — see the seam noted below.
    if (onDisk !== null) {
      if (contentMatches(onDisk, text)) {
        // Both sides already hold the incoming content: advance the base and
        // skip the write entirely (test: on-disk == incoming → no write).
        const contentHash = await this.hashContent(text);
        await this.files.recordBaseHash(fileId, contentHash);
        await this.files.recordPathOwner(fileId, decoded.path);
        await this.producerSync?.onRemoteWrite({
          fileId,
          path: decoded.path,
          content: text,
          contentHash,
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      const base = this.files.baseHashFor(fileId);
      const onDiskHash = await this.hashContent(onDisk);
      if (base === null || onDiskHash !== base) {
        // MERGE SEAM: the on-disk content diverged from the shared base and is
        // not the incoming content. A future slice can run
        // `mergeSnapshots(base, local, incoming)` here and only fall back to a
        // conflict artifact on OVERLAPPING_EDITS. Until then we guarantee the
        // hard rule: never a silent overwrite — preserve both versions.
        await this.files.writeConflictArtifact(this.conflictPath(event), text);
        return 'conflict';
      }
      // on-disk == base: the local file is unchanged since the last sync — but
      // that alone does not prove the incoming revision is safe to apply. The
      // 7b22b61 regression: a local push seeds the base to the just-authored
      // content, so a CONCURRENT peer revision (built on an older head, never
      // having seen ours) can have on-disk == base too, and would slip through
      // here and silently overwrite. Causality (parentRevisionIds vs. this
      // device's head) is the only thing that distinguishes a fast-forward
      // (the peer built on our head → safe to apply) from a concurrent
      // divergence (never a silent overwrite — rule 3). When causality cannot
      // be established (no producer-sync head lookup, no known local head, or
      // no parent list on the incoming revision) we fail SAFE to a conflict.
      if (!(await this.isCausalFastForward(fileId, event))) {
        await this.files.writeConflictArtifact(this.conflictPath(event), text);
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
      revisionId: event.revision.revisionId,
    });
    await this.files.writeByPath(decoded.path, text);
    await this.files.recordPathOwner(fileId, decoded.path);
    await this.files.recordBaseHash(fileId, contentHash);
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
    const extension = pathExtension(decoded.path) || 'bin';
    const incomingHash = await hashBlob(bytes);
    // Producer-mapping content for a binary file is base64 of the raw bytes —
    // the same form the observer stores, so a reflected vault event dedupes.
    const incomingBase64 = bytesToBase64(bytes);
    const conflictPath = this.conflictPath(event, extension);

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
          await this.files.writeBinaryConflictArtifact(conflictPath, bytes);
          return 'conflict';
        }
      }
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
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      await this.files.writeBinaryConflictArtifact(conflictPath, bytes);
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
          revisionId: event.revision.revisionId,
        });
        return 'noop';
      }
      const base = this.files.baseHashFor(fileId);
      const onDiskHash = await hashBlob(onDisk);
      if (base === null || onDiskHash !== base) {
        await this.files.writeBinaryConflictArtifact(conflictPath, bytes);
        return 'conflict';
      }
      if (!(await this.isCausalFastForward(fileId, event))) {
        await this.files.writeBinaryConflictArtifact(conflictPath, bytes);
        return 'conflict';
      }
    }

    await this.producerSync?.onRemoteWrite({
      fileId,
      path: decoded.path,
      content: incomingBase64,
      contentHash: incomingHash,
      revisionId: event.revision.revisionId,
    });
    await this.files.writeBinaryByPath(decoded.path, bytes);
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
    if (decoded.kind === 'binary') {
      const bytes = decoded.binaryContent ?? new Uint8Array(0);
      await this.files.writeBinaryConflictArtifact(
        this.conflictPath(event, pathExtension(decoded.path) || 'bin'),
        bytes,
      );
      return;
    }
    await this.files.writeConflictArtifact(
      this.conflictPath(event),
      decoded.content ?? '',
    );
  }

  private conflictPath(event: RemoteEvent, extension = 'md'): string {
    return `${this.conflictFolder}/${event.revision.fileId}-${event.revision.revisionId}.${extension}`;
  }
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
