/**
 * F9 Rejoin (client side). A pairing is persistent: once the owner has approved
 * a contact, that contact can be re-admitted after a terminal auth failure
 * (refresh family burned by reuse detection, 401 terminal, quarantine) WITHOUT
 * re-running the full pairing flow — no new PIN, nothing for the invitee to read
 * aloud.
 *
 * Two roles, both dependency-injected and free of Obsidian/DOM so they unit
 * test in isolation:
 *
 * - Owner: `requestRejoinGrant` calls `POST /owner/rejoin-grants` for a known
 *   contact and reports "waiting" — the owner UI then shows "waiting for <name>
 *   to reconnect". Nothing secret is returned.
 * - Invitee: `RejoinController` drives the terminal-auth → rejoining → syncing
 *   transition. On the terminal-auth state the plugin polls `POST /auth/rejoin`
 *   (bounded backoff while the panel is open, e.g. every 30s) presenting the
 *   `deviceId`/`membershipId` it already holds in `data.json`; when the owner
 *   has issued a grant the redemption succeeds, a fresh refresh token is stored
 *   and sync resumes under the SAME membership (attribution/colours unchanged).
 *
 * The refresh token is generated locally and only its SHA-256 hash is sent — the
 * raw secret never reaches the server (mirrors `/owner/pair` and the invitee
 * redeem contract). The hash function is injected so this module stays pure.
 */

import type { RequestUrlFn } from './sync-transport';

/** How often the invitee re-attempts redemption while its panel is open. */
export const REJOIN_POLL_INTERVAL_MS = 30_000;

export interface RequestRejoinGrantOptions {
  readonly apiBaseUrl: string;
  readonly requestUrl: RequestUrlFn;
  readonly getAccessToken: () => Promise<string>;
  /** The known contact's membership id, from the owner's local roster. */
  readonly membershipId: string;
}

export interface RejoinGrantWaiting {
  readonly status: 'waiting';
  readonly membershipId: string;
  /** The device the server bound the grant to; non-secret, safe to display. */
  readonly boundDeviceId: string;
}

export class RejoinRequestError extends Error {
  override readonly name = 'RejoinRequestError';
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Owner action: issue a rejoin grant for a known, currently-disconnected
 * contact. On success the owner UI transitions to "waiting for <name> to
 * reconnect"; the invitee's next poll redeems the grant automatically.
 */
export async function requestRejoinGrant(
  options: RequestRejoinGrantOptions,
): Promise<RejoinGrantWaiting> {
  const token = await options.getAccessToken();
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/owner/rejoin-grants`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    throw: false,
    body: JSON.stringify({ membershipId: options.membershipId }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new RejoinRequestError(
      `Rejoin grant request failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  const body = response.json;
  const boundDeviceId =
    isRecord(body) && typeof body.boundDeviceId === 'string'
      ? body.boundDeviceId
      : '';
  return {
    boundDeviceId,
    membershipId: options.membershipId,
    status: 'waiting',
  };
}

/** The invitee-side rejoin lifecycle exposed to the connection panel. */
export type RejoinState =
  | 'terminal-auth'
  | 'rejoining'
  | 'syncing'
  | 'rejoin-failed';

export interface RejoinControllerOptions {
  readonly apiBaseUrl: string;
  readonly requestUrl: RequestUrlFn;
  /** The invitee's own membership id, read back from its persisted data.json. */
  readonly membershipId: string;
  /** The invitee's own device id, read back from its persisted data.json. */
  readonly deviceId: string;
  /**
   * The device's per-device rejoin secret (`hm_rj_…`), provisioned at onboarding
   * and persisted in SecretStorage. Presented RAW at `/auth/rejoin`; the server
   * hashes and constant-time compares it. Without it redemption is rejected, so
   * a member who merely knows this device's (membershipId, deviceId) cannot
   * impersonate it (audit finding #1).
   */
  readonly rejoinSecret: string;
  /** Generates a fresh refresh token secret (e.g. `hm_rt_…`). */
  readonly generateRefreshToken: () => string;
  /** Computes the SHA-256 hex hash of a refresh token; only the hash is sent. */
  readonly hashRefreshToken: (token: string) => string;
  /** Persists the freshly minted refresh token so sync can rotate it. */
  readonly saveRefreshToken: (token: string) => Promise<void>;
}

export interface RejoinResumed {
  readonly status: 'syncing';
  readonly membershipId: string;
  readonly vaultId: string;
}

/**
 * Drives one invitee device from its terminal auth state back to syncing. A
 * connection that has terminally failed starts here; each `attempt()` presents
 * the persisted (membershipId, deviceId) binding. Until the owner has clicked
 * Rejoin the server has no grant, so the attempt returns to `terminal-auth` and
 * the caller retries later — never a user-visible pairing.
 */
export class RejoinController {
  private readonly options: RejoinControllerOptions;
  private state: RejoinState = 'terminal-auth';

  constructor(options: RejoinControllerOptions) {
    this.options = options;
  }

  getState(): RejoinState {
    return this.state;
  }

  /**
   * Attempts a single redemption. Idempotent while in-flight: a concurrent call
   * during `rejoining`, or a call after success, is a no-op that returns the
   * current state rather than firing a second request.
   */
  async attempt(): Promise<RejoinState | RejoinResumed> {
    if (this.state === 'rejoining' || this.state === 'syncing') {
      return this.state;
    }
    this.state = 'rejoining';
    const refreshToken = this.options.generateRefreshToken();
    let response;
    try {
      response = await this.options.requestUrl({
        url: `${this.options.apiBaseUrl}/auth/rejoin`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        throw: false,
        body: JSON.stringify({
          deviceId: this.options.deviceId,
          initialRefreshTokenHash: this.options.hashRefreshToken(refreshToken),
          membershipId: this.options.membershipId,
          rejoinSecret: this.options.rejoinSecret,
        }),
      });
    } catch {
      // A transport/network failure is transient — stay terminal and retry.
      this.state = 'terminal-auth';
      return this.state;
    }
    if (response.status < 200 || response.status >= 300) {
      // No grant yet (401), rate limited or a transient 5xx: remain terminal so
      // the caller keeps polling. The owner may not have clicked Rejoin yet.
      this.state = 'terminal-auth';
      return this.state;
    }
    const body = response.json;
    if (
      !isRecord(body) ||
      typeof body.membershipId !== 'string' ||
      typeof body.vaultId !== 'string'
    ) {
      // A 200 with an unusable body cannot resume sync safely.
      this.state = 'rejoin-failed';
      return this.state;
    }
    // The invitee holds the raw refresh token; persist it so the access-token
    // provider can rotate it into a session and resume sync. The grant is
    // single-use and burned server-side on this 200, so a persistence failure
    // (SecretStorage/keychain write can throw) is terminal: the grant can never
    // be redeemed again. Surface it as 'rejoin-failed' rather than letting the
    // throw escape with the state frozen at 'rejoining' — a permanent, invisible
    // wedge where the 30 s poll early-returns 'rejoining' forever (FIX C1).
    try {
      await this.options.saveRefreshToken(refreshToken);
    } catch {
      this.state = 'rejoin-failed';
      return this.state;
    }
    this.state = 'syncing';
    return {
      membershipId: body.membershipId,
      status: 'syncing',
      vaultId: body.vaultId,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
