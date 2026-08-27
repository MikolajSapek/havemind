/**
 * Registration and teardown of the four Obsidian vault-change listeners the push
 * producer reacts to. A deliberately small, exported seam: the teardown contract
 *, exactly the listeners we added are removed on stop, via `vault.offref` rather
 * than plugin-unload registration, is what stops a re-pair from leaving a
 * prior-session observer attached, and keeping it here makes that contract unit
 * testable without the full Obsidian runtime.
 */

import {
  TFile,
  TFolder,
  type EventRef,
  type TAbstractFile,
  type Vault,
} from 'obsidian';

/** The four vault-change callbacks the push producer reacts to. */
export interface VaultChangeListenerHandlers {
  onCreate: (path: string) => void;
  onModify: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  /**
   * A folder-level rename (Obsidian or another plugin moving a whole folder).
   * Defence-in-depth against Obsidian emitting only the TFolder event: the
   * producer re-paths every child mapping under the old folder prefix so a
   * later child edit resolves to its existing fileId instead of forking.
   */
  onFolderRename: (oldFolderPath: string, newFolderPath: string) => void;
  /** A folder-level delete: every child mapping under the prefix is tombstoned. */
  onFolderDelete: (folderPath: string) => void;
}

/**
 * Registers the four vault-change listeners and returns a disposer that detaches
 * every one via `vault.offref`. Kept a small, exported, injectable seam so the
 * teardown contract (exactly the listeners we added are removed on stop) is unit
 * testable without the full Obsidian runtime. Non-`TFile` events and missing
 * paths are ignored, matching the producer's markdown-only scope.
 */
export function registerVaultChangeListeners(
  vault: Pick<Vault, 'on' | 'offref'>,
  handlers: VaultChangeListenerHandlers,
): () => void {
  const refs: EventRef[] = [
    vault.on('create', (file) => {
      if (file instanceof TFile) handlers.onCreate(file.path);
    }),
    vault.on('modify', (file) => {
      if (file instanceof TFile) handlers.onModify(file.path);
    }),
    vault.on('delete', (file) => {
      if (file instanceof TFolder) {
        handlers.onFolderDelete(file.path);
        return;
      }
      const path = (file as TAbstractFile).path;
      if (typeof path === 'string') handlers.onDelete(path);
    }),
    vault.on('rename', (file, oldPath) => {
      if (typeof oldPath !== 'string') return;
      if (file instanceof TFile) {
        handlers.onRename(oldPath, file.path);
      } else if (file instanceof TFolder) {
        handlers.onFolderRename(oldPath, file.path);
      }
    }),
  ];
  return () => {
    for (const ref of refs) vault.offref(ref);
  };
}
