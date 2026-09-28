import type Database from 'better-sqlite3';

/**
 * How long a row is kept after its own deadline before it is deleted. Every
 * row pruned here is already inert at its deadline (an expired access token
 * fails lookup, an expired family fails rotation before reuse detection is
 * consulted, an idempotency record has outlived the retry window the
 * repository granted it), so the day only absorbs clock skew and leaves a
 * short trail for diagnosing a session that just ended.
 */
export const PRUNE_GRACE_MS = 24 * 60 * 60 * 1_000;

/** Hourly: tokens accrue at one pair per ten minute refresh per device. */
export const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export interface PruneResult {
  readonly accessTokens: number;
  readonly idempotencyRecords: number;
  readonly refreshTokens: number;
}

/**
 * Deletes auth and replay rows nothing can use any more. Nothing did before,
 * so every refresh left a consumed refresh row and an access token behind for
 * good (about 340 and 300 of them in six days on the pilot).
 *
 * Refresh rows are deleted per family, and only once the family itself is a
 * day past its deadline, whatever its status. Rows of a live family are all
 * kept, consumed ones included, because reuse detection needs them: a replay
 * of a consumed token burns the family only if the server still recognises
 * it. A revoked family keeps its rows until its window closes too, so a replay
 * keeps answering SESSION_REVOKED rather than INVALID_REFRESH for as long as
 * it would have. Family rows stay, one per session, as the session history.
 */
export function pruneExpiredRecords(
  database: Database.Database,
  now: Date,
): PruneResult {
  const cutoff = new Date(now.getTime() - PRUNE_GRACE_MS).toISOString();
  const prune = database.transaction((): PruneResult => {
    const refreshTokens = database
      .prepare(
        `DELETE FROM refresh_tokens
         WHERE family_id IN (
           SELECT id FROM refresh_token_families WHERE expires_at < ?
         )`,
      )
      .run(cutoff).changes;
    const accessTokens = database
      .prepare('DELETE FROM access_tokens WHERE expires_at < ?')
      .run(cutoff).changes;
    // The repository stamps each record with its own expiry (24 hours by
    // default, see revision-repository.ts), so the retention is read from the
    // row rather than repeated here.
    const idempotencyRecords = database
      .prepare('DELETE FROM idempotency_records WHERE expires_at < ?')
      .run(cutoff).changes;
    return { accessTokens, idempotencyRecords, refreshTokens };
  });
  return prune.immediate();
}

export interface PruneLogger {
  readonly error: (message: string) => void;
  readonly info: (message: string) => void;
}

export interface ExpiredRecordPruningOptions {
  readonly database: Database.Database;
  readonly logger: PruneLogger;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

export interface ExpiredRecordPruning {
  readonly stop: () => void;
}

/**
 * Prunes once at startup and then on a timer. A failing run is logged and
 * swallowed: housekeeping must never take the sync server down.
 */
export function startExpiredRecordPruning(
  options: ExpiredRecordPruningOptions,
): ExpiredRecordPruning {
  const now = options.now ?? (() => new Date());
  const run = (): void => {
    try {
      const result = pruneExpiredRecords(options.database, now());
      options.logger.info(
        `Pruned ${String(result.accessTokens)} access tokens, ${String(
          result.refreshTokens,
        )} refresh tokens, ${String(
          result.idempotencyRecords,
        )} idempotency records.`,
      );
    } catch (error) {
      options.logger.error(
        `Pruning expired records failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  run();
  const timer = setInterval(
    run,
    options.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
  );
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
