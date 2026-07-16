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
});
