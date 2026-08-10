/**
 * The runner's `VaultFilePort` bound to the live Obsidian Vault: every read,
 * write, delete and conflict-artifact landing the apply path performs, plus the
 * folder-materialisation guards those writes depend on. Grouped here because the
 * guards are not reusable utilities but the port's own preconditions — a create
 * whose parent folder is missing, or a reserved path occupied by a non-folder
 * file, both throw inside Obsidian's Vault API and previously wedged the pull
 * cycle in permanent backoff.
 */

import { TFolder, type TFile, type Vault } from 'obsidian';

import { canonicalizeMarkdown, isSyncableConfigPath } from '@havemind/protocol';

import {
  removeConfig,
  writeConfigBinary,
  writeConfigText,
} from '../../sync/config-adapter';
import type { OpenBuffer } from '../../sync/sync-runner';
import type { DurableSyncState } from '../sync-state';
import {
  ParentFolderOccupiedError,
  type VaultFilePort,
} from '../vault-apply';

import type { ConfigApplyReloader } from './config-apply';

export interface VaultFilePortOptions {
  readonly vault: Vault;
  readonly state: DurableSyncState;
  /**
   * Notified after every successful `.obsidian/` apply (write or delete) so the
   * receiving device SEES the change without restarting Obsidian. Optional: a
   * port built without it still writes the bytes correctly, it just cannot
   * refresh the UI, which is the pre-fix behaviour and the right default for
   * tests that assert disk state only.
   */
  readonly configApply?: ConfigApplyReloader;
}

/**
 * Binds the runner's `VaultFilePort` to the live Vault, resolving ownership from
 * the SHARED apply store (`DurableSyncState.pathOwners`). That store is now
 * seeded for both files RECEIVED from the peer (on remote apply) AND files this
 * device authored/pushed (via the producer's `onLocalMaterialized` seam), so a
 * peer edit to a locally-authored file resolves to its real fileId and updates
 * in place. A path with no owner resolves to `null`: a genuinely remote-only
 * file then materializes cleanly, and any pre-existing physical content there is
 * still protected by the adapter's on-disk overwrite guard (a null base with
 * divergent content becomes a conflict, never a silent overwrite).
 */
/**
 * Ensures `folder` exists and is genuinely a folder, returning the path to
 * write under. Guards against a non-folder file occupying the reserved path
 * (e.g. a note literally named `Havemind Conflicts` with no extension):
 * `getAbstractFileByPath` returning non-null does not mean the path is a
 * folder, and skipping `createFolder` in that case would make the later
 * `vault.create` throw — a throw the sync cycle has no permanent-error
 * classification for on the pull path, so it wedges the pull loop in
 * infinite 'offline' backoff (see `writeConflictArtifact`). Falls back to a
 * sanitized sibling folder name, then to the vault root, so a single
 * occupied path can never wedge sync.
 */
async function ensureWritableConflictFolder(
  vault: Pick<Vault, 'getAbstractFileByPath' | 'createFolder'>,
  folder: string,
): Promise<string> {
  const abstract = vault.getAbstractFileByPath(folder);
  if (abstract === null) {
    await vault.createFolder(folder);
    return folder;
  }
  if (abstract instanceof TFolder) {
    return folder;
  }
  const fallback = `${folder} (files)`;
  const fallbackAbstract = vault.getAbstractFileByPath(fallback);
  if (fallbackAbstract === null) {
    await vault.createFolder(fallback);
    return fallback;
  }
  if (fallbackAbstract instanceof TFolder) {
    return fallback;
  }
  // Even the sanitized fallback is occupied by a non-folder file. Land the
  // artifact at the vault root rather than throwing.
  return '';
}

/**
 * Splits an artifact path into folder + filename and resolves a guaranteed-
 * writable target under a confirmed folder (falling back per
 * {@link ensureWritableConflictFolder}). Shared by the markdown and binary
 * conflict writers so both land the artifact identically (F9).
 */
async function resolveConflictTarget(
  vault: Pick<Vault, 'getAbstractFileByPath' | 'createFolder'>,
  path: string,
): Promise<string> {
  const separatorIndex = path.lastIndexOf('/');
  const folder = separatorIndex === -1 ? '' : path.slice(0, separatorIndex);
  const filename = separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
  const resolvedFolder =
    folder === '' ? '' : await ensureWritableConflictFolder(vault, folder);
  return resolvedFolder === '' ? filename : `${resolvedFolder}/${filename}`;
}

/**
 * Exact ArrayBuffer view of `bytes` — copies only the used region, so a
 * Uint8Array that is a subview of a larger buffer never ships trailing bytes to
 * `createBinary`/`modifyBinary` (F9).
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Ensures every ANCESTOR folder of `path` exists before a create-materialization
 * write, walking from the shallowest segment down and creating each missing
 * level with `vault.createFolder` (level by level — Obsidian's `createFolder`
 * does not reliably create nested paths in one call). This is the fix for the
 * 5-day field outage: a freshly onboarded vault that pulls a remote create for
 * `Notatki/Start.md` has no `Notatki` folder, and Obsidian's `vault.create`
 * THROWS when the parent folder is missing — that throw bubbled to the pull
 * cycle, which has no permanent-error classification on the apply path, so the
 * cursor never advanced and sync wedged on 'Offline — will retry' forever.
 *
 * Reuses the TFolder-instanceof discipline from `ensureWritableConflictFolder`:
 * `getAbstractFileByPath` returning non-null does NOT prove a folder. If an
 * ancestor path is occupied by a FILE, the hierarchy cannot be created, so this
 * throws {@link ParentFolderOccupiedError} — a PERMANENT per-item failure the
 * apply side diverts to a conflict artifact, so a single occupied path never
 * wedges the whole cycle. An overwrite/modify of an EXISTING file needs no
 * folder work and never calls this.
 */
async function ensureParentFolders(
  vault: Pick<Vault, 'getAbstractFileByPath' | 'createFolder'>,
  path: string,
): Promise<void> {
  const separatorIndex = path.lastIndexOf('/');
  if (separatorIndex === -1) return; // root-level file: no parent to create
  const segments = path.slice(0, separatorIndex).split('/');
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    const existing = vault.getAbstractFileByPath(prefix);
    if (existing === null) {
      await vault.createFolder(prefix);
      continue;
    }
    if (existing instanceof TFolder) {
      continue;
    }
    throw new ParentFolderOccupiedError(prefix);
  }
}

export function createVaultFilePort(options: VaultFilePortOptions): VaultFilePort {
  const { vault, state, configApply } = options;
  return {
    openBufferStates(): readonly OpenBuffer[] {
      // Buffer divergence is resolved from the editor layer; the desktop shell
      // wires live buffers in a later slice. Until then no buffer is reported,
      // which is the safe default (clean → apply).
      return [];
    },
    fileIdAtPath(path) {
      // The single shared ownership truth: a path Havemind owns (authored here or
      // received from the peer) resolves to its fileId for an in-place update; an
      // unowned path resolves to null and is guarded on disk before any write.
      return state.fileIdAtPath(path);
    },
    async readByPath(path) {
      // A `.obsidian/` config path lives outside the Vault file API — read it via
      // the DataAdapter, canonicalised on equal terms with the producer.
      if (isSyncableConfigPath(path)) {
        if (!(await vault.adapter.exists(path))) return null;
        return canonicalizeMarkdown(await vault.adapter.read(path));
      }
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) return null;
      // Normalise line endings the same way the push producer does, so the
      // on-disk overwrite guard compares content on equal terms.
      const raw = await vault.read(existing as TFile);
      // Canonicalise the same way the push producer and base-hash seed do
      // (AUD-03), so the on-disk overwrite guard compares content on equal
      // terms. Hash/compare-side only — the file on disk is never rewritten.
      return canonicalizeMarkdown(raw);
    },
    async readBinaryByPath(path) {
      if (isSyncableConfigPath(path)) {
        if (!(await vault.adapter.exists(path))) return null;
        return new Uint8Array(await vault.adapter.readBinary(path));
      }
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) return null;
      // Raw bytes, never canonicalised (F9) — the binary apply path compares and
      // hashes them byte-for-byte.
      const buffer = await vault.readBinary(existing as TFile);
      return new Uint8Array(buffer);
    },
    baseHashFor: (fileId) => state.baseHashFor(fileId),
    recordBaseHash: (fileId, hash) => state.recordBaseHash(fileId, hash),
    forgetBaseHash: (fileId) => state.forgetBaseHash(fileId),
    baseContentFor: (fileId) => state.baseContentFor(fileId),
    recordBaseContent: (fileId, content) => state.recordBaseContent(fileId, content),
    forgetBaseContent: (fileId) => state.forgetBaseContent(fileId),
    async conflictArtifactExists(path) {
      return vault.getAbstractFileByPath(path) !== null;
    },
    conflictArtifactPathFor: (revisionId) =>
      state.conflictArtifactPathFor(revisionId),
    recordConflictArtifactPath: (revisionId, path) =>
      state.recordConflictArtifactPath(revisionId, path),
    async writeByPath(path, content) {
      // A `.obsidian/` config write goes through the DataAdapter (create-or-
      // overwrite), materialising parent dirs — the Vault file API cannot touch
      // hidden paths.
      if (isSyncableConfigPath(path)) {
        await writeConfigText(vault.adapter, path, content);
        // The bytes alone change nothing the user can see — Obsidian holds its
        // config in memory. Report the apply so the batch can refresh the CSS or
        // tell the user a reload is needed.
        configApply?.applied(path);
        return;
      }
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) {
        // A create must first materialize the parent-folder hierarchy — a
        // remote note in a folder this device has never seen (`Notatki/x.md`)
        // would otherwise make `vault.create` throw and wedge the pull cycle.
        await ensureParentFolders(vault, path);
        await vault.create(path, content);
        return;
      }
      await vault.modify(existing as TFile, content);
    },
    async writeBinaryByPath(path, bytes) {
      if (isSyncableConfigPath(path)) {
        await writeConfigBinary(vault.adapter, path, toArrayBuffer(bytes));
        // Same visibility gap as the text write: a theme's binary asset landing
        // on disk is invisible until Obsidian re-reads its CSS.
        configApply?.applied(path);
        return;
      }
      const existing = vault.getAbstractFileByPath(path);
      const data = toArrayBuffer(bytes);
      if (existing === null) {
        // Same parent-folder materialization as the markdown create (F9): a
        // binary attachment in a not-yet-seen folder must not wedge the cycle.
        await ensureParentFolders(vault, path);
        await vault.createBinary(path, data);
        return;
      }
      await vault.modifyBinary(existing as TFile, data);
    },
    async deleteByPath(path) {
      if (isSyncableConfigPath(path)) {
        await removeConfig(vault.adapter, path);
        // A removal is the same visibility problem in reverse: a snippet the peer
        // deleted keeps styling this vault until Obsidian re-reads its CSS.
        configApply?.applied(path);
        return;
      }
      const existing = vault.getAbstractFileByPath(path);
      if (existing !== null) {
        await vault.delete(existing);
      }
    },
    async writeConflictArtifact(path, content) {
      const targetPath = await resolveConflictTarget(vault, path);
      // Idempotent (create-or-overwrite). `vault.create` throws if the path
      // already exists, and the runner saves the pull cursor only AFTER apply,
      // so a crash mid-cycle or a second delivery re-writes the same
      // `fileId-revisionId.md` artifact. A throw here would be caught by the
      // cycle as 'offline' and wedge the whole pull loop in infinite backoff.
      const existing = vault.getAbstractFileByPath(targetPath);
      if (existing === null) {
        await vault.create(targetPath, content);
        return;
      }
      await vault.modify(existing as TFile, content);
    },
    async writeBinaryConflictArtifact(path, bytes) {
      // Same idempotent folder-resolution as the markdown conflict writer, but
      // over raw bytes and preserving the original extension (F9).
      const targetPath = await resolveConflictTarget(vault, path);
      const data = toArrayBuffer(bytes);
      const existing = vault.getAbstractFileByPath(targetPath);
      if (existing === null) {
        await vault.createBinary(targetPath, data);
        return;
      }
      await vault.modifyBinary(existing as TFile, data);
    },
    recordPathOwner: (fileId, path) => state.recordPathOwner(fileId, path),
    forgetPath: (path) => state.forgetPath(path),
  };
}
