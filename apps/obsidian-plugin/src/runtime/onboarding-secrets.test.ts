import { beforeEach, describe, expect, it } from 'vitest';

import { ObsidianOnboardingSecrets } from './onboarding-secrets';
import { SecretStorage } from '../test/obsidian.mock';

const CID = 'client-instance-1234';

describe('ObsidianOnboardingSecrets', () => {
  let storage: SecretStorage;
  let secrets: ObsidianOnboardingSecrets;

  beforeEach(() => {
    storage = new SecretStorage();
    secrets = new ObsidianOnboardingSecrets({
      clientInstanceId: CID,
      secretStorage: storage,
    });
  });

  it('round-trips the three onboarding secrets and returns null when absent', async () => {
    expect(await secrets.getRefreshToken()).toBeNull();
    await secrets.saveRefreshToken('hm_rt_x');
    await secrets.savePendingCredential('hm_pd_x');
    await secrets.saveInvitationEnvelope('v1.abc');

    expect(await secrets.getRefreshToken()).toBe('hm_rt_x');
    expect(await secrets.getPendingCredential()).toBe('hm_pd_x');
    expect(await secrets.getInvitationEnvelope()).toBe('v1.abc');
  });

  it('clears consumed secrets so they are treated as absent', async () => {
    await secrets.savePendingCredential('hm_pd_x');
    await secrets.clearPendingCredential();
    expect(await secrets.getPendingCredential()).toBeNull();

    await secrets.saveInvitationEnvelope('v1.abc');
    await secrets.clearInvitationEnvelope();
    expect(await secrets.getInvitationEnvelope()).toBeNull();
  });

  it('namespaces every key by client instance id', async () => {
    await secrets.saveRefreshToken('hm_rt_x');
    expect(storage.listSecrets().some((id) => id.includes(CID))).toBe(true);
  });

  it('round-trips the in-flight rotation record and clears it (GAP-5)', async () => {
    expect(await secrets.getPendingRotation()).toBeNull();
    const record = {
      refreshToken: 'hm_rt_cur',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next',
    };
    await secrets.savePendingRotation(record);
    expect(await secrets.getPendingRotation()).toEqual(record);

    await secrets.clearPendingRotation();
    expect(await secrets.getPendingRotation()).toBeNull();
  });

  it('treats a malformed pending-rotation record as absent', async () => {
    await secrets.savePendingRotation({
      refreshToken: 'hm_rt_cur',
      rotationId: 'rot-1',
      successorRefreshToken: 'hm_rt_next',
    });
    // Corrupt the stored JSON directly in the backing store.
    const key = storage
      .listSecrets()
      .find((id) => id.includes('pending-rotation'));
    expect(key).toBeDefined();
    if (key !== undefined) {
      storage.setSecret(key, '{not valid json');
    }
    expect(await secrets.getPendingRotation()).toBeNull();
  });
});
