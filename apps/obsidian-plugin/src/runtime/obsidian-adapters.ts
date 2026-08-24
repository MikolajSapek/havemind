/**
 * Platform glue: binds the real Obsidian runtime APIs to the injectable ports
 * the tested runtime adapters consume. This is the one module that talks to
 * `requestUrl`, the Vault, workspace events and `saveData` directly, so it is
 * exercised in the live pilot rather than in unit tests (excluded from the
 * coverage gate). The logic it wires up — transport, durable state, vault apply,
 * scheduler, status, controller — is all unit-tested in this folder.
 *
 * `buildSyncController` is the entry point `main.ts` calls once a vault is
 * connected. It never runs while the plugin is merely loaded-but-disconnected,
 * so the passive desktop shell keeps doing zero networking and zero scanning.
 *
 * The implementation now lives in cohesive modules under `adapters/`, and this
 * file is a FAÇADE that re-exports exactly the surface it always exported, so
 * `main.ts` and every other importer compile unchanged. Nothing under
 * `adapters/` imports this file — the graph runs strictly one way, from the
 * façade down — so adding a module here never risks an import cycle. Grouped
 * below by the seam each module owns:
 *
 *  - `adapters/shared.ts` / `adapters/plugin-data-keys.ts` — internals shared by
 *    several seams (the Vault shape, the record guard, the `data.json` key
 *    namespace). Not re-exported: they were never part of this module's surface.
 *  - `adapters/request-url.ts` — Obsidian's `requestUrl` as a transport port.
 *  - `adapters/plugin-data-ports.ts` — every `loadData`/`saveData`-backed port.
 *  - `adapters/config-apply.ts` — making a remotely-applied config file visible.
 *  - `adapters/config-poll.ts` — the config-poll tick and its failure policy.
 *  - `adapters/vault-file-port.ts` — the apply path's live-Vault file port.
 *  - `adapters/scheduler-hooks.ts` — timer and window-event seams.
 *  - `adapters/status-constants.ts` — the two pre-rendered terminal status views.
 *  - `adapters/runtime-hooks.ts` — the UI-observation contract.
 *  - `adapters/sync-controller.ts` — full sync-runtime assembly.
 *  - `adapters/producer-state.ts` — parsing the persisted producer blob.
 *  - `adapters/vault-change-listeners.ts` — vault listener registration/teardown.
 *  - `adapters/push-producer.ts` — local-change detection wired to the outbox.
 *  - `adapters/owner-connection.ts` — the persisted owner pairing and its gate.
 *  - `adapters/onboarding-wiring.ts` — onboarding controller + connected-vault
 *    resolution.
 *  - `adapters/sync-loop.ts` — a connected pairing turned into a running loop.
 *  - `adapters/connect-flows.ts` — resume-on-load and connect-from-input.
 *  - `adapters/owner-actions.ts` / `adapters/rejoin-wiring.ts` — the
 *    owner-authenticated one-shot actions and invitee rejoin.
 *  - `adapters/tokens.ts` — branded-token and SHA-256 primitives.
 */

/**
 * The reserved conflict folder, imported from its single definition rather than
 * re-typed. Re-exported so the drift regression test can prove all three
 * reserved-folder sites resolve to ONE constant (see `conflict-resolution.ts`).
 */
export { CONFLICT_FOLDER } from './conflict-resolution';

export { SyncScheduler } from './scheduler';

export type { RuntimeHooks } from './adapters/runtime-hooks';

export {
  classifyConfigApplyEffect,
  CONFIG_RELOAD_NOTICE,
  createConfigApplyReloader,
  type ConfigApplyEffect,
  type ConfigApplyReloader,
  type ConfigApplyReloaderOptions,
} from './adapters/config-apply';

export { createRequestUrlFn } from './adapters/request-url';

export {
  createPersistPort,
  preserveCorruptProducerState,
} from './adapters/plugin-data-ports';

export {
  createBackoffScheduler,
  createSchedulerHooks,
  type SchedulerEventTarget,
} from './adapters/scheduler-hooks';

export {
  createVaultFilePort,
  type VaultFilePortOptions,
} from './adapters/vault-file-port';

export {
  buildSyncController,
  type BuiltSyncController,
  type SyncConnection,
} from './adapters/sync-controller';

export {
  HAVEMIND_STATUS_DISCONNECTED,
  HAVEMIND_STATUS_RESET_REQUIRED,
} from './adapters/status-constants';

export { buildOnboardingController } from './adapters/onboarding-wiring';

export {
  evaluateOwnerConnection,
  gateOwnerConnection,
  parseOwnerConnection,
  preserveCorruptOwnerConnection,
  resetHavemindConnectionState,
  type OwnerConnectionGate,
  type OwnerConnectionReadResult,
} from './adapters/owner-connection';

export {
  CONFIG_POLL_FAILURE_NOTICE,
  CONFIG_POLL_FAILURE_NOTICE_EVERY,
  createConfigPollTick,
  type ConfigPollTickDeps,
} from './adapters/config-poll';

export {
  registerVaultChangeListeners,
  type VaultChangeListenerHandlers,
} from './adapters/vault-change-listeners';

export {
  parseProducerState,
  parseProducerStateResult,
  type ProducerParseResult,
} from './adapters/producer-state';

export type { ConnectionHandle } from './adapters/sync-loop';

export {
  connectFromInput,
  startHavemindConnection,
  type ConnectFromInputOptions,
} from './adapters/connect-flows';

export {
  approvePendingDeviceForOwner,
  createInvitationForOwner,
  listPendingApprovalsForOwner,
  requestRejoinGrantForOwner,
  revokeMembershipForOwner,
} from './adapters/owner-actions';

export { buildRejoinControllerForInvitee } from './adapters/rejoin-wiring';
