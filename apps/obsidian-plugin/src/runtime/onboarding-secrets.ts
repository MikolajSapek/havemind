/**
 * `OnboardingSecretsPort` over Obsidian SecretStorage. The invitation envelope,
 * pending device credential and refresh token are all secrets, so they live in
 * SecretStorage — never in `data.json` (`plan/05-plugin-polaczenie-i-sync.md`,
 * rule 6). Keys are namespaced by client instance id so multiple vaults on one
 * machine never collide.
 */

import type { OnboardingSecretsPort } from '../onboarding/controller';
import type { PendingRotation } from './access-token';
import type { SecretStoragePort } from '../storage/secret-store';
import { isValidClientInstanceId } from '../storage/client-store';

export interface ObsidianOnboardingSecretsOptions {
  readonly clientInstanceId: string;
  readonly secretStorage: SecretStoragePort;
}

export class ObsidianOnboardingSecrets implements OnboardingSecretsPort {
  private readonly secretStorage: SecretStoragePort;
  private readonly invitationKey: string;
  private readonly pendingKey: string;
  private readonly refreshKey: string;
  private readonly pendingRotationKey: string;

  constructor(options: ObsidianOnboardingSecretsOptions) {
    if (!isValidClientInstanceId(options.clientInstanceId)) {
      throw new Error(
        'A valid client_instance_id is required for onboarding secret namespacing.',
      );
    }
    this.secretStorage = options.secretStorage;
    const prefix = `havemind-${options.clientInstanceId}-onb`;
    this.invitationKey = `${prefix}-invitation`;
    this.pendingKey = `${prefix}-pending`;
    this.refreshKey = `${prefix}-refresh`;
    this.pendingRotationKey = `${prefix}-pending-rotation`;
  }

  async getInvitationEnvelope(): Promise<string | null> {
    return this.read(this.invitationKey);
  }

  async saveInvitationEnvelope(value: string): Promise<void> {
    this.write(this.invitationKey, value);
  }

  async clearInvitationEnvelope(): Promise<void> {
    this.write(this.invitationKey, '');
  }

  async getPendingCredential(): Promise<string | null> {
    return this.read(this.pendingKey);
  }

  async savePendingCredential(value: string): Promise<void> {
    this.write(this.pendingKey, value);
  }

  async clearPendingCredential(): Promise<void> {
    this.write(this.pendingKey, '');
  }

  async getRefreshToken(): Promise<string | null> {
    return this.read(this.refreshKey);
  }

  async saveRefreshToken(value: string): Promise<void> {
    this.write(this.refreshKey, value);
  }

  /**
   * The in-flight refresh rotation record (rule 6: secret material, so it lives
   * in SecretStorage alongside the refresh token, never in `data.json`). Stored
   * as JSON; a malformed or absent value reads back as null.
   */
  async getPendingRotation(): Promise<PendingRotation | null> {
    const raw = this.read(this.pendingRotationKey);
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).refreshToken === 'string' &&
        typeof (parsed as Record<string, unknown>).rotationId === 'string' &&
        typeof (parsed as Record<string, unknown>).successorRefreshToken ===
          'string'
      ) {
        return parsed as PendingRotation;
      }
    } catch {
      // Corrupt record: treat as absent so a fresh rotation is minted.
    }
    return null;
  }

  async savePendingRotation(record: PendingRotation): Promise<void> {
    this.write(this.pendingRotationKey, JSON.stringify(record));
  }

  async clearPendingRotation(): Promise<void> {
    this.write(this.pendingRotationKey, '');
  }

  private read(key: string): string | null {
    const value = this.secretStorage.getSecret(key);
    return value === null || value.length === 0 ? null : value;
  }

  private write(key: string, value: string): void {
    this.secretStorage.setSecret(key, value);
  }
}
