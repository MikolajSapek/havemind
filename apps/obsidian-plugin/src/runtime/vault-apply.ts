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

import type { DecodedRevisionPayload } from '@havemind/sync-core';

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
  /** Create or overwrite the live file at a vault-relative path. */
  writeByPath(path: string, content: string): Promise<void>;
  /** Delete the live file at a vault-relative path. */
  deleteByPath(path: string): Promise<void>;
  /** Write a conflict artifact at an explicit vault-relative path. */
  writeConflictArtifact(path: string, content: string): Promise<void>;
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
      if (onDisk !== null && onDisk === text) {
        const contentHash = await this.hashContent(text);
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
      if (onDisk === text) {
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
      // on-disk == base: the local file is unchanged since the last sync, so the
      // incoming revision applies cleanly (this keeps F1's clean-apply path).
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

  async recordConflict(event: RemoteEvent): Promise<void> {
    const decoded = await this.resolveRevision(event);
    await this.files.writeConflictArtifact(
      this.conflictPath(event),
      decoded.content ?? '',
    );
  }

  private conflictPath(event: RemoteEvent): string {
    return `${this.conflictFolder}/${event.revision.fileId}-${event.revision.revisionId}.md`;
  }
}
