/**
 * Bridges the runner's `VaultApplyPort` to the real Obsidian Vault.
 *
 * The runner has already decided (via `decideRemoteApply`) that an incoming
 * revision is safe to write or must become a conflict; this adapter only carries
 * out that decision against the vault:
 *  - `applyRemote` writes the resolved remote content to the live file.
 *  - `recordConflict` writes a copy into the reserved `Havemind Conflicts/`
 *    folder and never touches the live file (rule 4, zero silent overwrites).
 *
 * Fetching the remote bytes and turning the opaque payload back into plaintext
 * is injected as `resolveContent`, keeping this adapter free of blob-transfer and
 * client-model concerns so it stays unit-testable.
 */

import type { OpenBuffer, RemoteEvent, VaultApplyPort } from '../sync/sync-runner';

export interface VaultFilePort {
  /** Open editor buffer states for the file, or an empty list if none open. */
  openBufferStates(fileId: string): readonly OpenBuffer[];
  /** Create or overwrite the live vault file mapped to `fileId`. */
  writeByFileId(fileId: string, content: string): Promise<void>;
  /** Write a conflict artifact at an explicit vault-relative path. */
  writeConflictArtifact(path: string, content: string): Promise<void>;
}

export interface VaultApplyAdapterOptions {
  readonly files: VaultFilePort;
  readonly conflictFolder: string;
  readonly resolveContent: (event: RemoteEvent) => Promise<string>;
}

export class VaultApplyAdapter implements VaultApplyPort {
  private readonly files: VaultFilePort;
  private readonly conflictFolder: string;
  private readonly resolveContent: (event: RemoteEvent) => Promise<string>;

  constructor(options: VaultApplyAdapterOptions) {
    this.files = options.files;
    this.conflictFolder = options.conflictFolder;
    this.resolveContent = options.resolveContent;
  }

  async openBuffers(fileId: string): Promise<readonly OpenBuffer[]> {
    return this.files.openBufferStates(fileId);
  }

  async applyRemote(event: RemoteEvent): Promise<void> {
    const content = await this.resolveContent(event);
    await this.files.writeByFileId(event.revision.fileId, content);
  }

  async recordConflict(event: RemoteEvent): Promise<void> {
    const content = await this.resolveContent(event);
    const path = `${this.conflictFolder}/${event.revision.fileId}-${event.revision.revisionId}.md`;
    await this.files.writeConflictArtifact(path, content);
  }
}
