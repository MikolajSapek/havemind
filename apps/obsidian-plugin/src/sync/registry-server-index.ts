/**
 * The vault's current contents, read from what the bootstrap just materialised.
 *
 * Join-time adoption needs to know which contents the vault already holds.
 * Asking the server directly would mean downloading every blob just to hash it,
 * because the plaintext hash lives inside the payload rather than in the receipt
 * header, so a joining device would pay for the whole vault twice.
 *
 * It does not need to: the bootstrap has just materialised every one of those
 * files, and the registry therefore already holds each file's identity, path and
 * agreed hash. That set is exactly what reconcile must not duplicate, which is
 * the bug this closes: the phone re-uploaded 31 notes it had finished
 * downloading seconds earlier.
 */

import type { ServerFileIndex } from './join-adoption';
import type { FileRegistry } from './file-registry';

export interface ServerIndexOptions {
  /**
   * Index only files whose content both peers have agreed on, i.e. what the
   * vault genuinely holds. Local drafts this device authored but never synced
   * are not the vault's contents and must not be adopted against.
   */
  readonly agreedOnly?: boolean;
}

export function serverIndexFromRegistry(
  registry: FileRegistry,
  options: ServerIndexOptions = {},
): ServerFileIndex {
  const byHash = new Map<string, { fileId: string; path: string }>();
  const byPath = new Map<string, { fileId: string; hash: string }>();

  for (const record of registry.all()) {
    const hash = record.agreedHash;
    if (hash === null || hash === '') continue;
    if (options.agreedOnly === true && record.agreedContent === null) continue;

    const existing = byHash.get(hash);
    // Two vault files can legitimately hold the same text. Pick deterministically
    // (lowest fileId) so two devices building this index reach the same answer
    // and cannot adopt opposite sides of the same pair.
    if (existing === undefined || record.fileId < existing.fileId) {
      byHash.set(hash, { fileId: record.fileId, path: record.path });
    }
    if (record.path !== '') {
      byPath.set(record.path, { fileId: record.fileId, hash });
    }
  }

  return {
    byContentHash: (hash) => byHash.get(hash),
    byPath: (path) => byPath.get(path),
  };
}
