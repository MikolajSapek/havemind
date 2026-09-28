import { describe, expect, it } from 'vitest';

import { PluginDataOnboardingStore } from './onboarding-store';
import type { DurableOnboardingState } from '../onboarding/controller';

function connectedState(): DurableOnboardingState {
  return {
    apiBaseUrl: 'https://host',
    expiresAt: '2026-07-16T10:00:00.000Z',
    intendedMemberDisplayName: 'Bob',
    inviterDisplayName: 'Alice',
    memberId: '22222222-2222-4222-8222-222222222222',
    protocolVersion: { major: 1, minor: 0 },
    serverName: 'Pilot',
    serverOrigin: 'https://host',
    vaultId: '11111111-1111-4111-8111-111111111111',
    vaultName: 'Pilot vault',
    deviceId: '33333333-3333-4333-8333-333333333333',
    downloadedItems: 2,
    phase: 'connected',
    version: 1,
  };
}

class MemoryPersist {
  saved: unknown = null;
  async load(): Promise<unknown> {
    return this.saved;
  }
  async save(data: unknown): Promise<void> {
    this.saved = JSON.parse(JSON.stringify(data)) as unknown;
  }
}

describe('PluginDataOnboardingStore', () => {
  it('returns null before any state is stored', async () => {
    const store = new PluginDataOnboardingStore({ persist: new MemoryPersist() });
    expect(await store.loadState()).toBeNull();
  });

  it('forgets the stored state durably on clearState', async () => {
    const persist = new MemoryPersist();
    const store = new PluginDataOnboardingStore({ persist });
    await store.saveState(connectedState());
    await store.clearState();
    const reopened = new PluginDataOnboardingStore({ persist });
    expect(await reopened.loadState()).toBeNull();
  });

  it('persists and reloads the onboarding state', async () => {
    const persist = new MemoryPersist();
    const store = new PluginDataOnboardingStore({ persist });
    await store.saveState(connectedState());
    const reopened = new PluginDataOnboardingStore({ persist });
    expect((await reopened.loadState() as DurableOnboardingState).phase).toBe(
      'connected',
    );
  });
});
