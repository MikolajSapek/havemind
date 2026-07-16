/**
 * Owner-only "create invitation" call against `POST /vaults/:vaultId/invitations`
 * (F8-02c), authenticated with a Bearer access token. It returns a copyable
 * invitation envelope (`v1.…`) built from the server-issued invitation token and
 * the server origin, plus the 15-minute expiry.
 *
 * The invitation token is a secret: it is wrapped into the envelope and returned
 * to the caller for display, and is never written to logs (`plan/01` rule 6).
 */

import { buildInviteEnvelope } from '../onboarding/invite';
import type { RequestUrlFn } from './sync-transport';

export interface CreateInvitationOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly serverOrigin: string;
  readonly vaultId: string;
  readonly getAccessToken: () => Promise<string>;
  readonly intendedRole?: 'editor' | 'owner';
  readonly intendedMemberDisplayName?: string;
}

export interface CreatedInvitation {
  /** Canonical `v1.…` envelope to hand to the invitee (contains the secret). */
  readonly envelope: string;
  /** ISO-8601 expiry; the invitation is single-use and valid ~15 minutes. */
  readonly expiresAt: string;
  /**
   * Server-issued invitation id (a UUID, not a secret). The owner needs it to
   * approve the joining device via `POST …/invitations/:invitationId/approve`.
   */
  readonly invitationId: string;
}

export class CreateInvitationError extends Error {
  override readonly name = 'CreateInvitationError';
}

export async function createVaultInvitation(
  options: CreateInvitationOptions,
): Promise<CreatedInvitation> {
  const token = await options.getAccessToken();
  const body: Record<string, string> = {};
  if (options.intendedRole !== undefined) body.intendedRole = options.intendedRole;
  if (options.intendedMemberDisplayName !== undefined) {
    body.intendedMemberDisplayName = options.intendedMemberDisplayName;
  }

  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/vaults/${options.vaultId}/invitations`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    throw: false,
    body: JSON.stringify(body),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new CreateInvitationError(
      `Invitation creation returned HTTP ${response.status}.`,
    );
  }

  const json = response.json;
  if (
    !isRecord(json) ||
    typeof json.invitationToken !== 'string' ||
    typeof json.expiresAt !== 'string' ||
    typeof json.invitationId !== 'string'
  ) {
    throw new CreateInvitationError('Invitation response was malformed.');
  }

  let envelope: string;
  try {
    envelope = buildInviteEnvelope({
      serverOrigin: options.serverOrigin,
      invitationToken: json.invitationToken,
    });
  } catch (error) {
    throw new CreateInvitationError(
      'Server returned an invalid invitation token.',
      { cause: error },
    );
  }

  return {
    envelope,
    expiresAt: json.expiresAt,
    invitationId: json.invitationId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
