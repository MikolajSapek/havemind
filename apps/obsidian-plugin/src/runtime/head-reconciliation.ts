import { canonicalizeMarkdown } from '@havemind/protocol';
import { mergeText } from '@havemind/sync-core';
import type { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import type { DurableSyncState } from './sync-state';
import type { VaultFilePort } from './vault-apply';
import type { KeyedLock } from './keyed-mutex';
import { ancestors, commonAncestor, type RevisionHistory } from './revision-history';

/** Rebase pending full snapshots only when every branch is represented in the
 * current file. This changes queue ancestry, never the user's bytes. Overlapping
 * or structural changes keep their existing conflict and recovery payloads.
 */
export async function reconcileHeads(options: {
  history: RevisionHistory;
  state: DurableSyncState;
  producer: OutboxLocalChangeRepository;
  files: VaultFilePort;
  lock: KeyedLock;
}): Promise<void> {
  const { history, state, producer, files, lock } = options;
  await history.refresh();
  for (const mapping of await producer.listMappings()) {
    if (mapping.contentKind === 'binary') continue;
    await lock.runExclusive(mapping.collisionKey, async () => {
      if ((await files.openBufferStates(mapping.fileId)).some((buffer) => buffer.unsaved)) return;
      const local = await producer.versionFor(mapping.fileId);
      if (local === null || local.contentHash !== mapping.contentHash) return;
      const pending = (await state.listOutbox()).filter((entry) => entry.fileId === mapping.fileId);
      const heads = await history.heads(mapping.fileId);
      if (heads.length === 0 || (heads.length === 1 && pending.length === 0)) return;
      // Ordinary unpublished edits must be pushed normally, preserving history.
      if (pending.length > 0 && !pending.some((entry) => (entry.parentRevisionIds?.length ?? 0) > 1)) return;
      const graph = await history.graph(mapping.fileId);
      let tip = local.revisionId;
      const lineage = ancestors(graph, tip);
      if (pending.some((entry) => !lineage.has(entry.revisionId))) return;
      let content = canonicalizeMarkdown(mapping.content);
      for (const head of heads) {
        const remoteId = head.revision.revisionId;
        if (ancestors(graph, tip).has(remoteId)) continue;
        const remote = await history.payload(head);
        if (remote.kind === 'binary' || remote.operation === 'delete' || remote.path !== mapping.path || remote.content === null) return;
        if (remote.content !== content) {
          // Two clients can independently author the same merge. Its shared
          // parents are incomparable, but an identical snapshot with the exact
          // same parent set proves a base for edits made on the rejected merge.
          const remoteParents = head.revision.parentRevisionIds ?? [];
          const equivalent = [...ancestors(graph, tip)].map((id) => graph.get(id)).find((event) => {
            const parents = event?.revision.parentRevisionIds ?? [];
            return event !== undefined && remoteParents.length > 1 &&
              event.revision.contentHash === head.revision.contentHash &&
              parents.length === remoteParents.length && parents.every((id) => remoteParents.includes(id));
          });
          const base = equivalent ?? commonAncestor(graph, tip, remoteId);
          if (base === null) return;
          const ancestor = await history.payload(base);
          if (ancestor.kind === 'binary' || ancestor.operation === 'delete' || ancestor.path !== mapping.path || ancestor.content === null) return;
          const merge = mergeText(ancestor.content, content, remote.content);
          if (merge.status !== 'merged') return;
          content = merge.text;
        }
        const previous = tip;
        tip = `reconcile:${tip}:${remoteId}`;
        graph.set(tip, { serverSequence: 0, revision: {
          fileId: mapping.fileId, revisionId: tip, contentHash: '', parentRevisionIds: [previous, remoteId],
        } });
      }
      if (canonicalizeMarkdown(mapping.content) !== content) return;
      // Awaited history reads must not authorize replacing a new local save.
      const disk = await files.readByPath(mapping.path);
      if (disk === null || canonicalizeMarkdown(disk) !== content) return;
      if ((await files.openBufferStates(mapping.fileId)).some((buffer) => buffer.unsaved)) return;
      const onlyHead = heads.length === 1 ? heads[0] : undefined;
      const adopted = onlyHead === undefined ? undefined : await history.payload(onlyHead);
      const existingRevisionId = adopted?.kind !== 'binary' && adopted?.operation !== 'delete' &&
        adopted?.path === mapping.path && adopted?.content === content ? onlyHead?.revision.revisionId : undefined;
      await producer.commitHeadResolution({
        mapping, expectedHead: local.revisionId,
        pendingIds: pending.map((entry) => entry.revisionId),
        parents: heads.map((head) => head.revision.revisionId),
        ...(existingRevisionId === undefined ? {} : { existingRevisionId }),
      });
    });
  }
}
