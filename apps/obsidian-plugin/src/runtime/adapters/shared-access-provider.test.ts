import { describe, expect, it } from 'vitest';

import {
  forgetSharedAccessProvider,
  replaceSharedAccessProvider,
  sharedAccessProvider,
  type RotationSecrets,
} from './shared-access-provider';

function secrets(): RotationSecrets {
  return {
    getRefreshToken: async () => 'hm_rt_token',
    saveRefreshToken: async () => undefined,
    getPendingRotation: async () => null,
    savePendingRotation: async () => undefined,
    clearPendingRotation: async () => undefined,
  };
}

// R10: every owner action built its own refresh-token provider next to the
// sync loop's. Two providers rotating the same token at once is reuse to the
// server, which revokes the whole session; one provider per connection
// coalesces concurrent rotations into one.
describe('shared access provider', () => {
  it('hands every caller of one connection the same provider', () => {
    const plugin = {};
    const live = replaceSharedAccessProvider(plugin, 'https://a/api', secrets());
    expect(sharedAccessProvider(plugin, 'https://a/api', secrets())).toBe(live);
  });

  it('starts a fresh provider for a new connection or another server', () => {
    const plugin = {};
    const first = replaceSharedAccessProvider(plugin, 'https://a/api', secrets());
    expect(replaceSharedAccessProvider(plugin, 'https://a/api', secrets())).not.toBe(first);
    const current = sharedAccessProvider(plugin, 'https://a/api', secrets());
    expect(sharedAccessProvider(plugin, 'https://b/api', secrets())).not.toBe(current);
  });

  it('forgets the provider on reset', () => {
    const plugin = {};
    const live = replaceSharedAccessProvider(plugin, 'https://a/api', secrets());
    forgetSharedAccessProvider(plugin);
    expect(sharedAccessProvider(plugin, 'https://a/api', secrets())).not.toBe(live);
  });
});
