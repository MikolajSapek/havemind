import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      .find((id) => id.includes('-rotation'));
    expect(key).toBeDefined();
    if (key !== undefined) {
      storage.setSecret(key, '{not valid json');
    }
    expect(await secrets.getPendingRotation()).toBeNull();
  });

  describe('SecretStorage 64-char key ceiling (regression guard)', () => {
    // Obsidian's SecretStorage rejects any key over 64 chars, and only
    // accepts lowercase letters, numbers and dashes. clientInstanceId is a
    // 36-char UUID, which is the realistic worst case for key length.
    const UUID_CID = '123e4567-e89b-12d3-a456-426614174000';

    it('keeps every generated key within the 64-char, lowercase-alnum-dash limit', async () => {
      const uuidStorage = new SecretStorage();
      const uuidSecrets = new ObsidianOnboardingSecrets({
        clientInstanceId: UUID_CID,
        secretStorage: uuidStorage,
      });

      await uuidSecrets.saveInvitationEnvelope('v1.abc');
      await uuidSecrets.savePendingCredential('hm_pd_x');
      await uuidSecrets.saveRefreshToken('hm_rt_x');
      await uuidSecrets.savePendingRotation({
        refreshToken: 'hm_rt_cur',
        rotationId: 'rot-1',
        successorRefreshToken: 'hm_rt_next',
      });

      const keys = uuidStorage.listSecrets();
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.length).toBeLessThanOrEqual(64);
        expect(key).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it('calls setSecret with a <=64-char key for savePendingRotation and clearPendingRotation', async () => {
      const uuidStorage = new SecretStorage();
      const setSecretSpy = vi.spyOn(uuidStorage, 'setSecret');
      const uuidSecrets = new ObsidianOnboardingSecrets({
        clientInstanceId: UUID_CID,
        secretStorage: uuidStorage,
      });

      await expect(
        uuidSecrets.savePendingRotation({
          refreshToken: 'hm_rt_cur',
          rotationId: 'rot-1',
          successorRefreshToken: 'hm_rt_next',
        }),
      ).resolves.not.toThrow();
      await expect(uuidSecrets.clearPendingRotation()).resolves.not.toThrow();

      expect(setSecretSpy).toHaveBeenCalled();
      for (const call of setSecretSpy.mock.calls) {
        const key = call[0];
        expect(key.length).toBeLessThanOrEqual(64);
        expect(key).toMatch(/^[a-z0-9-]+$/);
      }
    });
  });
});
