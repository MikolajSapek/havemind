import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import {
  createBackup,
  pruneBackups,
  type BackupManifest,
} from './backup-restore.js';

/**
 * In-process scheduled backups.
 *
 * Why in-process: on the pilot host the operator account has no `docker` group
 * and no non-interactive `sudo`, so nothing outside the container can run
 * `docker exec havemind backup` from cron. The server therefore writes its own
 * artifacts on a timer into a HOST bind mount, and the (sudo-free) user cron job
 * only has to copy already-written files off the box (ops/sapserver/restic).
 *
 * Server-opaque by construction: this composes `createBackup` — a consistent
 * SQLite snapshot plus a byte-hash-pinned copy of the content-addressed blobs —
 * and never inspects, diffs or merges payload contents (plans/001 §3).
 */

export interface ScheduledBackupOptions {
  readonly database: Database.Database;
  readonly dataDir: string;
  /** Directory that holds one sub-directory per artifact. */
  readonly backupsRoot: string;
  /** Number of newest artifacts to keep after each run. */
  readonly keep: number;
  readonly now?: () => Date;
  readonly backupId?: () => string;
}

export interface ScheduledBackupResult {
  readonly backupId: string;
  readonly backupDir: string;
  readonly manifest: BackupManifest;
  readonly keptCount: number;
  readonly removedCount: number;
}

function defaultBackupId(now: () => Date): string {
  // Lexicographically sortable, filesystem-safe, collision-free.
  return `${now().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
}

/**
 * Runs exactly one backup cycle: stage into a dot-prefixed temp directory,
 * publish it with a single `rename`, then apply keep-N retention.
 *
 * Publication is a rename precisely so a crash mid-write can never leave a
 * directory that *looks* like a complete artifact — `listBackups` ignores
 * dot-prefixed directories, so an interrupted run is invisible to both retention
 * and restore.
 */
export async function runScheduledBackup(
  options: ScheduledBackupOptions,
): Promise<ScheduledBackupResult> {
  const now = options.now ?? ((): Date => new Date());
  const backupId = options.backupId?.() ?? defaultBackupId(now);

  await mkdir(options.backupsRoot, { mode: 0o700, recursive: true });
  const backupDir = join(options.backupsRoot, backupId);
  const stagingDir = join(options.backupsRoot, `.${backupId}.tmp`);
  await rm(stagingDir, { force: true, recursive: true });

  let manifest: BackupManifest;
  try {
    manifest = await createBackup({
      backupDir: stagingDir,
      database: options.database,
      dataDir: options.dataDir,
      now,
    });
    await rename(stagingDir, backupDir);
  } catch (error) {
    await rm(stagingDir, { force: true, recursive: true });
    throw error;
  }

  const pruned = await pruneBackups({
    backupsRoot: options.backupsRoot,
    keep: options.keep,
  });

  return {
    backupDir,
    backupId,
    keptCount: pruned.kept.length,
    manifest,
    removedCount: pruned.removed.length,
  };
}

export interface BackupSchedulerLogger {
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
}

/** Opaque handle returned by the timer seam; only the seam interprets it. */
export type BackupTimerHandle = unknown;

/**
 * The timer seam. Production uses `setInterval`; tests inject a fake that
 * captures the handler and drives every tick explicitly, so scheduling is
 * verified without any wall-clock waiting.
 */
export interface BackupTimer {
  readonly set: (
    handler: () => Promise<void>,
    intervalMs: number,
  ) => BackupTimerHandle;
  readonly clear: (handle: BackupTimerHandle) => void;
}

export interface BackupSchedulerOptions extends ScheduledBackupOptions {
  readonly intervalMs: number;
  readonly logger?: BackupSchedulerLogger;
  readonly timer?: BackupTimer;
}

export interface BackupScheduler {
  readonly stop: () => void;
}

const SYSTEM_TIMER: BackupTimer = {
  clear: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
  set: (handler, intervalMs) =>
    setInterval(() => {
      void handler();
    }, intervalMs),
};

const SILENT_LOGGER: BackupSchedulerLogger = {
  error: () => undefined,
  info: () => undefined,
};

/**
 * Starts the periodic backup timer and returns a disposer. The first run happens
 * one interval after start (never at boot, so a restart loop cannot spam the
 * disk); the activation checklist runs `havemind backup --to /backups` once by
 * hand to seed the first artifact.
 *
 * A failing cycle is logged and swallowed: a backup must never take the sync
 * server down, and it must never leave an unhandled rejection behind. Overlapping
 * runs are impossible — a tick that arrives while a run is in flight is dropped.
 */
export function startBackupScheduler(
  options: BackupSchedulerOptions,
): BackupScheduler {
  const timer = options.timer ?? SYSTEM_TIMER;
  const logger = options.logger ?? SILENT_LOGGER;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const result = await runScheduledBackup(options);
      logger.info(
        `Scheduled backup ${result.backupId} written: ${String(
          result.manifest.blobs.length,
        )} blobs, retention kept ${String(result.keptCount)}, removed ${String(
          result.removedCount,
        )}.`,
      );
    } catch (error) {
      // Secret-free: RestoreError messages never embed payloads, paths or keys.
      logger.error(
        `Scheduled backup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      running = false;
    }
  };

  const handle = timer.set(tick, options.intervalMs);
  return {
    stop: () => {
      stopped = true;
      timer.clear(handle);
    },
  };
}
