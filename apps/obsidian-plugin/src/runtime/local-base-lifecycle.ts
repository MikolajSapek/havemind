/**
 * The base lifecycle for a locally-authored/pushed change (DATA-SAFETY, rule 3).
 *
 * The apply-side on-disk overwrite guard (`VaultApplyAdapter`) compares the
 * current on-disk content against the last synced BASE to decide apply-vs-
 * conflict. That guard is only sound if the base means "the last content BOTH
 * peers agreed on" — never "the last content THIS peer wrote". Advancing the
 * base on a local push is exactly what reopened the silent-overwrite window:
 * after this device pushes HA (base←HA) a CONCURRENT peer revision HB — built on
 * an older head, never having seen HA — arrives with on-disk == base == HA and
 * is misread as a clean fast-forward, silently overwriting HA.
 *
 * So on a local push we:
 *  - record path ownership (so a later peer edit to this file resolves to its
 *    fileId and updates in place instead of forking to a conflict artifact), and
 *  - SEED the base only on first authorship (no base recorded yet); we NEVER
 *    advance an existing base.
 *
 * The base advances only on a clean remote apply or on convergence (incoming
 * content already equals on-disk) — both handled in `VaultApplyAdapter`, the
 * only two moments both peers are known to share the content.
 *
 * This module is the single source of truth for that rule, shared by the live
 * push-producer wiring (`obsidian-adapters.ts`) and the integration harness, so a
 * regression here can never hide behind a test that models the base differently
 * from production.
 */

/** The minimal durable-state surface the local-push base lifecycle needs. */
export interface LocalBaseLifecycleStore {
  /** The last synced base content hash for `fileId`, or null if none recorded. */
  baseHashFor(fileId: string): string | null;
  recordPathOwner(fileId: string, path: string): Promise<void>;
  recordBaseHash(fileId: string, hash: string): Promise<void>;
  forgetPath(path: string): Promise<void>;
  forgetBaseHash(fileId: string): Promise<void>;
}

export interface LocalMaterializationInput {
  readonly fileId: string;
  readonly path: string;
  /** SHA-256 hex of the normalized note text. */
  readonly contentHash: string;
  /** The prior path on a rename, so its stale ownership can be forgotten. */
  readonly previousPath: string | null;
}

export interface LocalForgetInput {
  readonly fileId: string;
  readonly path: string;
}

/**
 * Records the shared ownership for a create/update/rename this device authored or
 * pushed, seeding the base ONLY on first authorship. Awaiting `recordPathOwner`
 * first also warms the durable-state cache the synchronous `baseHashFor` reads.
 */
export async function applyLocalMaterialization(
  store: LocalBaseLifecycleStore,
  input: LocalMaterializationInput,
): Promise<void> {
  if (input.previousPath !== null && input.previousPath !== input.path) {
    await store.forgetPath(input.previousPath);
  }
  await store.recordPathOwner(input.fileId, input.path);
  // Seed on first authorship only — never advance an existing base on a push.
  if (store.baseHashFor(input.fileId) === null) {
    await store.recordBaseHash(input.fileId, input.contentHash);
  }
}

/** Forgets the shared ownership+base when this device deletes a file. */
export async function forgetLocalMaterialization(
  store: LocalBaseLifecycleStore,
  input: LocalForgetInput,
): Promise<void> {
  await store.forgetPath(input.path);
  await store.forgetBaseHash(input.fileId);
}
