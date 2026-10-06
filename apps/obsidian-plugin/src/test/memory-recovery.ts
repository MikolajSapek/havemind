/**
 * An in-memory `ProducerRecoveryPort` for tests that do not run the durable
 * sync state: it journals records, hands every queued envelope to `enqueue`,
 * the way `DurableSyncState` writes it to its outbox, and, given the test's
 * producer store, writes a commit's files and heads into it in the same call
 * (A1: production does both in one write).
 */

import {
  mappingMetadata,
  type ProducerRecovery,
  type ProducerRecoveryPort,
} from '../runtime/producer-recovery';
import type { OutboxEnvelope } from '../runtime/sync-state';
import type { ProducerState } from '../sync/outbox-repository';

export function memoryRecovery(
  enqueue: (envelope: OutboxEnvelope) => unknown = () => undefined,
  store?: { state: ProducerState },
): ProducerRecoveryPort {
  const pending = new Map<string, ProducerRecovery>();
  const replay = (record: ProducerRecovery): void => {
    if (store === undefined) return;
    const ids = new Set(record.fileIds);
    store.state = {
      mappings: [...store.state.mappings.filter((m) => !ids.has(m.fileId)), ...record.state.mappings.map(mappingMetadata)],
      heads: { ...Object.fromEntries(Object.entries(store.state.heads).filter(([id]) => !ids.has(id))), ...record.state.heads },
    };
  };
  return {
    async startProducerRecovery(record, replacement) {
      pending.set(record.id, record);
      if (replacement !== undefined) await enqueue(replacement);
      return true;
    },
    async commitProducerChange(record, replacement) {
      if (replacement !== undefined) await enqueue(replacement);
      replay(record);
      return true;
    },
    pendingProducerRecoveries: async () => [...pending.values()],
    recoverProducerQueue: async (id) => {
      const record = pending.get(id);
      if (record === undefined) return;
      replay(record);
      pending.delete(id);
    },
    completeProducerRecovery: async (id) => {
      pending.delete(id);
    },
    enqueueAutomaticMerge: async (envelope) => {
      await enqueue(envelope);
    },
  };
}
