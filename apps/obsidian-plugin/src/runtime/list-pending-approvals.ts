/**
 * Owner-only, secret-free recovery read for devices awaiting approval. It lets
 * the pane restore its queue after a plugin restart without persisting invite
 * envelopes, verification phrases or pending-device credentials locally.
 */

import type { RequestUrlFn } from './sync-transport';

export interface PendingApproval {
  readonly invitationId: string;
  readonly expiresAt: string;
  readonly intendedMemberDisplayName?: string;
  readonly intendedRole?: 'editor' | 'owner';
}

export interface ListPendingApprovalsOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAccessToken: () => Promise<string>;
}

export class ListPendingApprovalsError extends Error {
  override readonly name = 'ListPendingApprovalsError';
}

export async function listPendingApprovals(
  options: ListPendingApprovalsOptions,
): Promise<readonly PendingApproval[]> {
  const token = await options.getAccessToken();
  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/vaults/${options.vaultId}/invitations/pending`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ListPendingApprovalsError(
      `Pending approvals returned HTTP ${response.status}.`,
    );
  }
  const pending = isRecord(response.json) ? response.json.pending : undefined;
  if (!Array.isArray(pending)) {
    throw new ListPendingApprovalsError('Pending approvals response was malformed.');
  }
  return pending.map(parsePendingApproval);
}

function parsePendingApproval(value: unknown): PendingApproval {
  if (!isRecord(value) || typeof value.invitationId !== 'string' ||
    typeof value.expiresAt !== 'string') {
    throw new ListPendingApprovalsError('Pending approvals response was malformed.');
  }
  if (value.intendedRole !== undefined && value.intendedRole !== 'editor' && value.intendedRole !== 'owner') {
    throw new ListPendingApprovalsError('Pending approvals response was malformed.');
  }
  if (value.intendedMemberDisplayName !== undefined && typeof value.intendedMemberDisplayName !== 'string') {
    throw new ListPendingApprovalsError('Pending approvals response was malformed.');
  }
  return {
    expiresAt: value.expiresAt,
    ...(typeof value.intendedMemberDisplayName === 'string'
      ? { intendedMemberDisplayName: value.intendedMemberDisplayName }
      : {}),
    ...(value.intendedRole === undefined ? {} : { intendedRole: value.intendedRole }),
    invitationId: value.invitationId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
