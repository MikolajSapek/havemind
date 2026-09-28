/**
 * The Activity feed's Restore: puts a note back to the text it had at an
 * earlier revision. The text comes from the server-backed revision history,
 * and it is written as an ordinary local edit, so it syncs to every device
 * and stays in history like any other change. Nothing is lost: the current
 * text remains a revision of its own.
 */

/** The text a revision gave a note, or null when it has none to restore. */
export interface RevisionContent {
  readonly fileId: string;
  readonly path: string;
  readonly content: string;
}

export interface RestoreDeps {
  /** Null for a delete, an attachment, or a revision the history lacks. */
  readonly revisionContent: (revisionId: string) => Promise<RevisionContent | null>;
  /** Where the file lives now; null when it was deleted since. */
  readonly currentPath: (fileId: string) => string | null;
  readonly vault: {
    getAbstractFileByPath(path: string): unknown;
    read(file: never): Promise<string>;
    modify(file: never, content: string): Promise<void>;
    create(path: string, content: string): Promise<unknown>;
  };
}

export type RestoreResult =
  | { readonly outcome: 'restored' | 'unchanged'; readonly path: string }
  | { readonly outcome: 'unavailable' };

export async function restoreRevision(deps: RestoreDeps, revisionId: string): Promise<RestoreResult> {
  const revision = await deps.revisionContent(revisionId);
  if (revision === null) return { outcome: 'unavailable' };
  const path = deps.currentPath(revision.fileId) ?? revision.path;
  const file = deps.vault.getAbstractFileByPath(path);
  if (file === null) {
    await deps.vault.create(path, revision.content);
    return { outcome: 'restored', path };
  }
  if ((await deps.vault.read(file as never)) === revision.content) {
    return { outcome: 'unchanged', path };
  }
  await deps.vault.modify(file as never, revision.content);
  return { outcome: 'restored', path };
}
