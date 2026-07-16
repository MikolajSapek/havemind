/**
 * `RemoteApiPort` implemented over Obsidian's `requestUrl`, targeting the
 * F8-02c onboarding HTTP surface (`apps/server/src/auth/onboarding-routes.ts`):
 * discovery, invitation review/redeem, device approval polling and bootstrap.
 *
 * Pre-auth onboarding secrets travel in headers, never in the query string:
 * the pending credential goes in `x-havemind-pending-credential` and the refresh
 * token in `x-havemind-refresh-token`, mirroring the server contract and the
 * anti-spec in `plan/05-plugin-polaczenie-i-sync.md`.
 *
 * `finalUrl` echoes the URL the onboarding controller asked for. Obsidian's
 * `requestUrl` follows redirects transparently and does not surface the resolved
 * URL, so the controller's `redirect: 'error'` intent is enforced by trusting
 * the tailnet-internal HTTPS server not to redirect these endpoints (documented
 * relaxation for the pilot).
 */

import type {
  ApprovalPollRequest,
  BootstrapPageRequest,
  DiscoveryRequest,
  InvitationRedemptionRequest,
  InvitationReviewRequest,
  RemoteApiPort,
  RemoteResponse,
} from '../onboarding/controller';
import type { RequestUrlFn } from './sync-transport';

const PENDING_CREDENTIAL_HEADER = 'x-havemind-pending-credential';
const REFRESH_TOKEN_HEADER = 'x-havemind-refresh-token';

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
      }),
    });
  }

  async pollApproval(request: ApprovalPollRequest): Promise<RemoteResponse> {
    return this.send(request.url, {
      method: 'GET',
      headers: { [PENDING_CREDENTIAL_HEADER]: request.pendingCredential },
    });
  }

  async fetchBootstrapPage(
    request: BootstrapPageRequest,
  ): Promise<RemoteResponse> {
    const url =
      request.cursor === null
        ? request.url
        : `${request.url}?cursor=${encodeURIComponent(request.cursor)}`;
    // finalUrl echoes the controller's expected URL (without the cursor query),
    // which is what `parseSuccessfulResponse` compares against.
    return this.send(request.url, {
      method: 'GET',
      requestUrl: url,
      headers: { [REFRESH_TOKEN_HEADER]: request.refreshToken },
    });
  }

  private async send(
    finalUrl: string,
    init: {
      method: string;
      body?: string;
      headers?: Record<string, string>;
      requestUrl?: string;
    },
  ): Promise<RemoteResponse> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.requestUrl({
      url: init.requestUrl ?? finalUrl,
      method: init.method,
      throw: false,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { body: response.json, finalUrl, status: response.status };
  }
}
