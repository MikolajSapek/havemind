/**
 * One refresh-token access provider per connection (R10).
 *
 * The sync loop and every owner action used to build their own provider over
 * the same stored refresh token. Two providers rotating at once present the
 * same token twice, which the server treats as reuse and answers by revoking
 * the whole session. One provider coalesces concurrent rotations into one
 * (`RefreshTokenAccessProvider` keeps a single rotation in flight), so every
 * caller of a connection shares it.
 */

import { RefreshTokenAccessProvider } from '../access-token';
import type { ObsidianOnboardingSecrets } from '../onboarding-secrets';

import { createRequestUrlFn } from './request-url';
import {
  generateRefreshTokenValue,
  generateRotationIdValue,
} from './tokens';

/** The stored-secret surface a rotation reads and writes. */
export type RotationSecrets = Pick<
  ObsidianOnboardingSecrets,
  | 'getRefreshToken'
  | 'saveRefreshToken'
  | 'getPendingRotation'
  | 'savePendingRotation'
  | 'clearPendingRotation'
>;

interface Registered {
  readonly apiBaseUrl: string;
  readonly provider: RefreshTokenAccessProvider;
}

const providers = new WeakMap<object, Registered>();

function buildAccessProvider(
  apiBaseUrl: string,
  secrets: RotationSecrets,
): RefreshTokenAccessProvider {
  return new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl,
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
}

/** The connection's provider, or a new one registered for it. */
export function sharedAccessProvider(
  owner: object,
  apiBaseUrl: string,
  secrets: RotationSecrets,
): RefreshTokenAccessProvider {
  const registered = providers.get(owner);
  if (registered !== undefined && registered.apiBaseUrl === apiBaseUrl) {
    return registered.provider;
  }
  return replaceSharedAccessProvider(owner, apiBaseUrl, secrets);
}

/** A fresh provider for a new connection, replacing any earlier one. */
export function replaceSharedAccessProvider(
  owner: object,
  apiBaseUrl: string,
  secrets: RotationSecrets,
): RefreshTokenAccessProvider {
  const provider = buildAccessProvider(apiBaseUrl, secrets);
  providers.set(owner, { apiBaseUrl, provider });
  return provider;
}

/** Drops the provider, so nothing reuses a token cached for a reset pairing. */
export function forgetSharedAccessProvider(owner: object): void {
  providers.delete(owner);
}
