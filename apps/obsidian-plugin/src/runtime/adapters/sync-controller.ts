/**
 * Assembly of the full sync runtime for an already-connected vault: durable
 * state, transport, vault-apply adapter, runner, the optional real-time push
 * subscription and the controller that owns them. This is the one place the
 * pieces are wired together, so it is also where the connect-safety rules live —
 * a push-setup failure degrades to poll-only rather than aborting the build, and
 * every optional seam (activity hooks, producer sync, per-file lock) is omitted
 * rather than passed as undefined so `exactOptionalPropertyTypes` holds.
 */

import { Notice, type Plugin } from 'obsidian';

import { hashPlaintext } from '@havemind/protocol';
import type { DecodedRevisionPayload } from '@havemind/sync-core';

import { SyncRunner, type RemoteEvent } from '../../sync/sync-runner';
import { remoteAppliedToActivityEntryOrNull } from '../activity-log';
import { CONFLICT_FOLDER } from '../conflict-resolution';
import { HavemindSyncController, type StatusListener } from '../controller';
import type { KeyedMutex } from '../keyed-mutex';
import { DurableSyncState } from '../sync-state';
import { RequestUrlTransport } from '../sync-transport';
import {
  VaultApplyAdapter,
  type RemoteAppliedEvent,
  type RemoteApplyProducerSync,
} from '../vault-apply';
import { WakeSubscription } from '../wake-subscription';

import { createConfigApplyReloader } from './config-apply';
import { createOutboxPayloadStore, createPersistPort } from './plugin-data-ports';
import { createRequestUrlFn } from './request-url';
import type { RuntimeHooks } from './runtime-hooks';
import { createBackoffScheduler, createSchedulerHooks } from './scheduler-hooks';
import type { AppWithVault } from './shared';
import { createVaultFilePort } from './vault-file-port';

const DEFAULT_INTERVAL_MS = 15 * 1000;
/**
 * Poll cadence while the real-time push channel is connected. The long-poll
 * `WakeSubscription` delivers peer changes within a round-trip, so the periodic
 * poll degrades to this slow heartbeat and reverts to `DEFAULT_INTERVAL_MS` when
 * push is down.
 */
const PUSH_CONNECTED_INTERVAL_MS = 60_000;

export interface SyncConnection {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
  readonly serverEpoch?: () => string | null;
  readonly intervalMs?: number;
  /**
   * The live push identity (server membership + device) for this connection.
   * When present, the transport re-stamps it onto every outbound revision header
   * so a revision built under a prior-session identity can never ship a stale
   * actor and 403 the whole request (rule 3). Absent when no push identity is
   * known yet, in which case the producer never starts and the outbox is empty.
   */
  readonly pushIdentity?: { readonly memberId: string; readonly deviceId: string };
}

export interface BuiltSyncController {
  readonly controller: HavemindSyncController;
  readonly state: DurableSyncState;
}

/**
 * Assembles the full sync runtime for a connected vault and returns a controller
 * `main.ts` can `start()` on layout-ready and `stop()` on unload.
 */
export function buildSyncController(
  plugin: Plugin,
  connection: SyncConnection,
  onStatus: StatusListener,
  hooks?: RuntimeHooks,
  producerSync?: RemoteApplyProducerSync,
  fileApplyLock?: KeyedMutex,
): BuiltSyncController {
  const state = new DurableSyncState({
    persist: createPersistPort(plugin),
    // Arch P1: keep large outbox payload bytes out of `data.json`. Best-effort —
    // degrades to inline when IndexedDB is unavailable (see the factory).
    payloadStore: createOutboxPayloadStore(plugin),
  });

  const transport = new RequestUrlTransport({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connection.apiBaseUrl,
    vaultId: connection.vaultId,
    getAuthToken: connection.getAuthToken,
    resolveEnvelope: (revisionId) => state.peekEnvelope(revisionId),
    ...(connection.serverEpoch === undefined
      ? {}
      : { serverEpoch: connection.serverEpoch }),
    ...(connection.pushIdentity === undefined
      ? {}
      : {
          identity: {
            vaultId: connection.vaultId,
            memberId: connection.pushIdentity.memberId,
            deviceId: connection.pushIdentity.deviceId,
          },
        }),
  });

  const vault = new VaultApplyAdapter({
    files: createVaultFilePort({
      vault: (plugin.app as unknown as AppWithVault).vault,
      state,
      // A remotely-applied appearance file used to stay INVISIBLE until the
      // receiving device restarted Obsidian, because Obsidian caches its config
      // in memory and the plugin never signalled a reload. `css-change` is the
      // documented workspace event that makes it re-read snippets and themes.
      configApply: createConfigApplyReloader({
        triggerCssChange: () => {
          plugin.app.workspace.trigger?.('css-change');
        },
        notify: (message) => {
          new Notice(message);
        },
      }),
    }),
    conflictFolder: CONFLICT_FOLDER,
    resolveRevision: connection.resolveRevision,
    // AUD-03: the apply-side base hash must be computed over the SAME canonical
    // content form the push producer uses (`hashPlaintext` = SHA-256 over
    // `canonicalizeMarkdown`), so a base seeded by a local push and an on-disk
    // read compare on equal terms. Never the raw token digest below.
    hashContent: (content) => hashPlaintext(content),
    // FIX 1: a genuinely applied remote revision (never 'noop'/'conflict')
    // reaches the Activity feed too, attributed to `remote` — previously only
    // the local-change wrapper ever recorded an entry, so the other device's
    // edits never showed up.
    ...(hooks?.onRemoteActivity === undefined
      ? {}
      : {
          onRemoteApplied: (event: RemoteAppliedEvent) => {
            // A bootstrap apply (the initial catch-up materialising a pre-existing
            // vault) is collapsed to silence so the feed is not flooded with one
            // row per file; a live peer edit records a normal entry.
            const entry = remoteAppliedToActivityEntryOrNull(event, Date.now());
            if (entry !== null) {
              hooks.onRemoteActivity?.(entry);
            }
          },
        }),
    // FIX 2 (re-entrancy): keep the push producer's mapping in lockstep with
    // apply writes so the reflected vault event is deduped, never re-pushed,
    // re-attributed, or given a fresh fileId.
    ...(producerSync === undefined ? {} : { producerSync }),
    // MRG-05: signal a debounced auto-repair sweep whenever a NEW conflict copy
    // lands (never on an idempotent rewrite — no self-retrigger).
    ...(hooks?.onConflictWritten === undefined
      ? {}
      : { onConflictWritten: hooks.onConflictWritten }),
    // TOCTOU close (rule 3): the SAME per-file lock the push producer holds, so
    // a local write can never land and be clobbered between apply's read and its
    // write for one file. Different files still apply/produce concurrently.
    ...(fileApplyLock === undefined ? {} : { lock: fileApplyLock }),
  });

  // Late-bound so the runner can report every cycle — including the retries it
  // drives itself through backoff — to the controller. Without this a recovery
  // reached only via backoff would never clear a stale offline status because
  // the controller re-observes on its own schedule only every few minutes.
  const controllerRef: { current?: HavemindSyncController } = {};

  const runner = new SyncRunner({
    transport,
    state,
    vault,
    scheduler: createBackoffScheduler(),
    onCycleComplete: (result) => controllerRef.current?.observeCycle(result),
  });

  // Real-time push: a held long-poll on the server's wait endpoint wakes the
  // sync loop the moment a peer advances the log, instead of waiting up to a
  // whole poll interval. Callbacks are late-bound through `controllerRef` (the
  // controller is built just below), matching the runner's `onCycleComplete`
  // wiring. While push is connected the controller degrades the poll to a slow
  // heartbeat; it reverts to `DEFAULT_INTERVAL_MS` when push drops.
  //
  // CONNECT-SAFE: push is strictly additive to the poll. If constructing the
  // subscription throws for any reason, the connect/sync path must still proceed
  // poll-only — a push-setup failure must never abort building the controller.
  // So the construction is wrapped and, on failure, the controller is built with
  // no `wake` (poll-only fallback) and the reason is logged.
  let wake: WakeSubscription | undefined;
  try {
    wake = new WakeSubscription({
      requestUrl: createRequestUrlFn(),
      apiBaseUrl: connection.apiBaseUrl,
      vaultId: connection.vaultId,
      getAuthToken: connection.getAuthToken,
      loadCursor: () => state.loadCursor(),
      onWake: () => {
        void controllerRef.current?.syncNow();
      },
      onConnectedChange: (connected) => {
        controllerRef.current?.setPushConnected(connected);
      },
    });
  } catch (error) {
    wake = undefined;
    console.error(
      'Havemind: real-time push setup failed; continuing poll-only',
      error,
    );
  }

  const controller = new HavemindSyncController({
    runner,
    hooks: createSchedulerHooks(plugin),
    intervalMs: connection.intervalMs ?? DEFAULT_INTERVAL_MS,
    onStatus,
    // Push is optional: omit `wake` entirely on the poll-only fallback path so
    // the controller never tries to start a subscription that failed to build.
    ...(wake === undefined
      ? {}
      : { wake, pushConnectedIntervalMs: PUSH_CONNECTED_INTERVAL_MS }),
  });
  controllerRef.current = controller;

  return { controller, state };
}
