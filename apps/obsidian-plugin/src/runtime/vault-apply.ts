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

import type { OpenBuffer, RemoteEvent, VaultApplyPort } from '../sync/sync-runner';

export interface VaultFilePort {
  /** Open editor buffer states for the file, or an empty list if none open. */
  openBufferStates(fileId: string): readonly OpenBuffer[];
  /** The fileId of the live file currently at `path`, or null if none. */
  fileIdAtPath(path: string): string | null;
  /** Create or overwrite the live file at a vault-relative path. */
  writeByPath(path: string, content: string): Promise<void>;
  /** Delete the live file at a vault-relative path. */
  deleteByPath(path: string): Promise<void>;
  /** Write a conflict artifact at an explicit vault-relative path. */
  writeConflictArtifact(path: string, content: string): Promise<void>;
}

export interface VaultApplyAdapterOptions {
  readonly files: VaultFilePort;
  readonly conflictFolder: string;
  readonly resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
}

export class VaultApplyAdapter implements VaultApplyPort {
  private readonly files: VaultFilePort;
  private readonly conflictFolder: string;
  private readonly resolveRevision: (
    event: RemoteEvent,
  ) => Promise<DecodedRevisionPayload>;

  constructor(options: VaultApplyAdapterOptions) {
    this.files = options.files;
    this.conflictFolder = options.conflictFolder;
    this.resolveRevision = options.resolveRevision;
  }

  async openBuffers(fileId: string): Promise<readonly OpenBuffer[]> {
    return this.files.openBufferStates(fileId);
  }

  async applyRemote(event: RemoteEvent): Promise<void> {
    const decoded = await this.resolveRevision(event);
    const fileId = event.revision.fileId;

    if (decoded.operation === 'delete') {
      // Only remove a file this revision actually owns.
      if (this.files.fileIdAtPath(decoded.path) === fileId) {
        await this.files.deleteByPath(decoded.path);
      }
      return;
    }

    const text = decoded.content ?? '';

    // A rename moves the owned previous path before writing the new one.
    if (
      decoded.operation === 'rename' &&
      decoded.previousPath !== null &&
      this.files.fileIdAtPath(decoded.previousPath) === fileId
    ) {
      await this.files.deleteByPath(decoded.previousPath);
    }

    const owner = this.files.fileIdAtPath(decoded.path);
    if (owner !== null && owner !== fileId) {
      // A different local file already occupies this path — never overwrite it.
      await this.files.writeConflictArtifact(this.conflictPath(event), text);
      return;
    }

    await this.files.writeByPath(decoded.path, text);
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
