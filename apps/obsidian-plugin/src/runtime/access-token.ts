/**
 * Turns the durable refresh token into short-lived access tokens by rotating
 * against `POST /auth/refresh` (F8-02c). Each refresh presents the current
 * refresh token plus a `rotationId` and successor token; on success the
 * successor becomes the new stored refresh token (the server has burned the
 * old one). The access token is cached until shortly before it expires so a
 * sync burst does not rotate on every request.
 *
 * Retry- and concurrency-safety (the server burns a family on any refresh that
 * is not a byte-exact retry — `session-repository.ts` exact-retry guard and
 * `#markReuse`, both irreversible):
 *
 *   1. Idempotent retry (GAP-5). Before sending, the in-flight `{rotationId,
 *      successor}` is persisted durably against the exact refresh token it was
 *      minted for. A dropped response, transient 5xx, or crash mid-rotation
 *      leaves the old refresh token in place AND the in-flight record intact,
 *      so the next attempt — even after a process restart — replays the
 *      identical triple, reaching the server's exact-retry path instead of
 *      burning the family. The record is cleared only after a confirmed 200
 *      commits the successor, or on a terminal 401 (the family is already dead).
 *
 *   2. Single-flight. Concurrent callers that all see the access token expired
 *      share one in-flight rotation promise (in memory), so the same refresh
 *      token is never rotated twice in parallel (which would trip the same
 *      reuse-burn). This complements — does not replace — the durable record:
 *      it only covers concurrency within one live process.
 *
 * A failed rotation throws and leaves the stored refresh token untouched, so a
 * transient failure never discards a still-valid credential.
 *
 * Connect-safety: the durable persistence callbacks are optional AND their
 * failures are swallowed. If the pending-rotation store is unavailable (throws
 * on load/save/clear) the provider degrades to exactly the in-memory-only
 * behaviour — a store outage never aborts rotation, connect, or the sync loop.
 */

import type { RequestUrlFn } from './sync-transport';

const EXPIRY_SKEW_MS = 30_000;

/**
 * The in-flight rotation record persisted before a refresh request is sent.
 * Bound to the exact refresh token it was minted for so a stale record (e.g.
 * after the user reconnects with a fresh token) is never replayed against a
 * different token. Contains secret material (`refreshToken`, successor) and is
 * therefore stored only where the refresh token itself is stored (SecretStorage)
 * and never logged.
 */
export interface PendingRotation {
  readonly refreshToken: string;
  readonly rotationId: string;
  readonly successorRefreshToken: string;
}

export interface RefreshTokenAccessProviderOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly getRefreshToken: () => Promise<string | null>;
  readonly saveRefreshToken: (value: string) => Promise<void>;
  readonly generateRotationId: () => string;
  readonly generateSuccessorToken: () => string;
  /**
   * Durable persistence for the in-flight rotation record. Optional: when
   * omitted the record lives only in memory (still fixes in-process retry and
   * concurrency, but not a crash/restart mid-rotation). Production wires these
   * to the same SecretStorage the refresh token uses. Any of these throwing is
   * tolerated — the provider degrades to in-memory-only rather than failing.
   */
  readonly loadPendingRotation?: () => Promise<PendingRotation | null>;
  readonly savePendingRotation?: (record: PendingRotation) => Promise<void>;
  readonly clearPendingRotation?: () => Promise<void>;
  readonly now?: () => number;
}

export class AccessTokenError extends Error {
  override readonly name = 'AccessTokenError';

  /**
   * True when the server refused the credential (HTTP 401) — a terminal state
   * that must halt the sync loop until the user reconnects, never a retry. A
   * missing token or a transient 5xx/network failure is not auth-denied.
   */
  readonly authDenied: boolean;

  constructor(message: string, options?: { authDenied?: boolean }) {
    super(message);
    this.authDenied = options?.authDenied ?? false;
  }
}

export class RefreshTokenAccessProvider {
  private readonly options: RefreshTokenAccessProviderOptions;
  private readonly now: () => number;
  private cachedToken: string | null = null;
  private cachedExpiry = 0;
  private memoryPending: PendingRotation | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(options: RefreshTokenAccessProviderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (
      this.cachedToken !== null &&
      this.now() < this.cachedExpiry - EXPIRY_SKEW_MS
    ) {
      return this.cachedToken;
    }
    return this.rotate();
  }

  /**
   * Single-flight guard: concurrent callers share one in-flight rotation. The
   * identical refresh token is never rotated twice in parallel, so a second
   * caller can never present the already-rotated token and trip the server's
   * reuse-burn. The guard clears once the rotation settles, so the next call may
   * start a fresh rotation.
   */
  private rotate(): Promise<string> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const run = this.rotateOnce();
    this.inFlight = run;
    return run.finally(() => {
      this.inFlight = null;
    });
  }

  private async rotateOnce(): Promise<string> {
    const refreshToken = await this.options.getRefreshToken();
    if (refreshToken === null) {
      throw new AccessTokenError('No refresh token is stored.');
    }

    // Replay a persisted in-flight pair when it was minted for this exact
    // refresh token; otherwise mint a fresh pair and persist it BEFORE sending
    // so an interrupted attempt can be retried byte-for-byte.
    const pending = await this.resolvePendingRotation(refreshToken);
    const rotationId = pending.rotationId;
    const successorRefreshToken = pending.successorRefreshToken;

    const response = await this.options.requestUrl({
      url: `${this.options.apiBaseUrl}/auth/refresh`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      throw: false,
      body: JSON.stringify({
        refreshToken,
        rotationId,
        successorRefreshToken,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401) {
        // Terminal: the server refused the credential (auth denied / reuse
        // detected). The family is dead, so the in-flight pair is useless —
        // drop it and surface the denial so the loop stops for reconnect.
        await this.clearPendingRotation();
        throw new AccessTokenError(
          `Refresh failed with HTTP ${response.status}.`,
          { authDenied: true },
        );
      }
      // Transient (5xx/other): KEEP the in-flight pair so the next attempt
      // replays the identical triple and reaches the server's exact-retry path.
      throw new AccessTokenError(`Refresh failed with HTTP ${response.status}.`, {
        authDenied: false,
      });
    }
    const body = response.json;
    if (
      !isRecord(body) ||
      typeof body.accessToken !== 'string' ||
      typeof body.accessExpiresAt !== 'string'
    ) {
      // A 2xx means the server already committed the rotation. We could not
      // read the response, so KEEP the in-flight pair: a retry replays it and
      // the exact-retry path returns the committed access token.
      throw new AccessTokenError('Refresh response was malformed.');
    }
    // The server has committed the rotation; persist the successor as current,
    // then clear the in-flight record (only after a confirmed 200).
    await this.options.saveRefreshToken(successorRefreshToken);
    await this.clearPendingRotation();
    this.cachedToken = body.accessToken;
    this.cachedExpiry = Date.parse(body.accessExpiresAt);
    return body.accessToken;
  }

  /**
   * Returns the in-flight pair to present: a persisted record that matches the
   * current refresh token (a replay), or a freshly minted pair that is
   * persisted before it is returned. A stored record whose `refreshToken` does
   * not match the current token is never replayed — it is overwritten by the
   * fresh pair.
   */
  private async resolvePendingRotation(
    refreshToken: string,
  ): Promise<PendingRotation> {
    const stored = await this.loadPending();
    if (stored !== null && stored.refreshToken === refreshToken) {
      return stored;
    }
    const record: PendingRotation = {
      refreshToken,
      rotationId: this.options.generateRotationId(),
      successorRefreshToken: this.options.generateSuccessorToken(),
    };
    this.memoryPending = record;
    await this.savePending(record);
    return record;
  }

  /**
   * Loads the persisted in-flight record, degrading to the in-memory record if
   * no durable store is wired or the store throws. A store outage must never
   * abort a rotation, so a load failure is treated as "use whatever is in
   * memory" (identical to the in-memory-only configuration).
   */
  private async loadPending(): Promise<PendingRotation | null> {
    if (!this.options.loadPendingRotation) {
      return this.memoryPending;
    }
    try {
      return await this.options.loadPendingRotation();
    } catch (error) {
      console.error(
        'Havemind: pending-rotation load failed; using in-memory record',
        error,
      );
      return this.memoryPending;
    }
  }

  /**
   * Persists the freshly minted record durably. A save failure is swallowed:
   * the record still lives in memory (single-flight remains safe within this
   * process) and the rotation proceeds — degrading to in-memory-only rather
   * than aborting.
   */
  private async savePending(record: PendingRotation): Promise<void> {
    if (!this.options.savePendingRotation) {
      return;
    }
    try {
      await this.options.savePendingRotation(record);
    } catch (error) {
      console.error(
        'Havemind: pending-rotation save failed; continuing in-memory only',
        error,
      );
    }
  }

  private async clearPendingRotation(): Promise<void> {
    this.memoryPending = null;
    if (!this.options.clearPendingRotation) {
      return;
    }
    try {
      await this.options.clearPendingRotation();
    } catch (error) {
      console.error('Havemind: pending-rotation clear failed', error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
