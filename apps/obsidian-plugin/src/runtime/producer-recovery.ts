import type { ProducerState } from '../sync/outbox-repository';
import type { OutboxEnvelope } from './sync-state';

/** A replayable patch to the shared producer document, preserving other files. */
export interface ProducerRecovery {
  readonly id: string;
  readonly kind: 'apply' | 'resolution';
  readonly applyState?: {
    readonly pathOwners: Readonly<Record<string, string>>;
    readonly baseHashes: Readonly<Record<string, string>>;
    readonly baseContents: Readonly<Record<string, string>>;
  };
  readonly fileIds: readonly string[];
  // Only unfinished forward commits need a snapshot. Keep the legacy journal
  // shape readable; steady-state producer mappings contain metadata alone.
  readonly state: Omit<ProducerState, 'mappings'> & {
    readonly mappings: readonly (ProducerState['mappings'][number] & { readonly content?: string })[];
  };
  readonly discardRevisionIds: readonly string[];
}
export interface ProducerRecoveryPort {
  startProducerRecovery(record: ProducerRecovery, replacement?: OutboxEnvelope): Promise<boolean>;
  pendingProducerRecoveries(): Promise<readonly ProducerRecovery[]>;
  recoverProducerQueue(id: string): Promise<void>;
  completeProducerRecovery(id: string): Promise<void>;
  enqueueAutomaticMerge(envelope: OutboxEnvelope): Promise<void>;
}

export function validRecovery(value: unknown): value is ProducerRecovery {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
  if (typeof row.id !== 'string' || !row.id || !['apply', 'resolution'].includes(String(row.kind)) ||
    !strings(row.fileIds) || !strings(row.discardRevisionIds) || typeof row.state !== 'object' || row.state === null) return false;
  if (row.applyState !== undefined) {
    if (typeof row.applyState !== 'object' || row.applyState === null) return false;
    const saved = row.applyState as Record<string, unknown>;
    if (!['pathOwners', 'baseHashes', 'baseContents'].every((key) =>
      typeof saved[key] === 'object' && saved[key] !== null && !Array.isArray(saved[key]) &&
      Object.values(saved[key] as object).every((value) => typeof value === 'string'))) return false;
  }
  const state = row.state as Record<string, unknown>;
  if (!Array.isArray(state.mappings) || typeof state.heads !== 'object' || state.heads === null || Array.isArray(state.heads)) return false;
  return Object.entries(state.heads).every(([id, head]) => row.fileIds instanceof Array && row.fileIds.includes(id) && typeof head === 'string') &&
    state.mappings.every((m: unknown) => {
      if (typeof m !== 'object' || m === null) return false;
      const item = m as Record<string, unknown>;
      return ['fileId', 'path', 'collisionKey', 'contentHash'].every((key) => typeof item[key] === 'string') &&
        (row.kind !== 'resolution' || item.contentKind === 'binary' || typeof item.content === 'string') &&
        (row.fileIds as string[]).includes(item.fileId as string) &&
        (item.contentKind === undefined || item.contentKind === 'markdown' || item.contentKind === 'binary');
    });
}
