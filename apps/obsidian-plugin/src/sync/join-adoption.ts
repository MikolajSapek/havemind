/**
 * Settling file identity when a device joins a vault that already has content.
 *
 * A second device usually holds a copy of the same notes already, seeded from
 * the same source. Connect-time reconcile finds no local mapping for them and
 * pushes every one as a brand new file, so the vault ends up with two identities
 * for one note. On the pilot that made 117 files out of 86 distinct contents and
 * sent 5.4 MB the server already had.
 *
 * At join time identity is therefore settled by CONTENT: if the server already
 * holds this exact text, the joining device adopts that file rather than minting
 * its own. Only if nothing matches does a new file appear.
 *
 * Deliberately scoped to the join. In normal operation two notes with identical
 * text at different paths are two notes, and collapsing them would be wrong; the
 * question here is narrower, namely whether a file the server ALREADY has should
 * be uploaded a second time under a new name.
 */

/** What the server reports about a vault's current files. */
export interface ServerFileIndex {
  /** The file holding this exact content, if any. */
  byContentHash(hash: string): { fileId: string; path: string } | undefined;
  /** The file currently at this path, if any. */
  byPath(path: string): { fileId: string; hash: string } | undefined;
}

export interface LocalFile {
  readonly path: string;
  readonly contentHash: string;
}

export type JoinDecision =
  /** The server already has this content: take its identity, push nothing. */
  | { readonly kind: 'adopt'; readonly fileId: string }
  /**
   * The server has this path with different content: this is an edit to that
   * file, so it joins that history instead of starting a rival one.
   */
  | { readonly kind: 'adopt-with-edit'; readonly fileId: string }
  /** Genuinely new on this device: create it. */
  | { readonly kind: 'create' };

/**
 * Decides whether a local file should adopt a server identity or become a new
 * file.
 *
 * `claimed` guards the one-to-one rule: two local copies of the same note must
 * not both claim its identity, because the second would silently overwrite the
 * first. The second copy becomes a new file, which is honest, and the user can
 * merge or delete it themselves.
 */
export function adoptOrCreate(
  server: ServerFileIndex,
  local: LocalFile,
  claimed: Set<string> = new Set(),
): JoinDecision {
  // Content is the stronger signal: this exact text already has an identity,
  // wherever it happens to sit. A path collision is a separate question.
  const byContent = server.byContentHash(local.contentHash);
  if (byContent !== undefined && !claimed.has(byContent.fileId)) {
    claimed.add(byContent.fileId);
    return { kind: 'adopt', fileId: byContent.fileId };
  }

  const atPath = server.byPath(local.path);
  if (atPath !== undefined && !claimed.has(atPath.fileId)) {
    claimed.add(atPath.fileId);
    // Same path, different text: a real edit to a file the vault owns.
    return { kind: 'adopt-with-edit', fileId: atPath.fileId };
  }

  return { kind: 'create' };
}
