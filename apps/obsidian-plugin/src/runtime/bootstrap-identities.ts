import { canonicalizeMarkdown, hashBlob, hashPlaintext } from '@havemind/protocol';
import { bytesToBase64, classifyVaultPath, type VaultSnapshotPort } from '../obsidian/vault-adapter';
import type { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import type { DurableSyncState } from './sync-state';
import type { RevisionHistory } from './revision-history';

/** Establish identity before observers enumerate a populated vault. A divergent
 * untracked path remains visible locally and is held for explicit resolution;
 * it must not be silently published as a second, unrelated file. */
export async function bootstrapIdentities(options: {
  history: RevisionHistory; state: DurableSyncState;
  producer: OutboxLocalChangeRepository; vault: VaultSnapshotPort;
}): Promise<ReadonlySet<string>> {
  const { history, state, producer, vault } = options;
  await producer.recover();
  await history.refresh();
  const heads = await history.allHeads();
  const counts = new Map<string, number>();
  for (const head of heads) counts.set(head.revision.fileId, (counts.get(head.revision.fileId) ?? 0) + 1);
  const mapped = new Set((await producer.listMappings()).map((m) => m.collisionKey));
  const pending = await state.listOutbox();
  const blocked = new Set<string>();
  const candidates = [...heads].sort((a, b) => a.revision.fileId.localeCompare(b.revision.fileId));
  for (const head of candidates) {
    const remote = await history.payload(head);
    if (remote.operation === 'delete') continue;
    const path = classifyVaultPath(remote.path);
    if (!path.eligible || mapped.has(path.collisionKey) || !(await vault.exists(remote.path))) continue;
    blocked.add(path.collisionKey);
    // Existing queued work is left to its original identity and journal.
    if (pending.length > 0 || counts.get(head.revision.fileId) !== 1) continue;
    let content: string;
    let contentHash: string;
    if (remote.kind === 'binary') {
      if (vault.readBinary === undefined) continue;
      const bytes = await vault.readBinary(remote.path);
      contentHash = await hashBlob(bytes);
      if (remote.binaryContent == null || contentHash !== await hashBlob(remote.binaryContent)) continue;
      content = bytesToBase64(bytes);
    } else {
      content = canonicalizeMarkdown(await vault.readText(remote.path));
      if (content !== remote.content) continue;
      contentHash = await hashPlaintext(content);
    }
    // The producer mapping is the scan's completion marker. Write it last:
    // if a base save fails, a retry must finish the shared metadata instead of
    // skipping this path merely because its producer mapping already exists.
    await state.recordPathOwner(head.revision.fileId, path.canonicalPath);
    await state.recordBaseHash(head.revision.fileId, contentHash);
    if (remote.kind !== 'binary') await state.recordBaseContent(head.revision.fileId, content);
    await producer.adoptRemoteMapping({ fileId: head.revision.fileId, path: path.canonicalPath,
      collisionKey: path.collisionKey, content, contentHash,
      ...(remote.kind === 'binary' ? { contentKind: 'binary' } : {}),
    }, head.revision.revisionId);
    mapped.add(path.collisionKey);
    blocked.delete(path.collisionKey);
  }
  return blocked;
}
