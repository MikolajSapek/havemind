/**
 * Turning an already-connected pairing into a RUNNING sync loop, and the handle
 * the plugin holds it by. This is where the access-token provider, the shared
 * fileId↔path↔base store, the one per-file lock that makes producing and applying
 * mutually exclusive, the one-time canonicalization rebase and the push producer
 * are ordered relative to each other, an ordering the data-safety rules depend
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
import { gateLocalSyncState } from './local-state-gate';
import { startPushProducer, createPushProducerRepository, type PushProducerHandle } from './push-producer';
import { createRequestUrlFn } from './request-url';
import type { RuntimeHooks } from './runtime-hooks';
import { buildSyncController } from './sync-controller';
import {
  generateRefreshTokenValue,
  generateRotationIdValue,
} from './tokens';
import { HAVEMIND_STATUS_RECOVERY_REQUIRED } from './status-constants';

export interface ConnectionHandle {
  stop(): void;
  /** Human-readable server name for the Connect panel (empty when disconnected). */
  readonly serverName: string;
  /** API base the live sync loop talks to; absent on the no-op handle. */
  readonly apiBaseUrl?: string;
  /** Vault id the live sync loop is bound to; absent on the no-op handle. */
  readonly vaultId?: string;
  /** Mints/reuses the live access token; null means authentication failed. */
  readonly getAccessToken?: () => Promise<string | null>;
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
   * `path` against the current on-disk content, the only recovery for a row
   * that never reached the outbox. Returns a tri-state (FINDING 1): `file-missing`
   * (drop the stale row), `unavailable` (retry could not run, keep the row), or
   * `retriggered`. Absent on the no-op handle and whenever no producer started
   * (no push identity), which is also when no failed-to-queue row can exist.
   */
  readonly retryFailedCommit?: (path: string) => RetryFailedCommitOutcome;
}

export const NOOP_HANDLE: ConnectionHandle = {
  stop: () => undefined,
  serverName: '',
};

function serverNameFromUrl(apiBaseUrl: string): string {
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
  // AUD-12 fail-closed gate. It runs before transport/controller construction,
  // controller.start(), and vault listener registration. A paired device that
  // lost its cursor or producer identity therefore performs zero network and
  // zero vault mutations instead of replaying history from sequence zero.
  const localStateGate = gateLocalSyncState(await plugin.loadData());
  if (localStateGate.kind === 'recovery-required') {
    console.error(
      `Havemind: local sync state recovery required (${localStateGate.reason}); sync was not started.`,
    );
    onStatus('recovery-required', HAVEMIND_STATUS_RECOVERY_REQUIRED);
    return {
      ...NOOP_HANDLE,
      apiBaseUrl: connection.apiBaseUrl,
      vaultId: connection.vaultId,
      serverName: serverNameFromUrl(connection.apiBaseUrl),
    };
  }
  // A bootstrap that was interrupted part-way (a long join backgrounded by iOS)
  // is safe to finish, it is only the connect-time reconcile that must sit this
  // session out. See `local-state-gate.ts`.
  const resumingBootstrap = localStateGate.kind === 'resume-bootstrap';

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

  // Bind the producer repository BEFORE the first pull so bootstrap adopts each
  // materialised head into the mapping. Without this, syncNow writes the vault
  // while producerRef is still null, connect-time reconcile treats every note as
  // a fresh local create, and an empty phone fills Havemind Conflicts.
  if (hasPushIdentity) {
    producerRef.current = createPushProducerRepository({
      plugin,
      state,
      identity: {
        vaultId: connection.vaultId,
        memberId: connection.memberId as string,
        deviceId: connection.deviceId as string,
      },
    });
  }

  // AUD-03 PART 2, one-time migration. BEFORE the first sync cycle, rebase any
  // persisted base hashes / producer-mapping content hashes that were computed
  // under the OLD canonicalization to the NEW canonical form, so the first pull
  // does not read stale hashes and mint spurious revisions / conflict artifacts
  // for files whose bytes differ only by a trailing newline or BOM. A version
  // marker in plugin data makes this run exactly once.
  await runCanonicalizationRebase(plugin);

  // Finish one pull before the producer enumerates the local vault. On a fresh
  // or recovered phone this lets SyncRunner's cursor-zero bootstrap reduce the
  // server history to terminal heads first; otherwise the local reconciliation
  // races the historical pull and may mint duplicate fileIds for paths the pull
  // is about to adopt. An offline cycle returns normally, so local observation
  // still starts and preserves edits while the controller retries.
  await controller.syncNow();

  // The push producer detects local edits, enumerates pre-existing files and
  // enqueues revisions the runner POSTs. Without a server-issued memberId +
  // deviceId a revision header cannot be built (rule 3), so the producer only
  // starts once both are known, both the invitee flow and the owner /owner/pair
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
      // An interrupted bootstrap left heads on disk that never reached the
      // producer mapping. The `syncNow` above has just re-run and converged them;
      // letting reconcile enumerate the vault in the same session would push them
      // back as fresh local creates (see the gate's `resume-bootstrap`).
      resumingBootstrap ? { skipInitialReconcile: true } : undefined,
    );
  }

  // Arm focus/online/interval/push only after the initial pull and producer
  // construction. start() fires its normal immediate cycle; by then both sides
  // share the settled bootstrap mapping and cannot race first materialisation.
  controller.start();

  // The local member's own persistent roster entry, when the server issued a
  // membership id. Presence is connection state, so this is recorded once and
  // stays connected until an explicit teardown.
  const selfMembership =
    connection.memberId === undefined
      ? undefined
      : { membershipId: connection.memberId, role: extras.role ?? 'editor' };

  return {
    ...(selfMembership === undefined ? {} : { selfMembership }),
    apiBaseUrl: connection.apiBaseUrl,
    vaultId: connection.vaultId,
    getAccessToken: async () => {
      try {
        return await accessProvider.getAccessToken();
      } catch {
        return null;
      }
    },
    // The live durable state, so the plugin can read the send-queue (SND-01) and
    // drive the auto-repair sweep (MRG-05) off the same store the runner uses.
    state,
    // Tearing the producer's vault listeners down on stop is critical: a re-pair
    // (or reconnect) calls stop() on the previous handle before starting a new
    // one, and without this the prior-session observer stays attached and keeps
    // enqueuing revisions stamped with the OLD identity alongside the new one,
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
