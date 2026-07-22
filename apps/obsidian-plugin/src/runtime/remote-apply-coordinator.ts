/**
 * Bridges the apply side's remote writes into the push producer's durable
 * fileId↔path↔content map, so the vault event a remote-apply write triggers is
 * never re-observed as a fresh LOCAL change. Without this bridge a two-person
 * steady state loops forever: applying the peer's edit fires a vault event, the
 * producer re-pushes it as a new local revision, records it as local activity,
 * and — for a remote-only create — mints a brand-new random fileId (a duplicate
 * fileId for the same path across devices).
 *
 * The producer is created after the vault-apply adapter (see
 * `obsidian-adapters.ts`), so the binding is late — resolved through a getter
 * that returns null until the producer exists. This module is deliberately
 * platform-free (no Obsidian imports) so it is unit-tested directly.
 */

import { classifyVaultPath, type LocalFileMapping } from '../obsidian/vault-adapter';

import type { RemoteApplyProducerSync } from './vault-apply';

/** The narrow producer surface the coordinator drives (the outbox repository). */
export interface AdoptableProducer {
  /** Adopt a mapping+head for a file materialised by remote apply (no enqueue). */
  adoptRemoteMapping(
    mapping: LocalFileMapping,
    headRevisionId: string,
  ): Promise<void>;
  /** Forget the mapping+head for a file removed by remote apply. */
  forgetRemoteMapping(collisionKey: string, fileId: string): Promise<void>;
  /**
   * This device's current head revisionId for `fileId`, or null if none is
   * known. Bridged straight through to `RemoteApplyProducerSync.localHeadFor`
   * so the apply side's causal apply-vs-conflict decision (rule 3) can tell a
   * fast-forward from a concurrent divergence.
   */
  headFor(fileId: string): Promise<string | null>;
}

/**
 * Builds the `RemoteApplyProducerSync` the vault-apply adapter calls in lockstep
 * with each remote write/delete. `getProducer` returns null before the producer
 * has started (no push identity yet), in which case the calls are inert.
 */
export function createRemoteApplyProducerSync(
  getProducer: () => AdoptableProducer | null,
): RemoteApplyProducerSync {
  return {
    async onRemoteWrite({ fileId, path, content, contentHash, revisionId, contentKind }) {
      const producer = getProducer();
      if (producer === null) return;
      const classified = classifyVaultPath(path);
      if (!classified.eligible) return;
      const mapping: LocalFileMapping = {
        collisionKey: classified.collisionKey,
        content,
        contentHash,
        // Carry the binary discriminator into the durable producer mapping so a
        // RECEIVED binary is persisted (and rebased) as binary, never markdown.
        // Absent/markdown is omitted — an absent contentKind already means
        // markdown, keeping the mapping shape unchanged for text notes.
        ...(contentKind === 'binary' ? { contentKind: 'binary' } : {}),
        fileId,
        path: classified.canonicalPath,
      };
      await producer.adoptRemoteMapping(mapping, revisionId);
    },
    async onRemoteDelete({ fileId, path }) {
      const producer = getProducer();
      if (producer === null) return;
      const classified = classifyVaultPath(path);
      if (!classified.eligible) return;
      await producer.forgetRemoteMapping(classified.collisionKey, fileId);
    },
    async localHeadFor(fileId) {
      const producer = getProducer();
      if (producer === null) return null;
      return producer.headFor(fileId);
    },
  };
}
