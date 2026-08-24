/**
 * `OnboardingSecretsPort` over Obsidian SecretStorage. The invitation envelope,
 * pending device credential and refresh token are all secrets, so they live in
 * SecretStorage — never in `data.json` (`plan/05-plugin-polaczenie-i-sync.md`,
 * rule 6). Keys are namespaced by client instance id so multiple vaults on one
 * machine never collide.
 */

import type { PendingRotation } from './access-token';
import type { OnboardingSecretsPort } from '../onboarding/controller';
import type { SecretStoragePort } from '../storage/secret-store';
import { isValidClientInstanceId } from '../storage/client-store';

export interface ObsidianOnboardingSecretsOptions {
  readonly clientInstanceId: string;
  readonly secretStorage: SecretStoragePort;
}

/**
 * Durable client-side intent for an owner pairing.  It lets a retry use the
 * same refresh-token hash after the server has consumed a one-time code but
 * before this device finished writing its connection record.
 */
export interface PendingOwnerPairing {
  readonly apiBaseUrl: string;
  readonly pairingToken: string;
  readonly refreshToken: string;
}

export class ObsidianOnboardingSecrets implements OnboardingSecretsPort {
  private readonly secretStorage: SecretStoragePort;
  private readonly invitationKey: string;
  private readonly pendingKey: string;
  private readonly refreshKey: string;
  private readonly rejoinKey: string;
  private readonly pendingRotationKey: string;
  private readonly pendingOwnerPairingKey: string;

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
    // Per-device rejoin secret (F9 Rejoin hardening). Suffix kept short: prefix
    // is already 49 chars with a UUID clientInstanceId, and SecretStorage caps
    // keys at 64 chars (see pendingRotationKey note below).
    this.rejoinKey = `${prefix}-rejoin`;
    // Obsidian's SecretStorage rejects keys over 64 chars (lowercase letters,
    // numbers and dashes only). With a 36-char UUID clientInstanceId, prefix
    // is already 49 chars, so this suffix must stay short (a longer
    // `-pending-rotation` suffix pushed the total to 66, silently disabling
    // GAP-5's durable in-flight rotation on every device).
    this.pendingRotationKey = `${prefix}-rotation`;
    this.pendingOwnerPairingKey = `${prefix}-owner`;
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

  async getRejoinSecret(): Promise<string | null> {
    return this.read(this.rejoinKey);
  }

  async saveRejoinSecret(value: string): Promise<void> {
    this.write(this.rejoinKey, value);
  }

  /**
   * The in-flight refresh rotation record (rule 6: secret material, so it lives
   * in SecretStorage alongside the refresh token, never in `data.json`). An
   * invalid present record is unsafe: minting a fresh pair could burn the token
   * family after a crash, so corruption must fail closed.
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
      // Fall through to the same fail-closed error below.
    }
    throw new Error('Stored refresh rotation record is corrupt.');
  }

  async savePendingRotation(record: PendingRotation): Promise<void> {
    this.write(this.pendingRotationKey, JSON.stringify(record));
  }

  async clearPendingRotation(): Promise<void> {
    this.write(this.pendingRotationKey, '');
  }

  async getPendingOwnerPairing(): Promise<PendingOwnerPairing | null> {
    const raw = this.read(this.pendingOwnerPairingKey);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).apiBaseUrl === 'string' &&
        typeof (parsed as Record<string, unknown>).pairingToken === 'string' &&
        typeof (parsed as Record<string, unknown>).refreshToken === 'string'
      ) {
        return parsed as PendingOwnerPairing;
      }
    } catch {
      // Fall through to the safe recovery error below.
    }
    throw new Error('Stored owner pairing record is corrupt.');
  }

  async savePendingOwnerPairing(record: PendingOwnerPairing): Promise<void> {
    this.write(this.pendingOwnerPairingKey, JSON.stringify(record));
  }

  async clearPendingOwnerPairing(): Promise<void> {
    this.write(this.pendingOwnerPairingKey, '');
  }

  private read(key: string): string | null {
    const value = this.secretStorage.getSecret(key);
    return value === null || value.length === 0 ? null : value;
  }

  private write(key: string, value: string): void {
    this.secretStorage.setSecret(key, value);
  }
}
