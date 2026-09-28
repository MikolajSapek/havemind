/**
 * `RemoteApiPort` implemented over Obsidian's `requestUrl`, targeting the
 * F8-02c onboarding HTTP surface (`apps/server/src/auth/onboarding-routes.ts`):
 * discovery, invitation review/redeem and device approval polling.
 *
 * Pre-auth onboarding secrets travel in headers, never in the query string:
 * the pending credential goes in `x-havemind-pending-credential`, mirroring
 * the server contract and the anti-spec in `plan/05-plugin-connection-and-sync.md`.
 *
 * `finalUrl` echoes the URL the onboarding controller asked for. Obsidian's
 * `requestUrl` follows redirects transparently and does not surface the resolved
 * URL, so the controller's `redirect: 'error'` intent is enforced by trusting
 * the tailnet-internal HTTPS server not to redirect these endpoints (documented
 * relaxation for the pilot).
 */

import type {
  ApprovalPollRequest,
  DiscoveryRequest,
  InvitationRedemptionRequest,
  InvitationReviewRequest,
  RemoteApiPort,
  RemoteResponse,
} from '../onboarding/controller';
import type { RequestUrlFn } from './sync-transport';

const PENDING_CREDENTIAL_HEADER = 'x-havemind-pending-credential';

export interface RequestUrlOnboardingApiOptions {
  readonly requestUrl: RequestUrlFn;
}

export class RequestUrlOnboardingApi implements RemoteApiPort {
  private readonly requestUrl: RequestUrlFn;

  constructor(options: RequestUrlOnboardingApiOptions) {
    this.requestUrl = options.requestUrl;
  }

  async discover(request: DiscoveryRequest): Promise<RemoteResponse> {
    return this.send(request.url, { method: 'GET' });
  }

  async reviewInvitation(
    request: InvitationReviewRequest,
  ): Promise<RemoteResponse> {
    return this.send(request.url, {
      method: 'POST',
      body: JSON.stringify({ invitationToken: request.invitationToken }),
    });
  }

  async redeemInvitation(
    request: InvitationRedemptionRequest,
  ): Promise<RemoteResponse> {
    return this.send(request.url, {
      method: 'POST',
      body: JSON.stringify({
        deviceLabel: request.deviceLabel,
        initialRefreshToken: request.initialRefreshToken,
        invitationToken: request.invitationToken,
        redemptionId: request.redemptionId,
        rejoinSecret: request.rejoinSecret,
      }),
    });
  }

  async pollApproval(request: ApprovalPollRequest): Promise<RemoteResponse> {
    return this.send(request.url, {
      method: 'GET',
      headers: { [PENDING_CREDENTIAL_HEADER]: request.pendingCredential },
    });
  }

  private async send(
    finalUrl: string,
    init: {
      method: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<RemoteResponse> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.requestUrl({
      url: finalUrl,
      method: init.method,
      throw: false,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { body: response.json, finalUrl, status: response.status };
  }
}
