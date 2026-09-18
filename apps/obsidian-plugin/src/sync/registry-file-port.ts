/**
 * The apply side's six state-writing methods, backed by one {@link FileRegistry}.
 *
 * `VaultFilePort` exposes `recordPathOwner` / `forgetPath`, `recordBaseHash` /
 * `forgetBaseHash` and `recordBaseContent` / `forgetBaseContent` as six
 * independent writes over three separate maps, called 42 times across
 * `vault-apply.ts`. A branch that updates one but not another leaves a state
 * that should not exist: an ancestor that no longer hashes to its base makes
 * the three-way merge unsatisfiable (so every divergence degrades into a
 * conflict copy), and a path owner without a base makes every incoming revision
 * read as divergent.
 *
 * This adapter keeps the six-method SHAPE, so the 42 call sites keep working
 * unchanged, but routes them all into a single record per file. The pair that
 * used to drift is now one assignment. Once every call site is expressed in
 * terms of real events (`authoredLocally` / `agreedWithPeer` / `removed`) this
 * adapter can go, and the six methods with it.
 */

import type { FileRegistry } from './file-registry';

/** Exactly the state-owning half of `VaultFilePort`, no vault I/O. */
export interface RegistryStatePort {
  fileIdAtPath(path: string): string | null;
  recordPathOwner(fileId: string, path: string): Promise<void>;
  forgetPath(path: string): Promise<void>;
  baseHashFor(fileId: string): string | null;
  recordBaseHash(fileId: string, hash: string): Promise<void>;
  forgetBaseHash(fileId: string): Promise<void>;
  baseContentFor(fileId: string): string | null;
  recordBaseContent(fileId: string, content: string): Promise<void>;
  forgetBaseContent(fileId: string): Promise<void>;
}

/**
 * Canonical, case-folded form of a vault path. The registry indexes on it so two
 * files differing only in case cannot both claim one slot; the real classifier
 * lives in `vault-adapter.ts`, and this mirrors just the folding it applies.
 */
function collisionKeyFor(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function createRegistryStatePort(
  registry: FileRegistry,
): RegistryStatePort {
  return {
    fileIdAtPath(path) {
      return registry.byPath(path)?.fileId ?? null;
    },
    async recordPathOwner(fileId, path) {
      registry.patch(fileId, { path, collisionKey: collisionKeyFor(path) });
    },
    async forgetPath(path) {
      const record = registry.byPath(path);
      if (record === undefined) return;
      registry.removed(record.fileId);
    },
    baseHashFor(fileId) {
      return registry.byFileId(fileId)?.agreedHash ?? null;
    },
    async recordBaseHash(fileId, hash) {
      registry.patch(fileId, { agreedHash: hash });
    },
    async forgetBaseHash(fileId) {
      if (registry.byFileId(fileId) === undefined) return;
      registry.patch(fileId, { agreedHash: null });
    },
    baseContentFor(fileId) {
      return registry.byFileId(fileId)?.agreedContent ?? null;
    },
    async recordBaseContent(fileId, content) {
      registry.patch(fileId, { agreedContent: content });
    },
    async forgetBaseContent(fileId) {
      if (registry.byFileId(fileId) === undefined) return;
      registry.patch(fileId, { agreedContent: null });
    },
  };
}
