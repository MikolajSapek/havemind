/**
 * Fail-closed startup gate for a previously used sync client.
 *
 * A missing cursor or producer identity is not an instruction to replay the
 * server log from zero. On a paired phone that replay meets already-present
 * vault files and turns historical creates (often empty) into a conflict burst.
 * This pure classifier runs before the controller, network transport and vault
 * listeners exist, so a suspicious local snapshot can only stop, never mutate.
 */

import { parseProducerStateResult } from './producer-state';
import { isRecord } from './shared';

export type LocalSyncStateRecoveryReason =
  | 'missing-sync-state'
  | 'missing-producer-state'
  | 'corrupt-sync-state'
  | 'corrupt-producer-state'
  | 'cursor-reset';

export type LocalSyncStateGate =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'recovery-required';
      readonly reason: LocalSyncStateRecoveryReason;
    };

interface SyncEvidence {
  readonly cursor: number;
  readonly locallyAuthoredCount: number;
  readonly outboxCount: number;
  readonly ownedPathCount: number;
}

function parseSyncEvidence(raw: unknown): SyncEvidence | null {
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.cursor) ||
    (raw.cursor as number) < 0 ||
    !Array.isArray(raw.outbox) ||
    !Array.isArray(raw.locallyAuthored) ||
    !Array.isArray(raw.deferred)
  ) {
    return null;
  }
  return {
    cursor: raw.cursor as number,
    locallyAuthoredCount: raw.locallyAuthored.length,
    outboxCount: raw.outbox.length,
    ownedPathCount: isRecord(raw.pathOwners) ? Object.keys(raw.pathOwners).length : 0,
  };
}

function producerHasHistory(
  state: ReturnType<typeof parseProducerStateResult>['state'],
): boolean {
  return state.mappings.length > 0 || Object.keys(state.heads).length > 0;
}

function syncHasHistory(evidence: SyncEvidence): boolean {
  return (
    evidence.cursor > 0 ||
    evidence.locallyAuthoredCount > 0 ||
    evidence.outboxCount > 0 ||
    evidence.ownedPathCount > 0
  );
}

export function gateLocalSyncState(rawData: unknown): LocalSyncStateGate {
  const data = isRecord(rawData) ? rawData : {};
  const rawSync = data.syncState;
  const rawBackup = data['syncState.bak'];
  const rawProducer = data.pushProducer;

  const syncAbsent = rawSync === null || rawSync === undefined;
  const producerAbsent = rawProducer === null || rawProducer === undefined;

  // Neither container exists on a genuine first connection. There is no prior
  // cursor or file identity to lose, so bootstrap is the intended behaviour.
  if (syncAbsent && producerAbsent) return { kind: 'allow' };

  let sync = syncAbsent ? null : parseSyncEvidence(rawSync);
  if (!syncAbsent && sync === null) {
    // DurableSyncState can recover a corrupt primary from its previous-good
    // backup. Let that existing recovery path run when the backup is healthy.
    sync = parseSyncEvidence(rawBackup);
    if (sync === null) {
      return { kind: 'recovery-required', reason: 'corrupt-sync-state' };
    }
  }

  const producer = parseProducerStateResult(rawProducer);
  if (!producerAbsent && producer.status === 'corrupt') {
    return { kind: 'recovery-required', reason: 'corrupt-producer-state' };
  }

  if (syncAbsent) {
    return producerHasHistory(producer.state)
      ? { kind: 'recovery-required', reason: 'missing-sync-state' }
      : { kind: 'allow' };
  }
  if (producerAbsent) {
    return sync !== null && syncHasHistory(sync)
      ? { kind: 'recovery-required', reason: 'missing-producer-state' }
      : { kind: 'allow' };
  }

  // A legitimate cursor-zero producer can exist briefly while its authored
  // revision is queued or waiting for its echo; the durable outbox/authorship
  // proves that lineage. Cursor zero with established producer heads but none of
  // that sync evidence is the characteristic emptyState() reset from the field
  // incident, and replaying from it is unsafe.
  if (
    sync !== null &&
    sync.cursor === 0 &&
    producerHasHistory(producer.state) &&
    sync.locallyAuthoredCount === 0 &&
    sync.outboxCount === 0 &&
    sync.ownedPathCount === 0
  ) {
    return { kind: 'recovery-required', reason: 'cursor-reset' };
  }

  return { kind: 'allow' };
}
