/**
 * Local-change detection wired to the outbox. It registers the vault
 * create/modify/rename/delete listeners, runs the connect-time reconciliation so
 * pre-existing files are enumerated and pushed, polls the `.obsidian/` config
 * mirror Obsidian emits no events for, records every genuine change in the
 * Activity feed, and triggers a sync cycle after each one. Everything here is
 * concerned with a single invariant: no local change may be dropped silently, and
 * no observe may run concurrently with a remote apply of the same file.
 */

import { Notice, type Plugin, type TFile } from 'obsidian';

import { isSyncableConfigPath } from '@havemind/protocol';
import { RevisionPayloadTooLargeError } from '@havemind/sync-core';

import type { ActivityKind } from '../../activity/activity';
import {
  classifyVaultPath,
  pathExtension,
  SYNCABLE_BINARY_EXTENSIONS,
  VaultChangeObserver,
  type LocalChangeKind,
  type LocalChangeOperation,
  type VaultSnapshotPort,
} from '../../obsidian/vault-adapter';
import {
  CONFIG_DIR,
  listSyncableConfigPaths,
} from '../../sync/config-adapter';
import { pollConfigOnce } from '../../sync/config-poller';
import {
  OutboxLocalChangeRepository,
  type ProducerStorePort,
  type PushIdentity,
} from '../../sync/outbox-repository';
import {
  formatReconcileNotices,
  reconcileVaultState,
  warnSkippedPaths,
} from '../../sync/reconciliation';
import {
  CommitPathRecovery,
  retryFailedCommit,
  type RetryFailedCommitOutcome,
} from '../commit-recovery';
import type { KeyedMutex } from '../keyed-mutex';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from '../local-base-lifecycle';
import { ModifyDebouncer } from '../modify-debounce';
import { getPluginDataMutex } from '../plugin-data-mutex';
import {
  failedToQueueRevisionId,
  type DurableSyncState,
} from '../sync-state';

import {
  CONFIG_POLL_INTERVAL_MS,
  createConfigPollTick,
} from './config-poll';
import { PUSH_PRODUCER_KEY } from './plugin-data-keys';
import { preserveCorruptProducerState } from './plugin-data-ports';
import { parseProducerStateResult } from './producer-state';
import type { RuntimeHooks } from './runtime-hooks';
import { isRecord, type AppWithVault } from './shared';
import { registerVaultChangeListeners } from './vault-change-listeners';

/**
 * Maps a local-change kind onto the Activity feed's kind vocabulary. Binary
 * attachment ops (F9) carry the same change kinds (create/update/rename/delete),
 * so they are recorded and attributed here EXACTLY like markdown ops — the
 * activity wiring is content-kind agnostic. Restore-from-feed remains a
 * markdown-only affordance (it reconstructs text from provenance ranges, which a
 * whole-file binary revision has none of); a binary entry still appears in the
 * feed, it simply is not a meaningful restore target.
 */
function toActivityKind(kind: LocalChangeKind): ActivityKind {
  return kind === 'update' ? 'edit' : kind;
}

/**
 * Wires local-change detection to the outbox. It registers vault create/modify/
 * rename/delete listeners, runs an initial reconciliation so files that already
 * existed before pairing are enumerated and pushed, and triggers a sync cycle
 * after each detected change. Never logs note contents.
 *
 * Returns a handle exposing `dispose()` — which detaches every registered
 * vault listener (the connection handle's `stop()` must call it on teardown/
 * re-pair so a prior-session producer never lingers and double-enqueues under a
 * stale identity, see the `stop()` comment in `startSyncLoop`) — and
 * `retryFailedCommit(path)`, which re-runs the commit chain for a failed-to-
 * queue row against the current on-disk content (MAJOR 2).
 */
export interface PushProducerHandle {
  dispose(): void;
  /**
   * Re-trigger the commit chain for `path`. Tri-state (FINDING 1): `file-missing`
   * when the file is gone, `unavailable` when the debouncer no-op'd the re-arm
   * (disposed producer), `retriggered` on a real re-arm.
   */
  retryFailedCommit(path: string): RetryFailedCommitOutcome;
}

export function startPushProducer(
  plugin: Plugin,
  state: DurableSyncState,
  identity: PushIdentity,
  triggerSync: () => void,
  producerRef: { current: OutboxLocalChangeRepository | null },
  hooks?: RuntimeHooks,
  fileApplyLock?: KeyedMutex,
): PushProducerHandle {
  const vault = (plugin.app as unknown as AppWithVault).vault;
  const store: ProducerStorePort = {
    async load() {
      const data = await plugin.loadData();
      const raw = isRecord(data) ? data[PUSH_PRODUCER_KEY] : null;
      const result = parseProducerStateResult(raw);
      // GAP-3: preserve unparseable producer bytes to a sidecar so a lost mapping
      // can't silently fork a duplicate fileId. Connect-safety: the persist may
      // fail (loadData/mutex), but that must NEVER abort producer setup — degrade
      // defensively and fall through to the (empty-or-partial) parsed state.
      try {
        if (result.status === 'corrupt') {
          await preserveCorruptProducerState(plugin, raw, Date.now());
        } else if (result.quarantinedMappings.length > 0) {
          await preserveCorruptProducerState(
            plugin,
            { mappings: result.quarantinedMappings },
            Date.now(),
          );
        }
      } catch {
        console.warn(
          'Havemind: failed to preserve corrupt producer state to a sidecar.',
        );
      }
      return result.state;
    },
    async save(next) {
      await getPluginDataMutex(plugin).update((base) => ({
        ...base,
        [PUSH_PRODUCER_KEY]: next,
      }));
    },
  };

  const repository = new OutboxLocalChangeRepository({
    identity,
    store,
    enqueue: (envelope) => state.enqueue(envelope),
    generateRevisionId: () => globalThis.crypto.randomUUID(),
    // FIX 1: seed the SHARED apply store for every file this device authors or
    // pushes, so a later peer edit to a locally-authored file resolves to its
    // real fileId and updates in place instead of forever forking to a conflict
    // artifact. A rename also forgets the stale owner of the previous path.
    //
    // DATA-SAFETY (rule 3): the base is SEEDED only on first authorship and is
    // NEVER advanced by a local push — advancing it here reopened the silent-
    // overwrite window (a concurrent peer revision matching the just-authored
    // base slips past the on-disk guard). The single source of truth for that
    // rule lives in `local-base-lifecycle.ts`, shared with the integration
    // harness so a regression can't hide behind a differently-modelled test.
    onLocalMaterialized: (materialization) =>
      applyLocalMaterialization(state, materialization),
    onLocalForgotten: (forget) => forgetLocalMaterialization(state, forget),
  });
  // Bind the late-bound coordinator so the apply adapter can adopt remote
  // fileIds into this producer's mapping (FIX 2).
  producerRef.current = repository;

  const snapshot: VaultSnapshotPort = {
    async listSyncablePaths() {
      // Markdown notes AND allowlisted binary attachments (F9). Obsidian has no
      // single API for both, so filter every vault file down to the syncable
      // extensions; `classifyVaultPath` still applies the dotpath/reserved
      // exclusions downstream (so reserved-folder files are counted as ignored,
      // exactly as the old markdown-only listing did). The `.obsidian/` config
      // MIRROR is appended from the DataAdapter walk — Obsidian never exposes
      // hidden files through `getFiles()`, so the config tree must be enumerated
      // separately. This is what makes the connect-time reconcile cover config.
      const notes = vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => {
          const extension = pathExtension(path.normalize('NFC'));
          return (
            extension === 'md' ||
            (SYNCABLE_BINARY_EXTENSIONS as readonly string[]).includes(extension)
          );
        });
      const config = await listSyncableConfigPaths(vault.adapter, CONFIG_DIR);
      return [...notes, ...config];
    },
    async readText(path) {
      // A `.obsidian/` config path is invisible to the Vault file API, so read it
      // through the DataAdapter; everything else stays on the Vault API.
      if (isSyncableConfigPath(path)) {
        return (await vault.adapter.exists(path)) ? vault.adapter.read(path) : '';
      }
      const file = vault.getAbstractFileByPath(path);
      return file === null ? '' : vault.read(file as TFile);
    },
    async readBinary(path) {
      if (isSyncableConfigPath(path)) {
        if (!(await vault.adapter.exists(path))) return new Uint8Array(0);
        return new Uint8Array(await vault.adapter.readBinary(path));
      }
      const file = vault.getAbstractFileByPath(path);
      if (file === null) return new Uint8Array(0);
      return new Uint8Array(await vault.readBinary(file as TFile));
    },
    async listAllPaths() {
      // Every vault file, of any type. Used only by reconciliation to count
      // (never read or enqueue) the non-syncable attachments the pilot's scope
      // excludes, so that exclusion stays visible. Config lives outside this
      // count (it is enumerated via the adapter, not `getFiles()`).
      return vault.getFiles().map((file) => file.path);
    },
    async exists(path) {
      if (isSyncableConfigPath(path)) return vault.adapter.exists(path);
      return vault.getAbstractFileByPath(path) !== null;
    },
  };

  const observer = new VaultChangeObserver({
    clock: () => Date.now(),
    generateFileId: () => globalThis.crypto.randomUUID(),
    generateOperationId: () => globalThis.crypto.randomUUID(),
    repository,
    vault: snapshot,
  });

  // TOCTOU close (rule 3): route each SINGLE-file observe (create/modify/delete)
  // through the SAME per-file lock remote apply holds, keyed by the file's
  // canonical collision key. This makes producing and applying one file mutually
  // exclusive, so a local edit can neither be observed mid-apply nor clobbered
  // by an apply that read the file before the edit landed. Multi-key folder and
  // rename events keep the observer's own global ordering (they span several
  // files); the on-disk re-read in `applyRemote` still guards those.
  const lockedObserve = <T>(path: string, run: () => Promise<T>): Promise<T> => {
    if (fileApplyLock === undefined) return run();
    const classified = classifyVaultPath(path);
    const key = classified.eligible ? classified.collisionKey : path;
    return fileApplyLock.runExclusive(key, run);
  };

  const afterChange = (task: Promise<unknown>): void => {
    void task.then(
      () => triggerSync(),
      (error: unknown) => {
        // Surface an oversized note to the user instead of silently dropping it;
        // the change was never enqueued (the size guard rejected it), so nothing
        // wedges the outbox.
        if (error instanceof RevisionPayloadTooLargeError) {
          new Notice(`Havemind: ${error.message}`);
          return;
        }
        // SND-02 belt-and-braces: no commit-path rejection may drop silently.
        // The path-aware modify-settle handler below does the bounded re-arm +
        // durable failed-to-queue record; for the immediate create/rename/delete
        // and reconcile chains (which have no debounce entry to re-arm) at least
        // surface a Notice pointing at the panel rather than swallowing it.
        new Notice(
          'Havemind: a change could not be queued — see the Havemind panel.',
        );
      },
    );
  };

  // Record a genuine local change (a non-null observe result) into the Activity
  // feed, attributed to the local member. A no-op observe (null) — e.g. a
  // remote-applied write that matches the synced base — is never recorded, so
  // remote edits are not mislabelled as the local user's work.
  const recordActivity = (op: LocalChangeOperation | null): void => {
    if (op === null || hooks?.onLocalActivity === undefined) return;
    hooks.onLocalActivity({
      // The real revision id the outbox repository generated and enqueued
      // (`OutboxLocalChangeRepository.commitLocalChange`'s `built.revisionId`,
      // surfaced here as `op.revisionId`) — never `op.operationId`, which is
      // only a client-side idempotency key and would break restore + the
      // local-push/remote-echo dedup in `ActivityLog`. Falls back to the
      // operationId only when no revision was created (a delete of a file
      // that was never pushed), so the entry still has a stable, unique id.
      revisionId: op.revisionId ?? op.operationId,
      fileId: op.fileId,
      path: op.path,
      kind: toActivityKind(op.kind),
      author: { kind: 'member', membershipId: identity.memberId },
      timestamp: op.observedAt,
      hasContent: op.content !== null,
    });
  };
  const observed = (task: Promise<LocalChangeOperation | null>): void => {
    afterChange(
      task.then((op) => {
        recordActivity(op);
        return op;
      }),
    );
  };
  // Folder-level events expand to zero or more per-child operations; record each
  // genuine one in the Activity feed and trigger a single sync afterwards.
  const observedMany = (task: Promise<LocalChangeOperation[]>): void => {
    afterChange(
      task.then((ops) => {
        for (const op of ops) recordActivity(op);
        return ops;
      }),
    );
  };

  // Capture the listener refs so the returned disposer can detach exactly this
  // producer's listeners on stop/re-pair (not tied to plugin unload via
  // registerEvent, which would outlive a re-pair and leak a stale-identity
  // observer). See registerVaultChangeListeners.
  // AUD-03 (settling window): a `modify` event is debounced per path so an
  // apply-then-formatter-rewrite burst hashes ONCE, after the file settles,
  // reading its final content. Create/rename/delete are ordering-sensitive and
  // fire immediately (never debounced).
  // SND-02: a settle-time observeModify→commitLocalChange rejection used to be
  // swallowed silently (the debouncer deletes the pending entry before firing,
  // so nothing re-triggered). This path-aware handler gives every failing path
  // one bounded re-arm; if the retry also fails the change is recorded durably
  // as a failed-to-queue row in the send-queue panel — never silently dropped.
  const commitPathRecovery = new CommitPathRecovery({
    notify: (message) => new Notice(message),
    rearm: (path) => modifyDebouncer.trigger(path),
    recordFailedToQueue: async (path) => {
      await state.recordFailedToQueue(path);
      // MINOR 7: commit-recovery has already surfaced a Notice for this row, so
      // mark it notified — the panel's quarantine-notice check must not fire a
      // second Notice for the same failed-to-queue event.
      hooks?.onFailedToQueueNotified?.(failedToQueueRevisionId(path));
    },
    // MAJOR 1: a successful commit discards any stale failed-to-queue row an
    // earlier transient failure recorded, then refreshes the panel so the
    // phantom failure disappears at once. Guarded on the warm snapshot so the
    // common case (a success with no such row) neither saves nor refreshes.
    clearFailedToQueue: (path) => {
      const revisionId = failedToQueueRevisionId(path);
      const present = state
        .quarantineSnapshot()
        .some((item) => item.revisionId === revisionId);
      if (!present) return;
      void state.discardQuarantined(revisionId).then(
        () => hooks?.onSendQueueChanged?.(),
        () => console.warn('Havemind: failed to clear a recovered send-queue item.'),
      );
    },
  });
  const observeSettledModify = (path: string): void => {
    void lockedObserve(path, () => observer.observeModify(path)).then(
      (op) => {
        recordActivity(op);
        commitPathRecovery.onCommitSuccess(path);
        triggerSync();
      },
      (error: unknown) => {
        // An oversized note is a permanent per-item rejection: surface it, but
        // never re-arm (the retry can only fail the same way).
        if (error instanceof RevisionPayloadTooLargeError) {
          new Notice(`Havemind: ${error.message}`);
          return;
        }
        void commitPathRecovery.onCommitFailure(path).catch(() => {
          // The recovery record is best-effort, but its own storage failure must
          // never become an unhandled rejection from a vault event handler.
          console.warn('Havemind: failed to record an unqueued vault change.');
        });
      },
    );
  };
  const modifyDebouncer = new ModifyDebouncer({
    onSettled: (path) => observeSettledModify(path),
  });
  const disposeListeners = registerVaultChangeListeners(vault, {
    onCreate: (path) =>
      observed(lockedObserve(path, () => observer.observeCreate(path))),
    onModify: (path) => modifyDebouncer.trigger(path),
    onDelete: (path) => {
      // Cancel any pending settled modify for this path first: the delete
      // tombstone already carries the outcome, and a later modify would find no
      // mapping and push a phantom empty create for the vacated path.
      modifyDebouncer.cancel(path);
      observed(lockedObserve(path, () => observer.observeDelete(path)));
    },
    onRename: (oldPath, newPath) => {
      // The rename commit carries the file's content to the new path; cancel the
      // OLD path's pending modify so a stale settle never fires against a path
      // that has moved (which would resurrect it as a phantom empty create).
      modifyDebouncer.cancel(oldPath);
      observed(observer.observeRename(oldPath, newPath));
    },
    onFolderRename: (oldPath, newPath) =>
      observedMany(observer.observeFolderRename(oldPath, newPath)),
    onFolderDelete: (folderPath) =>
      observedMany(observer.observeFolderDelete(folderPath)),
  });

  // Existing notes predate the change listeners, so enumerate them once on
  // connect and push any that are new or drifted, then sync. A per-file failure
  // (an oversized note) is skipped rather than aborting the whole scan; surface
  // the count so a silently un-synced file is visible to the user.
  afterChange(
    reconcileVaultState({ observer, repository, vault: snapshot }).then(
      (result) => {
        if (result.skipped > 0) {
          new Notice(
            `Havemind: ${result.skipped} file(s) could not be synced and were skipped.`,
          );
          // The Notice carries the count only — a per-file toast storm would be
          // worse than no toast — so the console gets the names and reasons a
          // count alone can never supply (bounded by the reconcile detail cap).
          warnSkippedPaths(result);
        }
        // A remaining exclusion (an unsupported file type, or an allowlisted
        // binary over the size cap, F9) must never be silent: surface each
        // reason as its own notice, separate from the per-file skip count
        // above, so the distinct reasons are never conflated.
        for (const notice of formatReconcileNotices(result)) {
          new Notice(notice);
        }
      },
    ),
  );

  // `.obsidian/` config sync (theme, colours, hotkeys, snippets, foreign plugin
  // code). Obsidian emits NO vault events for hidden files, so this cannot use
  // the watchers above — a POLLER re-walks the config tree via the DataAdapter on
  // a modest interval and feeds each change through the SAME observer + outbox as
  // `.md` (the connect-time enumeration is already covered by the reconcile above,
  // whose `listSyncablePaths` now includes the config walk). Every observe is
  // routed through `lockedObserve` so it is mutually exclusive with a remote
  // config apply, and each genuine change is recorded in Activity and triggers a
  // sync — exactly as a watcher-driven change is.
  const configObserver = {
    observeModify: (path: string) =>
      lockedObserve(path, () => observer.observeModify(path)),
    observeDelete: (path: string) =>
      lockedObserve(path, () => observer.observeDelete(path)),
  };
  // A config poll must never wedge sync: a bad tick is skipped and the next
  // interval retries. But it must not hide a PERSISTENT fault either (audit #3
  // finding 5) — every failure warns to the console and a throttled Notice fires
  // on the first failure of a streak and every Nth after it. Per-file commit
  // failures are already surfaced by the observe path's own handling.
  const runConfigPollTick = createConfigPollTick({
    poll: () =>
      pollConfigOnce({
        observer: configObserver,
        listConfigPaths: () => listSyncableConfigPaths(vault.adapter, CONFIG_DIR),
        listMappings: () => repository.listMappings(),
      }),
    recordActivity,
    triggerSync,
    notify: (message) => new Notice(message),
  });
  // registerInterval clears it on plugin UNLOAD; the explicit clear in dispose()
  // below covers a stop/RE-PAIR (which tears the producer down without unloading).
  const configPollId = window.setInterval(() => {
    void runConfigPollTick();
  }, CONFIG_POLL_INTERVAL_MS);
  plugin.registerInterval(configPollId);

  return {
    dispose: () => {
      // Cancel any in-flight settle timers before detaching listeners so a
      // pending modify can never fire after teardown/re-pair.
      window.clearInterval(configPollId);
      modifyDebouncer.dispose();
      disposeListeners();
    },
    // MAJOR 2: a failed-to-queue row has no stashed envelope, so its Retry
    // re-runs the commit chain against the current on-disk content — routed
    // through the SAME debouncer trigger the bounded re-arm uses. Tri-state
    // (FINDING 1): `file-missing` when the file is gone (drop the row),
    // `unavailable` when the debouncer no-op'd the re-arm because it was disposed
    // (keep the row), `retriggered` on a real re-arm. `trigger` reports whether
    // it actually scheduled, which is exactly the disposed/unavailable signal.
    retryFailedCommit: (path: string): RetryFailedCommitOutcome =>
      retryFailedCommit(path, {
        exists: (candidate) =>
          vault.getAbstractFileByPath(candidate) !== null,
        retrigger: (candidate) => modifyDebouncer.trigger(candidate),
      }),
  };
}
