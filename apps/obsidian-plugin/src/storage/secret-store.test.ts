import { describe, expect, it, vi } from 'vitest';

import {
  ObsidianSecretStore,
  type SecretReferenceRepository,
  type SecretReferenceState,
  type SecretStoragePort,
} from './secret-store';

const CLIENT_ID = '8f09ae38-f78e-4cfe-9174-69f064295e02';
const ACTIVE_TOKEN = 'refresh-token-active-value';
const SUCCESSOR_TOKEN = 'refresh-token-successor-value';

class MemorySecretStorage implements SecretStoragePort {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ id: string; secret: string }> = [];
  failNextWrite = false;

  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }

  listSecrets(): string[] {
    return [...this.values.keys()];
  }

  setSecret(id: string, secret: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('Injected SecretStorage failure.');
    }
    this.writes.push({ id, secret });
    this.values.set(id, secret);
  }
}

class MemoryReferenceRepository implements SecretReferenceRepository {
  state: SecretReferenceState | null = null;
  failNextWrite = false;

  async readSecretReferences(): Promise<SecretReferenceState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async writeSecretReferences(state: SecretReferenceState): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('Injected settings persistence failure.');
    }
    this.state = structuredClone(state);
  }
}

describe('storage ObsidianSecretStore', () => {
  it('stores only a SecretStorage reference in non-secret settings', async () => {
    const fixture = createFixture();

    await fixture.store.connect(ACTIVE_TOKEN);

    const activeId = fixture.references.state?.activeSecretId;
    expect(activeId).toMatch(
      /^havemind-8f09ae38-f78e-4cfe-9174-69f064295e02-refresh-[a-z0-9-]+$/,
    );
    expect(fixture.secretStorage.getSecret(activeId ?? '')).toBe(ACTIVE_TOKEN);
    expect(JSON.stringify(fixture.references.state)).not.toContain(ACTIVE_TOKEN);
    await expect(fixture.store.getActiveToken()).resolves.toBe(ACTIVE_TOKEN);
  });

  it('durably stages a successor and resumes the same pending rotation after restart', async () => {
    const fixture = createFixture();
    await fixture.store.connect(ACTIVE_TOKEN);

    await fixture.store.stageRotation({
      rotationId: 'rotation-01',
      successorToken: SUCCESSOR_TOKEN,
    });

    expect(fixture.references.state?.activeSecretId).not.toBe(
      fixture.references.state?.pendingRotation?.secretId,
    );
    expect(fixture.references.state?.pendingRotation?.rotationId).toBe(
      'rotation-01',
    );
    expect(JSON.stringify(fixture.references.state)).not.toContain(
      SUCCESSOR_TOKEN,
    );

    const restarted = createStore(
      fixture.secretStorage,
      fixture.references,
      vi.fn(() => 'unused-after-restart'),
    );
    await expect(restarted.getPendingRotation()).resolves.toEqual({
      rotationId: 'rotation-01',
      successorToken: SUCCESSOR_TOKEN,
    });

    await expect(
      restarted.stageRotation({
        rotationId: 'rotation-01',
        successorToken: SUCCESSOR_TOKEN,
      }),
    ).resolves.toBeUndefined();
    await expect(
      restarted.stageRotation({
        rotationId: 'rotation-01',
        successorToken: 'different-successor',
      }),
    ).rejects.toMatchObject({ code: 'rotation-conflict' });
  });

  it('keeps a pending successor recoverable when promotion persistence fails', async () => {
    const fixture = createFixture();
    await fixture.store.connect(ACTIVE_TOKEN);
    await fixture.store.stageRotation({
      rotationId: 'rotation-02',
      successorToken: SUCCESSOR_TOKEN,
    });
    const oldSecretId = fixture.references.state?.activeSecretId ?? '';
    fixture.references.failNextWrite = true;

    await expect(
      fixture.store.commitRotation('rotation-02'),
    ).rejects.toMatchObject({ code: 'reference-write-failed' });

    expect(fixture.secretStorage.getSecret(oldSecretId)).toBe(ACTIVE_TOKEN);
    await expect(fixture.store.getPendingRotation()).resolves.toEqual({
      rotationId: 'rotation-02',
      successorToken: SUCCESSOR_TOKEN,
    });

    await fixture.store.commitRotation('rotation-02');
    await expect(fixture.store.getActiveToken()).resolves.toBe(SUCCESSOR_TOKEN);
    await expect(fixture.store.getPendingRotation()).resolves.toBeNull();
  });

  it('keeps the promoted successor active if clearing the revoked predecessor fails', async () => {
    const fixture = createFixture();
    await fixture.store.connect(ACTIVE_TOKEN);
    await fixture.store.stageRotation({
      rotationId: 'rotation-cleanup',
      successorToken: SUCCESSOR_TOKEN,
    });
    const oldSecretId = fixture.references.state?.activeSecretId ?? '';
    fixture.secretStorage.failNextWrite = true;

    await expect(
      fixture.store.commitRotation('rotation-cleanup'),
    ).resolves.toBeUndefined();

    expect(fixture.secretStorage.getSecret(oldSecretId)).toBe(ACTIVE_TOKEN);
    await expect(fixture.store.getActiveToken()).resolves.toBe(SUCCESSOR_TOKEN);
    await expect(fixture.store.getPendingRotation()).resolves.toBeNull();
  });

  it('overwrites active and pending credentials before removing references on disconnect', async () => {
    const fixture = createFixture();
    await fixture.store.connect(ACTIVE_TOKEN);
    await fixture.store.stageRotation({
      rotationId: 'rotation-03',
      successorToken: SUCCESSOR_TOKEN,
    });
    const activeId = fixture.references.state?.activeSecretId ?? '';
    const pendingId = fixture.references.state?.pendingRotation?.secretId ?? '';

    await fixture.store.disconnect();

    expect(fixture.secretStorage.getSecret(activeId)).toBe('');
    expect(fixture.secretStorage.getSecret(pendingId)).toBe('');
    expect(fixture.references.state).toEqual({
      activeSecretId: null,
      pendingRotation: null,
      version: 1,
    });
    await expect(fixture.store.getActiveToken()).resolves.toBeNull();
  });

  it('does not claim disconnect when SecretStorage cannot clear a credential', async () => {
    const fixture = createFixture();
    await fixture.store.connect(ACTIVE_TOKEN);
    const priorReferences = structuredClone(fixture.references.state);
    fixture.secretStorage.failNextWrite = true;

    await expect(fixture.store.disconnect()).rejects.toMatchObject({
      code: 'secret-write-failed',
    });
    expect(fixture.references.state).toEqual(priorReferences);
  });

  it('never logs or places raw credentials in failure messages', async () => {
    const fixture = createFixture();
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    fixture.references.failNextWrite = true;

    const failure = await fixture.store.connect(ACTIVE_TOKEN).catch((error: unknown) =>
      String(error),
    );

    expect(failure).not.toContain(ACTIVE_TOKEN);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('rejects malformed setup and refuses to replace an active credential', async () => {
    const fixture = createFixture();

    expect(
      () =>
        new ObsidianSecretStore({
          clientInstanceId: 'unsafe',
          generateSecretSuffix: () => 'secret',
          references: fixture.references,
          secretStorage: fixture.secretStorage,
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid-reference-state' }));
    await expect(fixture.store.connect('')).rejects.toMatchObject({
      code: 'invalid-secret',
    });

    await fixture.store.connect(ACTIVE_TOKEN);
    await expect(fixture.store.connect('another-token')).rejects.toMatchObject({
      code: 'already-connected',
    });
  });

  it('blocks rotation while disconnected, missing, or superseded by another pending rotation', async () => {
    const fixture = createFixture();

    await expect(
      fixture.store.stageRotation({
        rotationId: 'rotation-disconnected',
        successorToken: SUCCESSOR_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'disconnected' });

    await fixture.store.connect(ACTIVE_TOKEN);
    const activeId = fixture.references.state?.activeSecretId ?? '';
    fixture.secretStorage.values.set(activeId, '');
    await expect(
      fixture.store.stageRotation({
        rotationId: 'rotation-missing',
        successorToken: SUCCESSOR_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'disconnected' });

    fixture.secretStorage.values.set(activeId, ACTIVE_TOKEN);
    await fixture.store.stageRotation({
      rotationId: 'rotation-first',
      successorToken: SUCCESSOR_TOKEN,
    });
    await expect(
      fixture.store.stageRotation({
        rotationId: 'rotation-second',
        successorToken: 'another-successor',
      }),
    ).rejects.toMatchObject({ code: 'rotation-pending' });
  });

  it('rejects missing rotation state and malformed stored references', async () => {
    const fixture = createFixture();

    await expect(
      fixture.store.commitRotation('rotation-absent'),
    ).rejects.toMatchObject({ code: 'rotation-not-found' });

    fixture.references.state = {
      activeSecretId: null,
      pendingRotation: {
        rotationId: 'rotation-invalid',
        secretId: 'havemind-secret-without-active',
      },
      version: 1,
    };
    await expect(fixture.store.getActiveToken()).rejects.toMatchObject({
      code: 'invalid-reference-state',
    });

    fixture.references.state = 'corrupt' as unknown as SecretReferenceState;
    await expect(fixture.store.getActiveToken()).rejects.toMatchObject({
      code: 'invalid-reference-state',
    });
  });

  it('treats repeated disconnect as a no-op and supports default secret ID generation', async () => {
    const secretStorage = new MemorySecretStorage();
    const references = new MemoryReferenceRepository();
    const store = new ObsidianSecretStore({
      clientInstanceId: CLIENT_ID,
      references,
      secretStorage,
    });

    await expect(store.disconnect()).resolves.toBeUndefined();
    await store.connect(ACTIVE_TOKEN);
    await store.disconnect();
    await expect(store.disconnect()).resolves.toBeUndefined();
    expect(references.state?.pendingRotation).toBeNull();
  });
});

function createFixture(): {
  references: MemoryReferenceRepository;
  secretStorage: MemorySecretStorage;
  store: ObsidianSecretStore;
} {
  const secretStorage = new MemorySecretStorage();
  const references = new MemoryReferenceRepository();
  const suffixes = ['active-secret', 'pending-secret'];
  const generateSuffix = vi.fn(() => suffixes.shift() ?? 'fallback-secret');
  return {
    references,
    secretStorage,
    store: createStore(secretStorage, references, generateSuffix),
  };
}

function createStore(
  secretStorage: MemorySecretStorage,
  references: MemoryReferenceRepository,
  generateSuffix: () => string,
): ObsidianSecretStore {
  return new ObsidianSecretStore({
    clientInstanceId: CLIENT_ID,
    generateSecretSuffix: generateSuffix,
    references,
    secretStorage,
  });
}
