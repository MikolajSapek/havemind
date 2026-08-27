import {
  parseInviteEnvelope,
  type InviteEnvelope,
} from './invite';

const CLIENT_PROTOCOL = Object.freeze({
  major: 1,
  minMinor: 0,
  maxMinor: 0,
});
const DISCOVERY_PATH = '/.well-known/havemind';
const TOKEN_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u;
const MAX_BOOTSTRAP_PAGE_ITEMS = 1_000;

/** The verification value is a 6-digit numeric PIN (see server verification-pin). */
const VERIFICATION_PIN_PATTERN = /^[0-9]{6}$/u;

export interface RemoteResponse {
  body: unknown;
  finalUrl: string;
  status: number;
}

interface RedirectSafeRequest {
  redirect: 'error';
  url: string;
}

export type DiscoveryRequest = RedirectSafeRequest;

export interface InvitationReviewRequest extends RedirectSafeRequest {
  invitationToken: string;
}

export interface InvitationRedemptionRequest extends RedirectSafeRequest {
  deviceLabel: string;
  initialRefreshToken: string;
  invitationToken: string;
  redemptionId: string;
  /**
   * The device's per-device rejoin secret (`hm_rj_…`), sent RAW like
   * `initialRefreshToken`. The server hashes it and stores only the hash on the
   * device, provisioning this device's rejoin capability (F9 Rejoin hardening).
   */
  rejoinSecret: string;
}

export interface ApprovalPollRequest extends RedirectSafeRequest {
  pendingCredential: string;
}

export interface BootstrapPageRequest extends RedirectSafeRequest {
  cursor: string | null;
  refreshToken: string;
  /**
   * The connection's known vault id, sent as `?vault=` so the server serves
   * that membership's bootstrap instead of its first-active-vault fallback
   * (multi-vault 9b, server-side contract added in 3c91a3d). `null` before a
   * connection record exists (the server's first-active-vault fallback
   * covers that case), unreachable once a connection record exists, since
   * `ConnectionMetadata.vaultId` is set at invitation review, well before any
   * bootstrap request is made.
   */
  vaultId: string | null;
}

export interface RemoteApiPort {
  discover(request: DiscoveryRequest): Promise<RemoteResponse>;
  reviewInvitation(request: InvitationReviewRequest): Promise<RemoteResponse>;
  redeemInvitation(
    request: InvitationRedemptionRequest,
  ): Promise<RemoteResponse>;
  pollApproval(request: ApprovalPollRequest): Promise<RemoteResponse>;
  fetchBootstrapPage(request: BootstrapPageRequest): Promise<RemoteResponse>;
}

export interface OnboardingSecretsPort {
  getInvitationEnvelope(): Promise<string | null>;
  saveInvitationEnvelope(value: string): Promise<void>;
  clearInvitationEnvelope(): Promise<void>;
  getPendingCredential(): Promise<string | null>;
  savePendingCredential(value: string): Promise<void>;
  clearPendingCredential(): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  saveRefreshToken(value: string): Promise<void>;
  getRejoinSecret(): Promise<string | null>;
  saveRejoinSecret(value: string): Promise<void>;
}

export interface OnboardingStorePort {
  loadState(): Promise<unknown>;
  saveState(state: DurableOnboardingState): Promise<void>;
  commitBootstrapPage(
    items: readonly unknown[],
    state: DurableOnboardingState,
  ): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

interface ProtocolVersion {
  major: number;
  minor: number;
}

interface ConnectionMetadata {
  apiBaseUrl: string;
  expiresAt: string;
  intendedMemberDisplayName: string;
  inviterDisplayName: string;
  memberId: string;
  protocolVersion: ProtocolVersion;
  serverName: string;
  serverOrigin: string;
  vaultId: string;
  vaultName: string;
}

export interface RedeemingState extends ConnectionMetadata {
  deviceLabel: string;
  phase: 'redeeming';
  redemptionId: string;
  version: 1;
}

export interface PendingApprovalState extends ConnectionMetadata {
  pendingDeviceId: string;
  phase: 'pending-approval';
  verificationPhrase: string;
  version: 1;
}

export interface ApprovalReceivedState extends ConnectionMetadata {
  bootstrapCursor: string | null;
  deviceId: string;
  downloadedItems: number;
  pendingDeviceId: string;
  phase: 'approval-received';
  version: 1;
}

export interface BootstrappingState extends ConnectionMetadata {
  bootstrapCursor: string | null;
  deviceId: string;
  downloadedItems: number;
  phase: 'bootstrapping';
  version: 1;
}

export interface ConnectedState extends ConnectionMetadata {
  deviceId: string;
  downloadedItems: number;
  phase: 'connected';
  version: 1;
}

export type DurableOnboardingState =
  | RedeemingState
  | PendingApprovalState
  | ApprovalReceivedState
  | BootstrappingState
  | ConnectedState;

export type OnboardingViewState =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'origin-review'; serverOrigin: string }>
  // Terminal, non-durable: the owner rejected this device or the 3-attempt cap
  // was reached. The waiting device leaves the poll loop for a clear "invitation
  // no longer valid" screen instead of falling to offline or waiting forever.
  | Readonly<{ phase: 'rejected' }>
  | (ConnectionMetadata & { phase: 'invitation-review' })
  | DurableOnboardingState;

export type OnboardingErrorCode =
  | 'credential-storage-failed'
  | 'incompatible-protocol'
  | 'invalid-device-label'
  | 'invalid-generated-credential'
  | 'invalid-response'
  | 'invalid-state'
  | 'invitation-expired'
  | 'missing-credential'
  | 'origin-mismatch'
  | 'redirect-refused'
  | 'remote-failed'
  | 'review-required'
  | 'storage-failed';

const ERROR_MESSAGES: Readonly<Record<OnboardingErrorCode, string>> = {
  'credential-storage-failed': 'Secure credential storage failed.',
  'incompatible-protocol': 'The server protocol is not compatible.',
  'invalid-device-label': 'The device name is invalid.',
  'invalid-generated-credential': 'Secure credential generation failed.',
  'invalid-response': 'The server returned an invalid response.',
  'invalid-state': 'The saved onboarding state is invalid.',
  'invitation-expired': 'The invitation has expired.',
  'missing-credential': 'A required secure credential is missing.',
  'origin-mismatch': 'The server tried to use another HTTPS origin.',
  'redirect-refused': 'The server request attempted to redirect.',
  'remote-failed': 'The server request failed.',
  'review-required': 'Review the invitation before continuing.',
  'storage-failed': 'Durable onboarding storage failed.',
};

export class OnboardingError extends Error {
  override readonly name = 'OnboardingError';

  constructor(readonly code: OnboardingErrorCode) {
    super(ERROR_MESSAGES[code]);
  }

  toJSON(): Readonly<{
    code: OnboardingErrorCode;
    message: string;
    name: string;
  }> {
    return { code: this.code, message: this.message, name: this.name };
  }
}

export interface OnboardingControllerOptions {
  clock: ClockPort;
  createInitialRefreshToken?: () => string;
  createRejoinSecret?: () => string;
  createRedemptionId?: () => string;
  remoteApi: RemoteApiPort;
  secrets: OnboardingSecretsPort;
  store: OnboardingStorePort;
}

type ActiveInvitation = {
  canonicalEnvelope: string;
  parsed: InviteEnvelope;
};

export class OnboardingController {
  private readonly clock: ClockPort;
  private readonly createInitialRefreshToken: () => string;
  private readonly createRejoinSecret: () => string;
  private readonly createRedemptionId: () => string;
  private readonly remoteApi: RemoteApiPort;
  private readonly secrets: OnboardingSecretsPort;
  private readonly store: OnboardingStorePort;

  private activeInvitation: ActiveInvitation | null = null;
  private currentState: OnboardingViewState = { phase: 'idle' };

  constructor(options: OnboardingControllerOptions) {
    this.clock = options.clock;
    this.createInitialRefreshToken =
      options.createInitialRefreshToken ?? generateRefreshToken;
    this.createRejoinSecret =
      options.createRejoinSecret ?? generateRejoinSecret;
    this.createRedemptionId =
      options.createRedemptionId ?? generateCanonicalUuid;
    this.remoteApi = options.remoteApi;
    this.secrets = options.secrets;
    this.store = options.store;
  }

  get state(): OnboardingViewState {
    return structuredClone(this.currentState);
  }

  beginFromPastedEnvelope(canonicalEnvelope: string): OnboardingViewState {
    const parsed = parseInviteEnvelope(canonicalEnvelope);
    this.activeInvitation = { canonicalEnvelope, parsed };
    this.currentState = {
      phase: 'origin-review',
      serverOrigin: parsed.serverOrigin,
    };
    return this.state;
  }

  async loadInvitationReview(): Promise<OnboardingViewState> {
    if (
      this.currentState.phase !== 'origin-review' ||
      !this.activeInvitation ||
      this.activeInvitation.parsed.serverOrigin !==
        this.currentState.serverOrigin
    ) {
      throw new OnboardingError('review-required');
    }

    const invitation = this.activeInvitation.parsed;
    const discoveryUrl = `${invitation.serverOrigin}${DISCOVERY_PATH}`;
    const discoveryResponse = await this.callRemote(() =>
      this.remoteApi.discover({ redirect: 'error', url: discoveryUrl }),
    );
    const discovery = parseDiscoveryResponse(
      discoveryResponse,
      discoveryUrl,
      invitation.serverOrigin,
    );

    const reviewUrl = `${discovery.apiBaseUrl}/invitations/review`;
    const reviewResponse = await this.callRemote(() =>
      this.remoteApi.reviewInvitation({
        invitationToken: invitation.invitationToken,
        redirect: 'error',
        url: reviewUrl,
      }),
    );
    const review = parseInvitationReviewResponse(reviewResponse, reviewUrl);
    if (Date.parse(review.expiresAt) <= this.clock.now()) {
      throw new OnboardingError('invitation-expired');
    }

    this.currentState = {
      ...review,
      apiBaseUrl: discovery.apiBaseUrl,
      phase: 'invitation-review',
      protocolVersion: discovery.protocolVersion,
      serverName: discovery.serverName,
      serverOrigin: invitation.serverOrigin,
    };
    return this.state;
  }

  async confirmInvitation(deviceLabel: string): Promise<OnboardingViewState> {
    if (
      this.currentState.phase !== 'invitation-review' ||
      !this.activeInvitation
    ) {
      throw new OnboardingError('review-required');
    }
    assertDeviceLabel(deviceLabel);
    if (Date.parse(this.currentState.expiresAt) <= this.clock.now()) {
      throw new OnboardingError('invitation-expired');
    }

    const redemptionId = this.createRedemptionId();
    const initialRefreshToken = this.createInitialRefreshToken();
    const rejoinSecret = this.createRejoinSecret();
    if (!UUID_PATTERN.test(redemptionId)) {
      throw new OnboardingError('invalid-generated-credential');
    }
    assertGeneratedToken(initialRefreshToken, 'hm_rt_');
    assertGeneratedToken(rejoinSecret, 'hm_rj_');

    await this.writeSecret(() =>
      this.secrets.saveRefreshToken(initialRefreshToken),
    );
    // Persist the rejoin secret so a later terminal-auth failure can present it
    // at /auth/rejoin (F9 Rejoin hardening). Only its hash reaches the server.
    await this.writeSecret(() =>
      this.secrets.saveRejoinSecret(rejoinSecret),
    );
    await this.writeSecret(() =>
      this.secrets.saveInvitationEnvelope(
        this.activeInvitation?.canonicalEnvelope ?? '',
      ),
    );

    const redeeming: RedeemingState = {
      ...connectionMetadata(this.currentState),
      deviceLabel,
      phase: 'redeeming',
      redemptionId,
      version: 1,
    };
    await this.saveState(redeeming);
    this.currentState = redeeming;
    return this.redeem(redeeming, this.activeInvitation.parsed);
  }

  async resume(): Promise<OnboardingViewState> {
    const stored = await this.loadState();
    if (stored === null) {
      const envelope = await this.readSecret(() =>
        this.secrets.getInvitationEnvelope(),
      );
      if (envelope !== null) return this.beginFromPastedEnvelope(envelope);
      this.currentState = { phase: 'idle' };
      return this.state;
    }

    const durable = parseDurableState(stored);
    this.currentState = durable;
    switch (durable.phase) {
      case 'redeeming':
        return this.resumeRedemption(durable);
      case 'pending-approval':
        return this.pollApproval(durable);
      case 'approval-received':
        return this.beginBootstrap(durable);
      case 'bootstrapping':
        return this.fetchBootstrapPage(durable);
      case 'connected':
        await this.requireRefreshToken();
        return this.state;
    }
  }

  private async resumeRedemption(
    state: RedeemingState,
  ): Promise<OnboardingViewState> {
    const canonicalEnvelope = await this.readSecret(() =>
      this.secrets.getInvitationEnvelope(),
    );
    if (canonicalEnvelope === null) {
      throw new OnboardingError('missing-credential');
    }
    const invitation = parseInviteEnvelopeSafely(canonicalEnvelope);
    if (invitation.serverOrigin !== state.serverOrigin) {
      throw new OnboardingError('invalid-state');
    }
    this.activeInvitation = { canonicalEnvelope, parsed: invitation };
    return this.redeem(state, invitation);
  }

  private async redeem(
    state: RedeemingState,
    invitation: InviteEnvelope,
  ): Promise<OnboardingViewState> {
    const initialRefreshToken = await this.requireRefreshToken();
    const rejoinSecret = await this.requireRejoinSecret();
    const url = `${state.apiBaseUrl}/invitations/redeem`;
    const response = await this.callRemote(() =>
      this.remoteApi.redeemInvitation({
        deviceLabel: state.deviceLabel,
        initialRefreshToken,
        invitationToken: invitation.invitationToken,
        redemptionId: state.redemptionId,
        rejoinSecret,
        redirect: 'error',
        url,
      }),
    );
    const pending = parsePendingRedemptionResponse(response, url);
    await this.writeSecret(() =>
      this.secrets.savePendingCredential(pending.pendingCredential),
    );

    const pendingState: PendingApprovalState = {
      ...connectionMetadata(state),
      pendingDeviceId: pending.pendingDeviceId,
      phase: 'pending-approval',
      verificationPhrase: pending.verificationPhrase,
      version: 1,
    };
    await this.saveState(pendingState);
    this.currentState = pendingState;
    await this.clearSecretBestEffort(() =>
      this.secrets.clearInvitationEnvelope(),
    );
    this.activeInvitation = null;
    return this.state;
  }

  private async pollApproval(
    state: PendingApprovalState,
  ): Promise<OnboardingViewState> {
    await this.requireRefreshToken();
    const pendingCredential = await this.readSecret(() =>
      this.secrets.getPendingCredential(),
    );
    if (pendingCredential === null) {
      throw new OnboardingError('missing-credential');
    }
    assertStoredToken(pendingCredential, 'hm_pd_');

    const url = `${state.apiBaseUrl}/devices/${state.pendingDeviceId}/approval`;
    const response = await this.callRemote(() =>
      this.remoteApi.pollApproval({
        pendingCredential,
        redirect: 'error',
        url,
      }),
    );
    const approval = parseApprovalResponse(response, url);
    if (approval.status === 'pending') return this.state;
    if (approval.status === 'rejected') {
      // The owner rejected this device or the 3-attempt cap was reached. Drop
      // the spent pending credential and leave the poll loop with a terminal,
      // non-durable 'rejected' view state so the guest sees a clear "invitation
      // no longer valid" screen, never offline, never a silent forever-wait.
      await this.clearSecretBestEffort(() =>
        this.secrets.clearPendingCredential(),
      );
      this.currentState = { phase: 'rejected' };
      return this.state;
    }

    const approved: ApprovalReceivedState = {
      ...connectionMetadata(state),
      // Replace the review's memberId (the invitee's user id) with the active
      // membership id the server minted at approval. This is the id POST
      // /revisions authorises `expectedMemberId` against, so once it lands in the
      // connection's push identity the invitee's revisions are accepted instead
      // of 403'd. Every later phase copies it forward via connectionMetadata.
      memberId: approval.membershipId,
      bootstrapCursor: approval.bootstrapCursor,
      deviceId: approval.deviceId,
      downloadedItems: 0,
      pendingDeviceId: state.pendingDeviceId,
      phase: 'approval-received',
      version: 1,
    };
    await this.saveState(approved);
    this.currentState = approved;
    return this.state;
  }

  private async beginBootstrap(
    state: ApprovalReceivedState,
  ): Promise<OnboardingViewState> {
    await this.requireRefreshToken();
    const bootstrapping: BootstrappingState = {
      ...connectionMetadata(state),
      bootstrapCursor: state.bootstrapCursor,
      deviceId: state.deviceId,
      downloadedItems: state.downloadedItems,
      phase: 'bootstrapping',
      version: 1,
    };
    await this.saveState(bootstrapping);
    this.currentState = bootstrapping;
    await this.clearSecretBestEffort(() =>
      this.secrets.clearPendingCredential(),
    );
    return this.state;
  }

  private async fetchBootstrapPage(
    state: BootstrappingState,
  ): Promise<OnboardingViewState> {
    const refreshToken = await this.requireRefreshToken();
    const url = `${state.apiBaseUrl}/bootstrap`;
    const response = await this.callRemote(() =>
      this.remoteApi.fetchBootstrapPage({
        cursor: state.bootstrapCursor,
        redirect: 'error',
        refreshToken,
        url,
        vaultId: state.vaultId,
      }),
    );
    const page = parseBootstrapResponse(response, url);
    if (!page.complete && page.nextCursor === state.bootstrapCursor) {
      throw new OnboardingError('invalid-response');
    }

    const downloadedItems = state.downloadedItems + page.items.length;
    const nextState: DurableOnboardingState = page.complete
      ? {
          ...connectionMetadata(state),
          deviceId: state.deviceId,
          downloadedItems,
          phase: 'connected',
          version: 1,
        }
      : {
          ...connectionMetadata(state),
          bootstrapCursor: page.nextCursor,
          deviceId: state.deviceId,
          downloadedItems,
          phase: 'bootstrapping',
          version: 1,
        };

    try {
      await this.store.commitBootstrapPage(page.items, nextState);
    } catch {
      throw new OnboardingError('storage-failed');
    }
    this.currentState = nextState;
    return this.state;
  }

  private async requireRefreshToken(): Promise<string> {
    const refreshToken = await this.readSecret(() =>
      this.secrets.getRefreshToken(),
    );
    if (refreshToken === null) {
      throw new OnboardingError('missing-credential');
    }
    assertStoredToken(refreshToken, 'hm_rt_');
    return refreshToken;
  }

  /**
   * The device's rejoin secret, persisted at confirmInvitation. If a redemption
   * that began before this feature is resumed without a stored secret, mint and
   * persist a fresh one, the server stores whatever hash it receives, so this
   * still provisions a valid rejoin capability for the device.
   */
  private async requireRejoinSecret(): Promise<string> {
    const existing = await this.readSecret(() =>
      this.secrets.getRejoinSecret(),
    );
    if (existing !== null) {
      assertStoredToken(existing, 'hm_rj_');
      return existing;
    }
    const minted = this.createRejoinSecret();
    assertGeneratedToken(minted, 'hm_rj_');
    await this.writeSecret(() => this.secrets.saveRejoinSecret(minted));
    return minted;
  }

  private async callRemote(
    request: () => Promise<RemoteResponse>,
  ): Promise<RemoteResponse> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof OnboardingError) throw error;
      throw new OnboardingError('remote-failed');
    }
  }

  private async loadState(): Promise<unknown> {
    try {
      return await this.store.loadState();
    } catch {
      throw new OnboardingError('storage-failed');
    }
  }

  private async saveState(state: DurableOnboardingState): Promise<void> {
    try {
      await this.store.saveState(state);
    } catch {
      throw new OnboardingError('storage-failed');
    }
  }

  private async readSecret<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      throw new OnboardingError('credential-storage-failed');
    }
  }

  private async writeSecret(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch {
      throw new OnboardingError('credential-storage-failed');
    }
  }

  private async clearSecretBestEffort(
    clear: () => Promise<void>,
  ): Promise<void> {
    try {
      await clear();
    } catch {
      // Consumed credentials remain server-revocable and never enter logs.
    }
  }
}

type Discovery = {
  apiBaseUrl: string;
  protocolVersion: ProtocolVersion;
  serverName: string;
};

function parseDiscoveryResponse(
  response: RemoteResponse,
  expectedUrl: string,
  expectedOrigin: string,
): Discovery {
  const body = parseSuccessfulResponse(response, expectedUrl);
  if (
    !hasExactKeys(body, [
      'apiBaseUrl',
      'authMethods',
      'capabilities',
      'name',
      'protocol',
      'service',
    ]) ||
    body.service !== 'havemind' ||
    !isCanonicalDisplayText(body.name, 80) ||
    !Array.isArray(body.authMethods) ||
    body.authMethods.length !== 1 ||
    body.authMethods[0] !== 'opaque-token' ||
    !Array.isArray(body.capabilities) ||
    body.capabilities.length > 64 ||
    body.capabilities.some(
      (capability) =>
        typeof capability !== 'string' ||
        !CAPABILITY_PATTERN.test(capability),
    ) ||
    !isRecord(body.protocol) ||
    !hasExactKeys(body.protocol, ['major', 'maxMinor', 'minMinor']) ||
    !isNonnegativeInteger(body.protocol.major) ||
    !isNonnegativeInteger(body.protocol.minMinor) ||
    !isNonnegativeInteger(body.protocol.maxMinor) ||
    body.protocol.minMinor > body.protocol.maxMinor ||
    typeof body.apiBaseUrl !== 'string'
  ) {
    throw new OnboardingError('invalid-response');
  }

  const apiBaseUrl = parseCanonicalApiBaseUrl(
    body.apiBaseUrl,
    expectedOrigin,
  );
  const protocolVersion = negotiateProtocol({
    major: body.protocol.major,
    maxMinor: body.protocol.maxMinor,
    minMinor: body.protocol.minMinor,
  });
  return {
    apiBaseUrl,
    protocolVersion,
    serverName: body.name,
  };
}

function parseInvitationReviewResponse(
  response: RemoteResponse,
  expectedUrl: string,
): Pick<
  ConnectionMetadata,
  | 'expiresAt'
  | 'intendedMemberDisplayName'
  | 'inviterDisplayName'
  | 'memberId'
  | 'vaultId'
  | 'vaultName'
> {
  const body = parseSuccessfulResponse(response, expectedUrl);
  if (
    !hasExactKeys(body, [
      'expiresAt',
      'intendedMemberDisplayName',
      'inviterDisplayName',
      'memberId',
      'vaultId',
      'vaultName',
      'version',
    ]) ||
    body.version !== 1 ||
    !isCanonicalUuid(body.vaultId) ||
    !isCanonicalUuid(body.memberId) ||
    !isCanonicalDisplayText(body.vaultName, 120) ||
    !isCanonicalDisplayText(body.inviterDisplayName, 80) ||
    !isCanonicalDisplayText(body.intendedMemberDisplayName, 80) ||
    !isCanonicalIsoTimestamp(body.expiresAt)
  ) {
    throw new OnboardingError('invalid-response');
  }
  return {
    expiresAt: body.expiresAt,
    intendedMemberDisplayName: body.intendedMemberDisplayName,
    inviterDisplayName: body.inviterDisplayName,
    memberId: body.memberId,
    vaultId: body.vaultId,
    vaultName: body.vaultName,
  };
}

function parsePendingRedemptionResponse(
  response: RemoteResponse,
  expectedUrl: string,
): Readonly<{
  pendingCredential: string;
  pendingDeviceId: string;
  verificationPhrase: string;
}> {
  const body = parseSuccessfulResponse(response, expectedUrl);
  if (
    !hasExactKeys(body, [
      'pendingCredential',
      'pendingDeviceId',
      'status',
      'verificationPhrase',
    ]) ||
    body.status !== 'pending' ||
    !isCanonicalUuid(body.pendingDeviceId) ||
    !isCanonicalToken(body.pendingCredential, 'hm_pd_') ||
    !isVerificationPin(body.verificationPhrase)
  ) {
    throw new OnboardingError('invalid-response');
  }
  return {
    pendingCredential: body.pendingCredential,
    pendingDeviceId: body.pendingDeviceId,
    verificationPhrase: body.verificationPhrase,
  };
}

type ApprovalResponse =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'rejected' }>
  | Readonly<{
      bootstrapCursor: string | null;
      deviceId: string;
      // The invitee's active membership id (the server's memberships.id), which
      // POST /revisions authorises push against. It becomes the connection's
      // push member id, see pollApproval.
      membershipId: string;
      status: 'approved';
    }>;

function parseApprovalResponse(
  response: RemoteResponse,
  expectedUrl: string,
): ApprovalResponse {
  const body = parseSuccessfulResponse(response, expectedUrl);
  if (hasExactKeys(body, ['status']) && body.status === 'pending') {
    return { status: 'pending' };
  }
  if (hasExactKeys(body, ['status']) && body.status === 'rejected') {
    return { status: 'rejected' };
  }
  if (
    !hasExactKeys(body, ['bootstrapCursor', 'deviceId', 'membershipId', 'status']) ||
    body.status !== 'approved' ||
    !isCanonicalUuid(body.deviceId) ||
    !isCanonicalUuid(body.membershipId) ||
    !isCursor(body.bootstrapCursor)
  ) {
    throw new OnboardingError('invalid-response');
  }
  return {
    bootstrapCursor: body.bootstrapCursor,
    deviceId: body.deviceId,
    membershipId: body.membershipId,
    status: 'approved',
  };
}

type BootstrapResponse = Readonly<{
  complete: boolean;
  items: readonly unknown[];
  nextCursor: string | null;
}>;

function parseBootstrapResponse(
  response: RemoteResponse,
  expectedUrl: string,
): BootstrapResponse {
  const body = parseSuccessfulResponse(response, expectedUrl);
  if (
    !hasExactKeys(body, [
      'complete',
      'items',
      'nextCursor',
      'version',
    ]) ||
    body.version !== 1 ||
    typeof body.complete !== 'boolean' ||
    !Array.isArray(body.items) ||
    body.items.length > MAX_BOOTSTRAP_PAGE_ITEMS ||
    !isCursor(body.nextCursor) ||
    (body.complete && body.nextCursor !== null) ||
    (!body.complete && body.nextCursor === null)
  ) {
    throw new OnboardingError('invalid-response');
  }
  return {
    complete: body.complete,
    items: body.items,
    nextCursor: body.nextCursor,
  };
}

function parseSuccessfulResponse(
  response: RemoteResponse,
  expectedUrl: string,
): Record<string, unknown> {
  if (!isRecord(response) || response.finalUrl !== expectedUrl) {
    throw new OnboardingError('redirect-refused');
  }
  if (response.status !== 200) throw new OnboardingError('remote-failed');
  if (!isRecord(response.body)) {
    throw new OnboardingError('invalid-response');
  }
  return response.body;
}

function parseCanonicalApiBaseUrl(
  value: string,
  expectedOrigin: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OnboardingError('invalid-response');
  }

  const canonicalValue = url.pathname === '/' ? url.origin : url.href;
  if (
    url.protocol !== 'https:' ||
    url.origin !== expectedOrigin ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== canonicalValue ||
    (url.pathname !== '/' && url.pathname.endsWith('/'))
  ) {
    throw new OnboardingError('origin-mismatch');
  }
  return value;
}

function negotiateProtocol(server: {
  major: number;
  maxMinor: number;
  minMinor: number;
}): ProtocolVersion {
  if (server.major !== CLIENT_PROTOCOL.major) {
    throw new OnboardingError('incompatible-protocol');
  }
  const minimum = Math.max(server.minMinor, CLIENT_PROTOCOL.minMinor);
  const maximum = Math.min(server.maxMinor, CLIENT_PROTOCOL.maxMinor);
  if (minimum > maximum) {
    throw new OnboardingError('incompatible-protocol');
  }
  return { major: CLIENT_PROTOCOL.major, minor: maximum };
}

function parseDurableState(value: unknown): DurableOnboardingState {
  if (!isRecord(value) || typeof value.phase !== 'string') {
    throw new OnboardingError('invalid-state');
  }
  const phase = value.phase;
  const phaseKeys: Record<DurableOnboardingState['phase'], readonly string[]> = {
    'approval-received': [
      'bootstrapCursor',
      'deviceId',
      'downloadedItems',
      'pendingDeviceId',
    ],
    bootstrapping: [
      'bootstrapCursor',
      'deviceId',
      'downloadedItems',
    ],
    connected: ['deviceId', 'downloadedItems'],
    'pending-approval': [
      'pendingDeviceId',
      'verificationPhrase',
    ],
    redeeming: ['deviceLabel', 'redemptionId'],
  };
  if (!Object.hasOwn(phaseKeys, phase)) {
    throw new OnboardingError('invalid-state');
  }
  const expectedKeys = [
    'apiBaseUrl',
    'expiresAt',
    'intendedMemberDisplayName',
    'inviterDisplayName',
    'memberId',
    'phase',
    'protocolVersion',
    'serverName',
    'serverOrigin',
    'vaultId',
    'vaultName',
    'version',
    ...phaseKeys[phase as DurableOnboardingState['phase']],
  ];
  if (!hasExactKeys(value, expectedKeys) || value.version !== 1) {
    throw new OnboardingError('invalid-state');
  }
  validateStoredConnectionMetadata(value);

  switch (phase) {
    case 'redeeming':
      if (
        !isCanonicalDisplayText(value.deviceLabel, 80) ||
        !isCanonicalUuid(value.redemptionId)
      ) {
        throw new OnboardingError('invalid-state');
      }
      break;
    case 'pending-approval':
      if (
        !isCanonicalUuid(value.pendingDeviceId) ||
        !isVerificationPin(value.verificationPhrase)
      ) {
        throw new OnboardingError('invalid-state');
      }
      break;
    case 'approval-received':
      if (
        !isCanonicalUuid(value.pendingDeviceId) ||
        !isCanonicalUuid(value.deviceId) ||
        !isCursor(value.bootstrapCursor) ||
        !isNonnegativeInteger(value.downloadedItems)
      ) {
        throw new OnboardingError('invalid-state');
      }
      break;
    case 'bootstrapping':
      if (
        !isCanonicalUuid(value.deviceId) ||
        !isCursor(value.bootstrapCursor) ||
        !isNonnegativeInteger(value.downloadedItems)
      ) {
        throw new OnboardingError('invalid-state');
      }
      break;
    case 'connected':
      if (
        !isCanonicalUuid(value.deviceId) ||
        !isNonnegativeInteger(value.downloadedItems)
      ) {
        throw new OnboardingError('invalid-state');
      }
      break;
    default:
      throw new OnboardingError('invalid-state');
  }
  return structuredClone(value) as unknown as DurableOnboardingState;
}

function validateStoredConnectionMetadata(
  value: Record<string, unknown>,
): void {
  if (
    typeof value.serverOrigin !== 'string' ||
    !isCanonicalHttpsOrigin(value.serverOrigin) ||
    typeof value.apiBaseUrl !== 'string' ||
    !isApiBaseForOrigin(value.apiBaseUrl, value.serverOrigin) ||
    !isCanonicalDisplayText(value.serverName, 80) ||
    !isCanonicalDisplayText(value.vaultName, 120) ||
    !isCanonicalDisplayText(value.inviterDisplayName, 80) ||
    !isCanonicalDisplayText(value.intendedMemberDisplayName, 80) ||
    !isCanonicalUuid(value.vaultId) ||
    !isCanonicalUuid(value.memberId) ||
    !isCanonicalIsoTimestamp(value.expiresAt) ||
    !isRecord(value.protocolVersion) ||
    !hasExactKeys(value.protocolVersion, ['major', 'minor']) ||
    value.protocolVersion.major !== 1 ||
    value.protocolVersion.minor !== 0
  ) {
    throw new OnboardingError('invalid-state');
  }
}

function connectionMetadata(state: ConnectionMetadata): ConnectionMetadata {
  return {
    apiBaseUrl: state.apiBaseUrl,
    expiresAt: state.expiresAt,
    intendedMemberDisplayName: state.intendedMemberDisplayName,
    inviterDisplayName: state.inviterDisplayName,
    memberId: state.memberId,
    protocolVersion: structuredClone(state.protocolVersion),
    serverName: state.serverName,
    serverOrigin: state.serverOrigin,
    vaultId: state.vaultId,
    vaultName: state.vaultName,
  };
}

function assertDeviceLabel(value: string): void {
  if (!isCanonicalDisplayText(value, 80)) {
    throw new OnboardingError('invalid-device-label');
  }
}

function assertGeneratedToken(value: string, prefix: string): void {
  if (!isCanonicalToken(value, prefix)) {
    throw new OnboardingError('invalid-generated-credential');
  }
}

function assertStoredToken(value: string, prefix: string): void {
  if (!isCanonicalToken(value, prefix)) {
    throw new OnboardingError('missing-credential');
  }
}

function isCanonicalToken(value: unknown, prefix: string): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    value.length !== prefix.length + 43
  ) {
    return false;
  }
  const payload = value.slice(prefix.length);
  if (!TOKEN_PAYLOAD_PATTERN.test(payload)) return false;
  try {
    const bytes = decodeBase64Url(payload);
    return bytes.byteLength === 32 && encodeBase64Url(bytes) === payload;
  } catch {
    return false;
  }
}

function isVerificationPin(value: unknown): value is string {
  return typeof value === 'string' && VERIFICATION_PIN_PATTERN.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCursor(value: unknown): value is string | null {
  return value === null ||
    (typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value));
}

function isCanonicalDisplayText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isApiBaseForOrigin(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    const canonicalValue = url.pathname === '/' ? url.origin : url.href;
    return (
      url.protocol === 'https:' &&
      url.origin === origin &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      value === canonicalValue &&
      (url.pathname === '/' || !url.pathname.endsWith('/'))
    );
  } catch {
    return false;
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInviteEnvelopeSafely(value: string): InviteEnvelope {
  try {
    return parseInviteEnvelope(value);
  } catch {
    throw new OnboardingError('missing-credential');
  }
}

function generateCanonicalUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new OnboardingError('invalid-generated-credential');
  }
  return globalThis.crypto.randomUUID();
}

function generateRefreshToken(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new OnboardingError('invalid-generated-credential');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `hm_rt_${encodeBase64Url(bytes)}`;
}

function generateRejoinSecret(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new OnboardingError('invalid-generated-credential');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `hm_rj_${encodeBase64Url(bytes)}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
