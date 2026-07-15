import type { SecretStorage } from 'obsidian';

import { isValidClientInstanceId } from './client-store';

const SECRET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_SECRET_ID_ATTEMPTS = 8;

export type SecretStoragePort = Pick<
  SecretStorage,
  'getSecret' | 'listSecrets' | 'setSecret'
>;

export interface PendingSecretRotationReference {
  rotationId: string;
  secretId: string;
}

export interface SecretReferenceState {
  activeSecretId: string | null;
  pendingRotation: PendingSecretRotationReference | null;
  version: 1;
}

export interface SecretReferenceRepository {
  readSecretReferences(): Promise<unknown>;
  writeSecretReferences(state: SecretReferenceState): Promise<void>;
}

export interface RotationSecretInput {
  rotationId: string;
  successorToken: string;
}

export interface PendingRotationSecret {
  rotationId: string;
  successorToken: string;
}

export type SecretStoreErrorCode =
  | 'already-connected'
  | 'disconnected'
  | 'invalid-reference-state'
  | 'invalid-secret'
  | 'reference-read-failed'
  | 'reference-write-failed'
  | 'rotation-conflict'
  | 'rotation-not-found'
  | 'rotation-pending'
  | 'secret-read-failed'
  | 'secret-write-failed';

export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';

  constructor(
    readonly code: SecretStoreErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface ObsidianSecretStoreOptions {
  clientInstanceId: string;
  generateSecretSuffix?: () => string;
  references: SecretReferenceRepository;
  secretStorage: SecretStoragePort;
}

export class ObsidianSecretStore {
  private readonly clientInstanceId: string;
  private readonly generateSecretSuffix: () => string;
  private readonly references: SecretReferenceRepository;
  private readonly secretStorage: SecretStoragePort;

  constructor(options: ObsidianSecretStoreOptions) {
    if (!isValidClientInstanceId(options.clientInstanceId)) {
      throw new SecretStoreError(
        'invalid-reference-state',
        'A valid client_instance_id is required for SecretStorage namespacing.',
      );
    }
    this.clientInstanceId = options.clientInstanceId;
    this.generateSecretSuffix =
      options.generateSecretSuffix ?? generateSecretSuffix;
    this.references = options.references;
    this.secretStorage = options.secretStorage;
  }

  async connect(refreshToken: string): Promise<void> {
    assertSecretValue(refreshToken);
    const state = await this.readReferences();
    if (state.activeSecretId !== null || state.pendingRotation !== null) {
      throw new SecretStoreError(
        'already-connected',
        'A refresh credential is already configured.',
      );
    }

    const secretId = this.createUniqueSecretId(state);
    this.writeSecret(secretId, refreshToken);
    try {
      await this.writeReferences({
        activeSecretId: secretId,
        pendingRotation: null,
        version: 1,
      });
    } catch (error) {
      this.clearSecretBestEffort(secretId);
      throw error;
    }
  }

  async getActiveToken(): Promise<string | null> {
    const state = await this.readReferences();
    if (state.activeSecretId === null) return null;
    return this.readSecret(state.activeSecretId);
  }

  async stageRotation(input: RotationSecretInput): Promise<void> {
    assertRotationId(input.rotationId);
    assertSecretValue(input.successorToken);
    const state = await this.readReferences();
    if (state.activeSecretId === null) {
      throw new SecretStoreError(
        'disconnected',
        'A rotation cannot start without an active refresh credential.',
      );
    }

    if (state.pendingRotation) {
      if (state.pendingRotation.rotationId !== input.rotationId) {
        throw new SecretStoreError(
          'rotation-pending',
          'Another refresh credential rotation is already pending.',
        );
      }
      const existingSuccessor = this.readSecret(
        state.pendingRotation.secretId,
      );
      if (existingSuccessor === null) {
        throw new SecretStoreError(
          'invalid-secret',
          'The pending refresh credential is unavailable.',
        );
      }
      if (existingSuccessor !== input.successorToken) {
        throw new SecretStoreError(
          'rotation-conflict',
          'The pending rotation ID is already bound to another credential.',
        );
      }
      return;
    }

    if (this.readSecret(state.activeSecretId) === null) {
      throw new SecretStoreError(
        'disconnected',
        'The active refresh credential is unavailable.',
      );
    }

    const secretId = this.createUniqueSecretId(state);
    this.writeSecret(secretId, input.successorToken);
    try {
      await this.writeReferences({
        ...state,
        pendingRotation: {
          rotationId: input.rotationId,
          secretId,
        },
      });
    } catch (error) {
      this.clearSecretBestEffort(secretId);
      throw error;
    }
  }

  async getPendingRotation(): Promise<PendingRotationSecret | null> {
    const state = await this.readReferences();
    if (!state.pendingRotation) return null;
    const successorToken = this.readSecret(state.pendingRotation.secretId);
    if (successorToken === null) {
      throw new SecretStoreError(
        'invalid-secret',
        'The pending refresh credential is unavailable.',
      );
    }
    return {
      rotationId: state.pendingRotation.rotationId,
      successorToken,
    };
  }

  async commitRotation(rotationId: string): Promise<void> {
    assertRotationId(rotationId);
    const state = await this.readReferences();
    if (
      state.activeSecretId === null ||
      !state.pendingRotation ||
      state.pendingRotation.rotationId !== rotationId
    ) {
      throw new SecretStoreError(
        'rotation-not-found',
        'The requested pending refresh credential rotation was not found.',
      );
    }

    if (this.readSecret(state.pendingRotation.secretId) === null) {
      throw new SecretStoreError(
        'invalid-secret',
        'The pending refresh credential is unavailable.',
      );
    }

    await this.writeReferences({
      activeSecretId: state.pendingRotation.secretId,
      pendingRotation: null,
      version: 1,
    });
    this.clearSecretBestEffort(state.activeSecretId);
  }

  async disconnect(): Promise<void> {
    const state = await this.readReferences();
    if (state.activeSecretId === null && state.pendingRotation === null) return;

    if (state.activeSecretId !== null) {
      this.writeSecret(state.activeSecretId, '');
    }
    if (state.pendingRotation !== null) {
      this.writeSecret(state.pendingRotation.secretId, '');
    }

    await this.writeReferences(disconnectedReferences());
  }

  private createUniqueSecretId(state: SecretReferenceState): string {
    let existingSecretIds: Set<string>;
    try {
      existingSecretIds = new Set(this.secretStorage.listSecrets());
    } catch (error) {
      throw new SecretStoreError(
        'secret-read-failed',
        'Obsidian SecretStorage could not list credential references.',
        error,
      );
    }

    if (state.activeSecretId) existingSecretIds.add(state.activeSecretId);
    if (state.pendingRotation) {
      existingSecretIds.add(state.pendingRotation.secretId);
    }

    for (let attempt = 0; attempt < MAX_SECRET_ID_ATTEMPTS; attempt += 1) {
      const suffix = this.generateSecretSuffix();
      const secretId = `havemind-${this.clientInstanceId}-refresh-${suffix}`;
      if (!isValidSecretId(secretId)) {
        throw new SecretStoreError(
          'invalid-reference-state',
          'Generated SecretStorage IDs must be lowercase alphanumeric with hyphens.',
        );
      }
      if (!existingSecretIds.has(secretId)) return secretId;
    }

    throw new SecretStoreError(
      'invalid-reference-state',
      'A unique SecretStorage reference could not be generated.',
    );
  }

  private readSecret(secretId: string): string | null {
    try {
      const value = this.secretStorage.getSecret(secretId);
      return value === null || value.length === 0 ? null : value;
    } catch (error) {
      throw new SecretStoreError(
        'secret-read-failed',
        'Obsidian SecretStorage could not read a credential.',
        error,
      );
    }
  }

  private writeSecret(secretId: string, secret: string): void {
    try {
      this.secretStorage.setSecret(secretId, secret);
    } catch {
      throw new SecretStoreError(
        'secret-write-failed',
        'Obsidian SecretStorage could not persist a credential change.',
      );
    }
  }

  private clearSecretBestEffort(secretId: string): void {
    try {
      this.secretStorage.setSecret(secretId, '');
    } catch {
      // The unreferenced value cannot be used by Havemind and is never logged.
    }
  }

  private async readReferences(): Promise<SecretReferenceState> {
    let state: unknown;
    try {
      state = await this.references.readSecretReferences();
    } catch (error) {
      throw new SecretStoreError(
        'reference-read-failed',
        'Havemind could not read its non-secret credential references.',
        error,
      );
    }

    if (state === null) return disconnectedReferences();
    assertReferenceState(state);
    return state;
  }

  private async writeReferences(state: SecretReferenceState): Promise<void> {
    assertReferenceState(state);
    try {
      await this.references.writeSecretReferences(state);
    } catch (error) {
      throw new SecretStoreError(
        'reference-write-failed',
        'Havemind could not persist its non-secret credential references.',
        error,
      );
    }
  }
}

function disconnectedReferences(): SecretReferenceState {
  return {
    activeSecretId: null,
    pendingRotation: null,
    version: 1,
  };
}

function assertReferenceState(
  state: unknown,
): asserts state is SecretReferenceState {
  if (!isRecord(state)) {
    throwInvalidReferenceState();
  }

  const activeSecretId = state.activeSecretId;
  const pendingRotation = state.pendingRotation;
  const validActive =
    activeSecretId === null ||
    (typeof activeSecretId === 'string' && isValidSecretId(activeSecretId));
  const validPending =
    pendingRotation === null ||
    (isRecord(pendingRotation) &&
      typeof pendingRotation.secretId === 'string' &&
      isValidSecretId(pendingRotation.secretId) &&
      typeof pendingRotation.rotationId === 'string' &&
      ROTATION_ID_PATTERN.test(pendingRotation.rotationId));
  const validRelationship =
    pendingRotation === null ||
    (isRecord(pendingRotation) &&
      typeof activeSecretId === 'string' &&
      activeSecretId !== pendingRotation.secretId);

  if (
    state.version !== 1 ||
    !validActive ||
    !validPending ||
    !validRelationship
  ) {
    throwInvalidReferenceState();
  }
}

function throwInvalidReferenceState(): never {
  throw new SecretStoreError(
    'invalid-reference-state',
    'Stored SecretStorage references are malformed.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRotationId(rotationId: string): void {
  if (!ROTATION_ID_PATTERN.test(rotationId)) {
    throw new SecretStoreError(
      'rotation-not-found',
      'rotation_id must be a non-empty URL-safe identifier.',
    );
  }
}

function assertSecretValue(secret: string): void {
  if (secret.length === 0) {
    throw new SecretStoreError(
      'invalid-secret',
      'A non-empty refresh credential is required.',
    );
  }
}

function isValidSecretId(secretId: string): boolean {
  return secretId.length > 0 && SECRET_ID_PATTERN.test(secretId);
}

function generateSecretSuffix(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SecretStoreError(
      'secret-write-failed',
      'Secure random UUID generation is unavailable in this Obsidian runtime.',
    );
  }
  return globalThis.crypto.randomUUID();
}
