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
}

export class VaultApplyAdapter implements VaultApplyPort {
  private readonly files: VaultFilePort;
  private readonly conflictFolder: string;
  private readonly resolveRevision: (
    event: RemoteEvent,
  ) => Promise<DecodedRevisionPayload>;
  private readonly hashContent: (content: string) => Promise<string>;

  constructor(options: VaultApplyAdapterOptions) {
    this.files = options.files;
    this.conflictFolder = options.conflictFolder;
    this.resolveRevision = options.resolveRevision;
    this.hashContent = options.hashContent;
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
        await this.files.deleteByPath(decoded.path);
        await this.files.forgetPath(decoded.path);
        await this.files.forgetBaseHash(fileId);
      }
      return 'applied';
    }

    const text = decoded.content ?? '';

    // A rename moves the owned previous path before writing the new one. The
    // base hash is keyed by fileId, so it survives the move unchanged.
    if (
      decoded.operation === 'rename' &&
      decoded.previousPath !== null &&
      this.files.fileIdAtPath(decoded.previousPath) === fileId
    ) {
      await this.files.deleteByPath(decoded.previousPath);
      await this.files.forgetPath(decoded.previousPath);
    }

    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      // A different local file already occupies this path — never overwrite it,
      // and never claim ownership of it.
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
    const onDisk = await this.files.readByPath(decoded.path);
    if (onDisk !== null) {
      if (onDisk === text) {
        // Both sides already hold the incoming content: advance the base and
        // skip the write entirely (test: on-disk == incoming → no write).
        await this.files.recordBaseHash(fileId, await this.hashContent(text));
        await this.files.recordPathOwner(fileId, decoded.path);
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

    await this.files.writeByPath(decoded.path, text);
    await this.files.recordPathOwner(fileId, decoded.path);
    await this.files.recordBaseHash(fileId, await this.hashContent(text));
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
