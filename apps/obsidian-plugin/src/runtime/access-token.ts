/**
 * Turns the durable refresh token into short-lived access tokens by rotating
 * against `POST /auth/refresh` (F8-02c). Each refresh presents the current
 * refresh token plus a freshly generated `rotationId` and successor token; on
 * success the successor becomes the new stored refresh token (the server has
 * burned the old one). The access token is cached until shortly before it
 * expires so a sync burst does not rotate on every request.
 *
 * A failed rotation throws and leaves the stored refresh token untouched, so a
 * transient failure never discards a still-valid credential.
 */

import type { RequestUrlFn } from './sync-transport';

const EXPIRY_SKEW_MS = 30_000;

export interface RefreshTokenAccessProviderOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly getRefreshToken: () => Promise<string | null>;
  readonly saveRefreshToken: (value: string) => Promise<void>;
  readonly generateRotationId: () => string;
  readonly generateSuccessorToken: () => string;
  readonly now?: () => number;
}

export class AccessTokenError extends Error {
  override readonly name = 'AccessTokenError';
}

export class RefreshTokenAccessProvider {
  private readonly options: RefreshTokenAccessProviderOptions;
  private readonly now: () => number;
  private cachedToken: string | null = null;
  private cachedExpiry = 0;

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

  private async rotate(): Promise<string> {
    const refreshToken = await this.options.getRefreshToken();
    if (refreshToken === null) {
      throw new AccessTokenError('No refresh token is stored.');
    }
    const successorRefreshToken = this.options.generateSuccessorToken();
    const response = await this.options.requestUrl({
      url: `${this.options.apiBaseUrl}/auth/refresh`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      throw: false,
      body: JSON.stringify({
        refreshToken,
        rotationId: this.options.generateRotationId(),
        successorRefreshToken,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AccessTokenError(`Refresh failed with HTTP ${response.status}.`);
    }
    const body = response.json;
    if (
      !isRecord(body) ||
      typeof body.accessToken !== 'string' ||
      typeof body.accessExpiresAt !== 'string'
    ) {
      throw new AccessTokenError('Refresh response was malformed.');
    }
    // The server has rotated the family; persist the successor as current.
    await this.options.saveRefreshToken(successorRefreshToken);
    this.cachedToken = body.accessToken;
    this.cachedExpiry = Date.parse(body.accessExpiresAt);
    return body.accessToken;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
