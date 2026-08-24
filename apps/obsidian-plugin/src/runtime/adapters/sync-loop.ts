/**
 * Turning an already-connected pairing into a RUNNING sync loop, and the handle
 * the plugin holds it by. This is where the access-token provider, the shared
 * fileId↔path↔base store, the one per-file lock that makes producing and applying
 * mutually exclusive, the one-time canonicalization rebase and the push producer
 * are ordered relative to each other — an ordering the data-safety rules depend
 * on. The returned handle's `stop()` is equally load-bearing: it must dispose the
 * producer, or a re-pair leaves a prior-session observer enqueuing under a stale
 * identity alongside the new one.
 */

import type { Plugin } from 'obsidian';

import type { OutboxLocalChangeRepository } from '../../sync/outbox-repository';
import { ensureClientInstanceId } from '../../storage/client-store';
import { RefreshTokenAccessProvider } from '../access-token';
import type { RetryFailedCommitOutcome } from '../commit-recovery';
import { buildConnectionResolvers } from '../connection';
import type { StatusListener } from '../controller';
import { KeyedMutex } from '../keyed-mutex';
import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { createRemoteApplyProducerSync } from '../remote-apply-coordinator';
import type { MemberRole } from '../roster';
import type { DurableSyncState } from '../sync-state';

import type { StoredConnection } from './owner-connection';
import {
  createClientInstanceRepo,
  runCanonicalizationRebase,
} from './plugin-data-ports';
import { startPushProducer, type PushProducerHandle } from './push-producer';
import { createRequestUrlFn } from './request-url';
import type { RuntimeHooks } from './runtime-hooks';
import { buildSyncController } from './sync-controller';
import {
  generateRefreshTokenValue,
  generateRotationIdValue,
} from './tokens';

export interface ConnectionHandle {
  stop(): void;
  /** Human-readable server name for the Connect panel (empty when disconnected). */
  readonly serverName: string;
  /**
   * The local user's own membership for the presence roster, when known. The
   * plugin records this as the persistent "self" roster entry. Absent when no
   * server membership id is known yet (e.g. a not-yet-connected shell).
   */
  readonly selfMembership?: { readonly membershipId: string; readonly role: MemberRole };
  /**
   * The live durable sync state (SND-01 + MRG-05). The plugin reads outbox ages
   * + quarantine for the send-queue panel and the persisted merge bases for the
   * auto-repair sweep, and requeues/discards quarantined sends through it.
   * Absent on the no-op handle (nothing connected).
   */
  readonly state?: DurableSyncState;
  /**
   * Retry a failed-to-queue row (MAJOR 2) by re-running the commit chain for
   * `path` against the current on-disk content — the only recovery for a row
   * that never reached the outbox. Returns a tri-state (FINDING 1): `file-missing`
   * (drop the stale row), `unavailable` (retry could not run — keep the row), or
   * `retriggered`. Absent on the no-op handle and whenever no producer started
   * (no push identity), which is also when no failed-to-queue row can exist.
   */
  readonly retryFailedCommit?: (path: string) => RetryFailedCommitOutcome;
}

export const NOOP_HANDLE: ConnectionHandle = {
  stop: () => undefined,
  serverName: '',
};

export function serverNameFromUrl(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
}

/** Extra wiring for a started sync loop: the local role + live UI hooks. */
interface SyncLoopExtras {
  /** The local user's role for their own roster entry. */
  readonly role?: MemberRole;
  readonly hooks?: RuntimeHooks;
}

/** Builds and starts the live sync loop for an already-connected vault. */
export async function startSyncLoop(
  plugin: Plugin,
  connection: StoredConnection,
  onStatus: StatusListener,
  extras: SyncLoopExtras = {},
): Promise<ConnectionHandle> {
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connection.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
    // Durable in-flight rotation persistence. A failed load or save is
    // fail-closed: minting an unrecoverable rotation could burn the token family.
    loadPendingRotation: () => secrets.getPendingRotation(),
    savePendingRotation: (record) => secrets.savePendingRotation(record),
    clearPendingRotation: () => secrets.clearPendingRotation(),
  });
  const resolvers = buildConnectionResolvers({
    apiBaseUrl: connection.apiBaseUrl,
    vaultId: connection.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
    requestUrl: createRequestUrlFn(),
  });
  const hasPushIdentity =
    connection.memberId !== undefined && connection.deviceId !== undefined;
  // One shared fileId↔path↔base truth: the apply adapter drives the producer's
  // mapping through this late-bound coordinator (the producer is created after
  // the controller). Until the producer exists (or when there is no push
  // identity) the coordinator is inert.
  const producerRef: { current: OutboxLocalChangeRepository | null } = {
    current: null,
  };
  const producerSync = createRemoteApplyProducerSync(() => producerRef.current);
  // ONE per-file lock shared by remote apply (in the controller) and the local
  // change producer, so a file can never be produced and applied concurrently
  // (rule 3 TOCTOU close). Distinct files still sync in parallel.
  const fileApplyLock = new KeyedMutex();
  const { controller, state } = buildSyncController(
    plugin,
    {
      apiBaseUrl: resolvers.apiBaseUrl,
      vaultId: resolvers.vaultId,
      getAuthToken: resolvers.getAuthToken,
      resolveRevision: resolvers.resolveRevision,
      // Re-stamp the live identity onto every outbound header so a revision that
      // a prior-session producer enqueued can never ship a stale actor (rule 3).
      ...(hasPushIdentity
        ? {
            pushIdentity: {
              memberId: connection.memberId as string,
              deviceId: connection.deviceId as string,
            },
          }
        : {}),
    },
    onStatus,
    extras.hooks,
    producerSync,
    fileApplyLock,
  );

  // AUD-03 PART 2 — one-time migration. BEFORE the first sync cycle, rebase any
  // persisted base hashes / producer-mapping content hashes that were computed
  // under the OLD canonicalization to the NEW canonical form, so the first pull
  // does not read stale hashes and mint spurious revisions / conflict artifacts
  // for files whose bytes differ only by a trailing newline or BOM. A version
  // marker in plugin data makes this run exactly once.
  await runCanonicalizationRebase(plugin);

  controller.start();

  // The push producer detects local edits, enumerates pre-existing files and
  // enqueues revisions the runner POSTs. Without a server-issued memberId +
  // deviceId a revision header cannot be built (rule 3), so the producer only
  // starts once both are known — both the invitee flow and the owner /owner/pair
  // flow supply memberId + deviceId (connectAsOwner reads `pairing.memberId`
  // off the pairing response), so `hasPushIdentity` is true for either path.
  let producer: PushProducerHandle | null = null;
  if (hasPushIdentity) {
    producer = startPushProducer(
      plugin,
      state,
      {
        vaultId: connection.vaultId,
        memberId: connection.memberId as string,
        deviceId: connection.deviceId as string,
      },
      () => {
        void controller.syncNow();
      },
      producerRef,
      extras.hooks,
      fileApplyLock,
    );
  }

  // The local member's own persistent roster entry, when the server issued a
  // membership id. Presence is connection state, so this is recorded once and
  // stays connected until an explicit teardown.
  const selfMembership =
    connection.memberId === undefined
      ? undefined
      : { membershipId: connection.memberId, role: extras.role ?? 'editor' };

  return {
    ...(selfMembership === undefined ? {} : { selfMembership }),
    // The live durable state, so the plugin can read the send-queue (SND-01) and
    // drive the auto-repair sweep (MRG-05) off the same store the runner uses.
    state,
    // Tearing the producer's vault listeners down on stop is critical: a re-pair
    // (or reconnect) calls stop() on the previous handle before starting a new
    // one, and without this the prior-session observer stays attached and keeps
    // enqueuing revisions stamped with the OLD identity alongside the new one —
    // the exact mix of accepted (current identity) and 403-rejected (stale
    // identity) pushes. Disposing here guarantees exactly one live producer.
    stop: () => {
      controller.stop();
      producer?.dispose();
    },
    // MAJOR 2: the panel routes Retry on a failed-to-queue row here so the
    // commit chain re-runs from disk. Absent when no producer started (no push
    // identity), which is also when no failed-to-queue row can exist.
    ...(producer === null
      ? {}
      : { retryFailedCommit: producer.retryFailedCommit }),
    serverName: serverNameFromUrl(connection.apiBaseUrl),
  };
}
