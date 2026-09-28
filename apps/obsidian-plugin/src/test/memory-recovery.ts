/**
 * An in-memory `ProducerRecoveryPort` for tests that do not run the durable
 * sync state: it journals records and hands every queued envelope to
 * `enqueue`, the way `DurableSyncState` writes it to its outbox.
 */

import type { ProducerRecovery, ProducerRecoveryPort } from '../runtime/producer-recovery';
import type { OutboxEnvelope } from '../runtime/sync-state';

export function memoryRecovery(
  enqueue: (envelope: OutboxEnvelope) => unknown = () => undefined,
): ProducerRecoveryPort {
  const pending = new Map<string, ProducerRecovery>();
  return {
    async startProducerRecovery(record, replacement) {
      pending.set(record.id, record);
      if (replacement !== undefined) await enqueue(replacement);
      return true;
    },
    pendingProducerRecoveries: async () => [...pending.values()],
    recoverProducerQueue: async () => undefined,
    completeProducerRecovery: async (id) => {
      pending.delete(id);
    },
    enqueueAutomaticMerge: async (envelope) => {
      await enqueue(envelope);
    },
  };
}
