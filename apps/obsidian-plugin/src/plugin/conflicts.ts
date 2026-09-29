/** Conflict copies (MRG-03, MRG-05): the cached list, the resolve modal, the auto-repair sweep. */

import { Notice, type EventRef } from 'obsidian';

import type HavemindPlugin from '../main';
import { CachedConflictList } from '../runtime/conflict-cache';
import {
  computeLineDiff,
  createConflictResolver,
  createObsidianConflictPort,
  listConflictCopies,
  type ConflictVaultPort,
  type DiffLine,
  type ResolveAction,
} from '../runtime/conflict-resolution';
import { sweepConflictCopies } from '../runtime/conflict-sweep';
import { RerunGuard } from '../runtime/rerun-guard';
import {
  ConflictResolveModal,
  buildConflictModalModel,
} from '../ui/conflict-modal';

/** Debounce window for the MRG-05 auto-repair sweep, a burst becomes one pass. */
const CONFLICT_SWEEP_DEBOUNCE_MS = 2000;

type Host = Pick<HavemindPlugin, 'app' | 'connection' | 'registerEvent' | 'syncState' | 'views'>;

export class Conflicts {
  /**
   * The conflict scan, cached between vault changes. The pane reads it twice
   * per render and repaints often; each scan walks the whole vault.
   */
  public readonly list = new CachedConflictList(() =>
    listConflictCopies(this.conflictPort()),
  );
  /**
   * MRG-03 conflict resolver. Its per-copy guard makes a double-clicked resolve
   * fire each destructive vault op at most once. Lazily bound to the live vault
   * port on first use so a headless test never needs a real vault.
   */
  private conflictResolver: ReturnType<typeof createConflictResolver> | null = null;
  /**
   * Debounce timer for the MRG-05 auto-repair sweep. A burst of new conflict
   * copies coalesces into a single pass ~2s after the last write.
   */
  private conflictSweepTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /**
   * Serialises sweep runs AND re-arms one more pass when a trigger arrives
   * mid-run, so a conflict copy written while a sweep is in flight is not
   * dropped (MINOR); the guarded no-op used to leave it un-swept.
   */
  private readonly conflictSweepGuard = new RerunGuard(() =>
    this.runConflictSweepOnce(),
  );

  public constructor(private readonly plugin: Host) {}

  /**
   * The cached conflict scan is invalidated by vault events, never by a timer:
   * a timer would either rescan too often, which is the cost the cache exists
   * to remove, or serve a stale list at the moment a conflict appears. A
   * conflict the user cannot see is the one failure this plugin must not have
   * (plan/01 rule 4). Rename counts: a copy moving in or out of the reserved
   * folder changes the list without creating or deleting anything.
   */
  public watchVault(): void {
    for (const event of ['create', 'delete', 'rename'] as const) {
      // Cast on `app`, matching `conflictPort()`: the local typings do not
      // model `vault`.
      const { vault } = this.plugin.app as unknown as {
        vault: { on?: (name: string, handler: () => void) => unknown };
      };
      const ref = vault.on?.(event, () => {
        this.list.invalidate();
        this.plugin.views.refreshOnboarding();
      });
      if (ref !== undefined && ref !== null) {
        this.plugin.registerEvent(ref as EventRef);
      }
    }
  }

  /**
   * The Obsidian-backed conflict vault port. `app.vault` is not modelled on
   * the ambient `App`, so cast through a local shape rather than patching the
   * shared interface (the port degrades to "no conflicts" for a stub vault).
   */
  private conflictPort(): ConflictVaultPort {
    const app = this.plugin.app as unknown as {
      vault: Parameters<typeof createObsidianConflictPort>[0];
      workspace?: Parameters<typeof createObsidianConflictPort>[1];
    };
    return createObsidianConflictPort(app.vault, app.workspace);
  }

  /**
   * Opens the MRG-03 resolve modal for a conflict copy: computes the note-vs-copy
   * diff (text copies with a known target only), then wires the three actions to
   * the shared resolver. After a resolve, the panel re-renders so the resolved
   * row drops out and the section disappears once empty.
   */
  public async openConflictModal(
    copyPath: string,
  ): Promise<ConflictResolveModal | null> {
    try {
      return await this.openConflictModalOnce(copyPath);
    } catch {
      new Notice('Havemind: could not open this conflict. Try again.');
      this.plugin.views.refreshOnboarding();
      return null;
    }
  }

  /** The fallible vault read and modal construction behind the safe UI boundary. */
  private async openConflictModalOnce(
    copyPath: string,
  ): Promise<ConflictResolveModal | null> {
    const port = this.conflictPort();
    const copy = listConflictCopies(port).find((c) => c.copyPath === copyPath);
    if (copy === undefined) return null;

    let diff: DiffLine[] | null = null;
    let diffTooLarge = false;
    if (copy.targetKnown && !copy.isBinary && copy.targetPath !== null) {
      const [mine, theirs] = await Promise.all([
        port.readText(copy.targetPath),
        port.readText(copy.copyPath),
      ]);
      // MINOR 6: a null read means one side is absent; show no diff rather than
      // diffing against a phantom empty string.
      if (mine !== null && theirs !== null) {
        diff = computeLineDiff(mine, theirs);
        diffTooLarge = diff === null;
      }
    }

    if (this.conflictResolver === null) {
      this.conflictResolver = createConflictResolver(port);
    }
    const resolver = this.conflictResolver;
    const run = (action: ResolveAction, modal: ConflictResolveModal): void => {
      void resolver.resolve(copy, action).then(
        (outcome) => {
          // The auto-sweep may have resolved and deleted this copy while the modal
          // was open. keepTheirs aborts as 'vanished' rather than blanking the
          // already-merged note; tell the user and refresh the stale panel/modal.
          if (outcome === 'vanished') {
            new Notice('This conflict was already auto-resolved.');
          }
          if (outcome === 'target-missing') {
            new Notice('The note was moved or deleted, so the conflict copy was kept.');
          }
          modal.close();
          this.plugin.views.refreshOnboarding();
        },
        () => {
          new Notice('Havemind: could not resolve this conflict. Try again.');
          this.plugin.views.refreshOnboarding();
        },
      );
    };

    const modal: ConflictResolveModal = new ConflictResolveModal(
      this.plugin.app,
      buildConflictModalModel(copy, diff, { diffTooLarge }),
      {
        onKeepMine: () => run('keepMine', modal),
        ...(copy.targetKnown && !copy.isBinary
          ? { onKeepTheirs: () => run('keepTheirs', modal) }
          : {}),
        onKeepBoth: () => run('keepBoth', modal),
      },
    );
    modal.open();
    return modal;
  }

  /**
   * MRG-05: schedule a single debounced auto-repair sweep. A burst of new
   * conflict copies (or a start-up call plus a runtime write) collapses into one
   * pass ~2s after the last trigger. The sweep only writes notes (outside the
   * reserved folder) and deletes resolved copies (inside it), and the trigger
   * keys off NEW copy writes only, so a sweep never re-schedules itself.
   */
  public scheduleConflictSweep(): void {
    this.cancelConflictSweep();
    this.conflictSweepTimer = globalThis.setTimeout(() => {
      this.conflictSweepTimer = null;
      void this.runConflictSweep().catch(() => {
        new Notice('Havemind: automatic conflict repair could not finish.');
        this.plugin.views.refreshOnboarding();
      });
    }, CONFLICT_SWEEP_DEBOUNCE_MS);
  }

  /** Drops a pending sweep, so none fires after unload. */
  public cancelConflictSweep(): void {
    if (this.conflictSweepTimer !== null) {
      globalThis.clearTimeout(this.conflictSweepTimer);
      this.conflictSweepTimer = null;
    }
  }

  /**
   * Runs one auto-repair pass (MRG-05). The merge ancestor comes from the
   * connection's revision history; a copy with none is left untouched for the
   * manual modal. A guard prevents overlapping runs. Refreshes
   * the panel afterwards so a resolved conflict's row drops out.
   */
  private async runConflictSweep(): Promise<void> {
    if (this.plugin.syncState === null) return;
    // The guard serialises passes and re-arms one more run if a copy is written
    // mid-sweep, so a mid-run trigger is never silently dropped (MINOR).
    await this.conflictSweepGuard.trigger();
  }

  /** One sweep pass. Called only via {@link conflictSweepGuard}. */
  private async runConflictSweepOnce(): Promise<void> {
    const state = this.plugin.syncState;
    if (state === null) return;
    await sweepConflictCopies({
      port: this.conflictPort(),
      fileIdAtPath: (path) => state.fileIdAtPath(path),
      fileIdForCopy: (path) => state.fileIdForConflictCopy(path),
      ancestorFor: async (copyPath, fileId, targetPath) =>
        (await this.plugin.connection?.conflictAncestor?.(copyPath, fileId, targetPath)) ?? null,
      notify: (message) => {
        new Notice(`Havemind: ${message}`);
      },
    });
    this.plugin.views.refreshOnboarding();
  }
}
