import { describe, expect, it, vi } from 'vitest';

import {
  OnboardingController,
  OnboardingError,
  type ClockPort,
  type DurableOnboardingState,
  type OnboardingSecretsPort,
  type OnboardingStorePort,
  type RemoteApiPort,
  type RemoteResponse,
} from './controller';
import { buildInviteEnvelope } from './invite';

const INVITATION_TOKEN =
  'hm_it_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PENDING_CREDENTIAL =
  'hm_pd_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const REFRESH_TOKEN =
  'hm_rt_AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const VAULT_ID = '00000000-0000-4000-8000-000000000001';
const MEMBER_ID = '00000000-0000-4000-8000-000000000002';
const PENDING_DEVICE_ID = '00000000-0000-4000-8000-000000000003';
const DEVICE_ID = '00000000-0000-4000-8000-000000000004';
const REDEMPTION_ID = '00000000-0000-4000-8000-000000000005';
// The invitee's active membership id (memberships.id), minted at owner approval
// and distinct from MEMBER_ID (the review's memberId, which is the invitee's
// user id). This is the id POST /revisions authorises `expectedMemberId` against,
// so it, not MEMBER_ID, must become the connection's push member id.
const MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000006';
const VERIFICATION_PHRASE = '123456';
const SERVER_ORIGIN = 'https://sync.example.test';
const API_BASE_URL = `${SERVER_ORIGIN}/api/v1`;
const ENVELOPE = buildInviteEnvelope({
  invitationToken: INVITATION_TOKEN,
  serverOrigin: SERVER_ORIGIN,
});
const NOW = Date.parse('2026-07-15T04:00:00.000Z');

type RemoteMethod =
  | 'discover'
  | 'poll'
  | 'redeem'
  | 'review';

type RemoteCall = {
  method: RemoteMethod;
  request: Record<string, unknown>;
};

class FakeRemoteApi implements RemoteApiPort {
  readonly calls: RemoteCall[] = [];
  private readonly queued = new Map<
    RemoteMethod,
    Array<RemoteResponse | Error>
  >();

  enqueue(method: RemoteMethod, response: RemoteResponse | Error): void {
    const queue = this.queued.get(method) ?? [];
    queue.push(response);
    this.queued.set(method, queue);
  }

  async discover(
    request: Parameters<RemoteApiPort['discover']>[0],
  ): Promise<RemoteResponse> {
    return this.respond('discover', request);
  }

  async reviewInvitation(
    request: Parameters<RemoteApiPort['reviewInvitation']>[0],
  ): Promise<RemoteResponse> {
    return this.respond('review', request);
  }

  async redeemInvitation(
    request: Parameters<RemoteApiPort['redeemInvitation']>[0],
  ): Promise<RemoteResponse> {
    return this.respond('redeem', request);
  }

  async pollApproval(
    request: Parameters<RemoteApiPort['pollApproval']>[0],
  ): Promise<RemoteResponse> {
    return this.respond('poll', request);
  }

  private async respond(
    method: RemoteMethod,
    request: object,
  ): Promise<RemoteResponse> {
    this.calls.push({
      method,
      request: structuredClone(request) as Record<string, unknown>,
    });
    const response = this.queued.get(method)?.shift();
    if (!response) throw new Error(`No fake response queued for ${method}.`);
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}

class MemoryOnboardingStore implements OnboardingStorePort {
  readonly savedStates: DurableOnboardingState[] = [];
  state: unknown = null;
  failNextSave = false;

  async loadState(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async saveState(state: DurableOnboardingState): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('Injected durable-state failure.');
    }
    this.state = structuredClone(state);
    this.savedStates.push(structuredClone(state));
  }

  async clearState(): Promise<void> {
    this.state = null;
  }
}

class MemoryOnboardingSecrets implements OnboardingSecretsPort {
  invitationEnvelope: string | null = null;
  pendingCredential: string | null = null;
  refreshToken: string | null = null;
  rejoinSecret: string | null = null;

  async getInvitationEnvelope(): Promise<string | null> {
    return this.invitationEnvelope;
  }

  async saveInvitationEnvelope(value: string): Promise<void> {
    this.invitationEnvelope = value;
  }

  async clearInvitationEnvelope(): Promise<void> {
    this.invitationEnvelope = null;
  }

  async getPendingCredential(): Promise<string | null> {
    return this.pendingCredential;
  }

  async savePendingCredential(value: string): Promise<void> {
    this.pendingCredential = value;
  }

  async clearPendingCredential(): Promise<void> {
    this.pendingCredential = null;
  }

  async getRefreshToken(): Promise<string | null> {
    return this.refreshToken;
  }

  async saveRefreshToken(value: string): Promise<void> {
    this.refreshToken = value;
  }

  async getRejoinSecret(): Promise<string | null> {
    return this.rejoinSecret;
  }

  async saveRejoinSecret(value: string): Promise<void> {
    this.rejoinSecret = value;
  }
}

class FixedClock implements ClockPort {
  constructor(private readonly timestamp: number) {}

  now(): number {
    return this.timestamp;
  }
}

describe('onboarding controller', () => {
  it('shows the pasted HTTPS origin for review before making any network request', () => {
    const fixture = createFixture();

    const state = fixture.controller.beginFromPastedEnvelope(ENVELOPE);

    expect(state).toEqual({
      phase: 'origin-review',
      serverOrigin: SERVER_ORIGIN,
    });
    expect(fixture.remoteApi.calls).toEqual([]);
    expect(fixture.store.state).toBeNull();
    expect(JSON.stringify(state)).not.toContain(INVITATION_TOKEN);
  });

  it('discovers one HTTPS origin, negotiates protocol, and shows authoritative review data', async () => {
    const fixture = createFixture();
    queueHappyReview(fixture.remoteApi);
    fixture.controller.beginFromPastedEnvelope(ENVELOPE);

    const state = await fixture.controller.loadInvitationReview();

    expect(state).toMatchObject({
      apiBaseUrl: API_BASE_URL,
      expiresAt: '2026-07-15T04:15:00.000Z',
      inviterDisplayName: 'Mikolaj',
      intendedMemberDisplayName: 'Anna',
      memberId: MEMBER_ID,
      phase: 'invitation-review',
      protocolVersion: { major: 1, minor: 0 },
      serverName: 'Test Havemind',
      serverOrigin: SERVER_ORIGIN,
      vaultId: VAULT_ID,
      vaultName: 'Shared research',
    });
    expect(fixture.remoteApi.calls.map(({ method }) => method)).toEqual([
      'discover',
      'review',
    ]);
    expect(fixture.remoteApi.calls[0]?.request).toEqual({
      redirect: 'error',
      url: `${SERVER_ORIGIN}/.well-known/havemind`,
    });
    expect(fixture.remoteApi.calls[1]?.request).toMatchObject({
      invitationToken: INVITATION_TOKEN,
      redirect: 'error',
      url: `${API_BASE_URL}/invitations/review`,
    });
    for (const { request } of fixture.remoteApi.calls) {
      expect(String(request.url)).toMatch(/^https:\/\/sync\.example\.test\//);
      expect(String(request.url)).not.toContain(INVITATION_TOKEN);
    }
    expect(JSON.stringify(state)).not.toContain(INVITATION_TOKEN);
  });

  it.each([
    {
      code: 'redirect-refused',
      document: discoveryBody(),
      finalUrl: 'https://redirect.example.test/.well-known/havemind',
    },
    {
      code: 'origin-mismatch',
      document: discoveryBody({
        apiBaseUrl: 'https://api.example.test/api/v1',
      }),
      finalUrl: `${SERVER_ORIGIN}/.well-known/havemind`,
    },
    {
      code: 'incompatible-protocol',
      document: discoveryBody({
        protocol: { major: 2, minMinor: 0, maxMinor: 0 },
      }),
      finalUrl: `${SERVER_ORIGIN}/.well-known/havemind`,
    },
  ])('fails closed for unsafe discovery: $code', async (scenario) => {
    const fixture = createFixture();
    fixture.remoteApi.enqueue('discover', {
      body: scenario.document,
      finalUrl: scenario.finalUrl,
      status: 200,
    });
    fixture.controller.beginFromPastedEnvelope(ENVELOPE);

    await expect(
      fixture.controller.loadInvitationReview(),
    ).rejects.toMatchObject({ code: scenario.code });
    expect(fixture.remoteApi.calls).toHaveLength(1);
  });

  it('requires the explicit review and rejects expired invitations before redemption', async () => {
    const fixture = createFixture();

    await expect(
      fixture.controller.confirmInvitation('Anna MacBook'),
    ).rejects.toMatchObject({ code: 'review-required' });
    expect(fixture.remoteApi.calls).toEqual([]);

    fixture.controller.beginFromPastedEnvelope(ENVELOPE);
    queueHappyReview(fixture.remoteApi, {
      expiresAt: '2026-07-15T03:59:59.999Z',
    });
    await expect(
      fixture.controller.loadInvitationReview(),
    ).rejects.toMatchObject({ code: 'invitation-expired' });
    expect(
      fixture.remoteApi.calls.some(({ method }) => method === 'redeem'),
    ).toBe(false);
  });

  it('redeems only after review and stores credentials outside durable connection state', async () => {
    const fixture = createFixture();
    queueHappyReview(fixture.remoteApi);
    fixture.remoteApi.enqueue('redeem', pendingResponse());
    fixture.controller.beginFromPastedEnvelope(ENVELOPE);
    await fixture.controller.loadInvitationReview();
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    const state = await fixture.controller.confirmInvitation('Anna MacBook');

    expect(state).toMatchObject({
      pendingDeviceId: PENDING_DEVICE_ID,
      phase: 'pending-approval',
      verificationPhrase: VERIFICATION_PHRASE,
    });
    expect(fixture.secrets.pendingCredential).toBe(PENDING_CREDENTIAL);
    expect(fixture.secrets.refreshToken).toBe(REFRESH_TOKEN);
    expect(fixture.secrets.invitationEnvelope).toBeNull();
    expect(fixture.createInitialRefreshToken).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.store.state)).not.toContain(INVITATION_TOKEN);
    expect(JSON.stringify(fixture.store.state)).not.toContain(
      PENDING_CREDENTIAL,
    );
    const redeemCall = fixture.remoteApi.calls.find(
      ({ method }) => method === 'redeem',
    );
    expect(redeemCall?.request).toMatchObject({
      deviceLabel: 'Anna MacBook',
      initialRefreshToken: REFRESH_TOKEN,
      invitationToken: INVITATION_TOKEN,
      redemptionId: REDEMPTION_ID,
      url: `${API_BASE_URL}/invitations/redeem`,
    });
    expect(String(redeemCall?.request.url)).not.toContain(INVITATION_TOKEN);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  // B13: a rejection cleared the pending credential but left the durable
  // pending-approval state, so every later start failed with a missing
  // credential and Retry could not get the guest out of it.
  it('forgets a rejected onboarding, so the next start is a fresh one', async () => {
    const fixture = createFixture();
    await createPendingConnection(fixture);

    const rejectingRemote = new FakeRemoteApi();
    rejectingRemote.enqueue('poll', {
      body: { status: 'rejected' },
      finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
      status: 200,
    });
    const rejecting = createController({
      remoteApi: rejectingRemote,
      secrets: fixture.secrets,
      store: fixture.store,
    });
    await expect(rejecting.resume()).resolves.toMatchObject({ phase: 'rejected' });

    const restarted = createController({
      remoteApi: new FakeRemoteApi(),
      secrets: fixture.secrets,
      store: fixture.store,
    });
    await expect(restarted.resume()).resolves.toEqual({ phase: 'idle' });
  });

  // R11: every server response was parsed with an exact key set, so a server
  // adding one field (an additive, backward-compatible API change) would stop
  // every released plugin from joining. Unknown fields are now ignored, and
  // the approval no longer needs the retired bootstrapCursor.
  it('joins through a server whose responses carry fields it does not know', async () => {
    const fixture = createFixture();
    fixture.remoteApi.enqueue('discover', {
      body: discoveryBody({
        future: true,
        protocol: { future: true, major: 1, maxMinor: 0, minMinor: 0 },
      }),
      finalUrl: `${SERVER_ORIGIN}/.well-known/havemind`,
      status: 200,
    });
    fixture.remoteApi.enqueue('review', {
      body: {
        expiresAt: '2026-07-15T04:15:00.000Z',
        future: true,
        intendedMemberDisplayName: 'Anna',
        inviterDisplayName: 'Mikolaj',
        memberId: MEMBER_ID,
        vaultId: VAULT_ID,
        vaultName: 'Shared research',
        version: 1,
      },
      finalUrl: `${API_BASE_URL}/invitations/review`,
      status: 200,
    });
    const pending = pendingResponse();
    fixture.remoteApi.enqueue('redeem', {
      ...pending,
      body: { ...(pending.body as Record<string, unknown>), future: true },
    });
    fixture.controller.beginFromPastedEnvelope(ENVELOPE);
    await fixture.controller.loadInvitationReview();
    await expect(fixture.controller.confirmInvitation('Anna MacBook')).resolves.toMatchObject({
      phase: 'pending-approval',
    });

    fixture.remoteApi.enqueue('poll', {
      body: { future: true, status: 'pending' },
      finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
      status: 200,
    });
    await expect(fixture.controller.resume()).resolves.toMatchObject({
      phase: 'pending-approval',
    });

    fixture.remoteApi.enqueue('poll', {
      ...approvedResponse(),
      body: { deviceId: DEVICE_ID, future: true, membershipId: MEMBERSHIP_ID, status: 'approved' },
    });
    await expect(fixture.controller.resume()).resolves.toMatchObject({ phase: 'connected' });
  });

  it('resumes pending approval and connects on approval across controller restarts', async () => {
    const fixture = createFixture();
    await createPendingConnection(fixture);

    const pendingRemote = new FakeRemoteApi();
    pendingRemote.enqueue('poll', {
      body: { status: 'pending' },
      finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
      status: 200,
    });
    const pendingController = createController({
      remoteApi: pendingRemote,
      secrets: fixture.secrets,
      store: fixture.store,
    });
    await expect(pendingController.resume()).resolves.toMatchObject({
      phase: 'pending-approval',
      verificationPhrase: VERIFICATION_PHRASE,
    });

    const approvedRemote = new FakeRemoteApi();
    approvedRemote.enqueue('poll', approvedResponse());
    const approvedController = createController({
      remoteApi: approvedRemote,
      secrets: fixture.secrets,
      store: fixture.store,
    });
    await expect(approvedController.resume()).resolves.toMatchObject({
      // The approval poll surfaces the invitee's active membership id, which
      // overrides the review's memberId (the invitee's user id) so the push
      // header carries the exact id POST /revisions authorises against.
      memberId: MEMBERSHIP_ID,
      phase: 'connected',
    });
    expect(fixture.secrets.refreshToken).toBe(REFRESH_TOKEN);
    expect(JSON.stringify(fixture.store.state)).not.toContain(REFRESH_TOKEN);

    // The approval connects directly: the server's bootstrapCursor is
    // accepted and ignored, and no bootstrap page is fetched (D10, R11).
    expect(approvedRemote.calls.map((call) => call.method)).toEqual(['poll']);
    expect(fixture.store.state).toMatchObject({
      deviceId: DEVICE_ID,
      downloadedItems: 0,
      memberId: MEMBERSHIP_ID,
      phase: 'connected',
    });
    expect(fixture.secrets.pendingCredential).toBeNull();
  });

  it.each(['approval-received', 'bootstrapping'] as const)(
    'migrates a device persisted in the retired %s phase forward to connected',
    async (legacyPhase) => {
      const fixture = createFixture();
      await createPendingConnection(fixture);
      const { pendingDeviceId, verificationPhrase, ...metadata } =
        fixture.store.state as Record<string, unknown>;
      void verificationPhrase;
      fixture.store.state = {
        ...metadata,
        memberId: MEMBERSHIP_ID,
        bootstrapCursor: legacyPhase === 'bootstrapping' ? 'cursor-01' : null,
        deviceId: DEVICE_ID,
        downloadedItems: 3,
        ...(legacyPhase === 'approval-received' ? { pendingDeviceId } : {}),
        phase: legacyPhase,
      };
      const remote = new FakeRemoteApi();

      const resumed = await createController({
        remoteApi: remote,
        secrets: fixture.secrets,
        store: fixture.store,
      }).resume();

      const expected = {
        ...metadata,
        memberId: MEMBERSHIP_ID,
        deviceId: DEVICE_ID,
        downloadedItems: 3,
        phase: 'connected',
        version: 1,
      };
      expect(resumed).toEqual(expected);
      expect(fixture.store.state).toEqual(expected);
      expect(remote.calls).toEqual([]);
      expect(fixture.secrets.pendingCredential).toBeNull();
    },
  );

  it('rejects an approved poll response that omits the membershipId', async () => {
    const fixture = createFixture();
    await createPendingConnection(fixture);

    const remote = new FakeRemoteApi();
    remote.enqueue('poll', {
      body: {
        // No membershipId: the push member id cannot be derived, so the response
        // is treated as invalid rather than connecting with a wrong identity.
        bootstrapCursor: null,
        deviceId: DEVICE_ID,
        status: 'approved',
      },
      finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
      status: 200,
    });
    await expect(
      createController({
        remoteApi: remote,
        secrets: fixture.secrets,
        store: fixture.store,
      }).resume(),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('retries an interrupted redemption with the persisted idempotency key and redacted errors', async () => {
    const fixture = createFixture();
    queueHappyReview(fixture.remoteApi);
    fixture.remoteApi.enqueue(
      'redeem',
      new Error(`Remote accidentally echoed ${INVITATION_TOKEN}.`),
    );
    fixture.controller.beginFromPastedEnvelope(ENVELOPE);
    await fixture.controller.loadInvitationReview();

    const failure = await fixture.controller
      .confirmInvitation('Anna MacBook')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OnboardingError);
    expect(String(failure)).not.toContain(INVITATION_TOKEN);
    expect(fixture.store.state).toMatchObject({
      phase: 'redeeming',
      redemptionId: REDEMPTION_ID,
    });
    expect(fixture.secrets.invitationEnvelope).toBe(ENVELOPE);

    const retryRemote = new FakeRemoteApi();
    retryRemote.enqueue('redeem', pendingResponse());
    const retryIdFactory = vi.fn(() => 'must-not-be-used');
    const retryRefreshFactory = vi.fn(() =>
      'hm_rt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    );
    const retryController = createController({
      createInitialRefreshToken: retryRefreshFactory,
      createRedemptionId: retryIdFactory,
      remoteApi: retryRemote,
      secrets: fixture.secrets,
      store: fixture.store,
    });

    await expect(retryController.resume()).resolves.toMatchObject({
      phase: 'pending-approval',
    });
    expect(retryIdFactory).not.toHaveBeenCalled();
    expect(retryRefreshFactory).not.toHaveBeenCalled();
    expect(retryRemote.calls[0]?.request).toMatchObject({
      initialRefreshToken: REFRESH_TOKEN,
      redemptionId: REDEMPTION_ID,
    });
  });

  it('restores an uncommitted secret envelope as a local review without networking', async () => {
    const fixture = createFixture();
    fixture.secrets.invitationEnvelope = ENVELOPE;

    const state = await fixture.controller.resume();

    expect(state).toEqual({
      phase: 'origin-review',
      serverOrigin: SERVER_ORIGIN,
    });
    expect(fixture.remoteApi.calls).toEqual([]);
  });

  it('fails closed when durable state or required SecretStorage credentials are missing', async () => {
    const fixture = createFixture();
    await createPendingConnection(fixture);
    fixture.secrets.pendingCredential = null;
    const resumed = createController({
      remoteApi: new FakeRemoteApi(),
      secrets: fixture.secrets,
      store: fixture.store,
    });

    await expect(resumed.resume()).rejects.toMatchObject({
      code: 'missing-credential',
    });

    fixture.store.state = {
      phase: 'connected',
      refreshToken: REFRESH_TOKEN,
      version: 1,
    };
    const malformed = createController({
      remoteApi: new FakeRemoteApi(),
      secrets: fixture.secrets,
      store: fixture.store,
    });
    const error = await malformed.resume().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'invalid-state' });
    expect(String(error)).not.toContain(REFRESH_TOKEN);
  });

  it('strictly rejects non-UUID server IDs and non-canonical verification phrases', async () => {
    const invalidReview = createFixture();
    queueHappyReview(invalidReview.remoteApi, { vaultId: 'vault-01' });
    invalidReview.controller.beginFromPastedEnvelope(ENVELOPE);
    await expect(
      invalidReview.controller.loadInvitationReview(),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    const invalidPhrase = createFixture();
    queueHappyReview(invalidPhrase.remoteApi);
    invalidPhrase.remoteApi.enqueue('redeem', {
      ...pendingResponse(),
      body: {
        pendingCredential: PENDING_CREDENTIAL.replace('hm_pd_', 'hm_pt_'),
        pendingDeviceId: PENDING_DEVICE_ID,
        status: 'pending',
        verificationPhrase: 'amber river cedar moon',
      },
    });
    invalidPhrase.controller.beginFromPastedEnvelope(ENVELOPE);
    await invalidPhrase.controller.loadInvitationReview();
    await expect(
      invalidPhrase.controller.confirmInvitation('Anna MacBook'),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    expect(invalidPhrase.secrets.pendingCredential).toBeNull();
  });
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const remoteApi = new FakeRemoteApi();
  const store = new MemoryOnboardingStore();
  const secrets = new MemoryOnboardingSecrets();
  const createRedemptionId = vi.fn(() => REDEMPTION_ID);
  const createInitialRefreshToken = vi.fn(() => REFRESH_TOKEN);
  return {
    controller: createController({
      createRedemptionId,
      createInitialRefreshToken,
      remoteApi,
      secrets,
      store,
    }),
    createRedemptionId,
    createInitialRefreshToken,
    remoteApi,
    secrets,
    store,
  };
}

function createController(options: {
  createInitialRefreshToken?: () => string;
  createRedemptionId?: () => string;
  remoteApi: FakeRemoteApi;
  secrets: MemoryOnboardingSecrets;
  store: MemoryOnboardingStore;
}): OnboardingController {
  return new OnboardingController({
    clock: new FixedClock(NOW),
    createInitialRefreshToken:
      options.createInitialRefreshToken ?? (() => REFRESH_TOKEN),
    createRedemptionId:
      options.createRedemptionId ?? (() => REDEMPTION_ID),
    remoteApi: options.remoteApi,
    secrets: options.secrets,
    store: options.store,
  });
}

async function createPendingConnection(fixture: Fixture): Promise<void> {
  queueHappyReview(fixture.remoteApi);
  fixture.remoteApi.enqueue('redeem', pendingResponse());
  fixture.controller.beginFromPastedEnvelope(ENVELOPE);
  await fixture.controller.loadInvitationReview();
  await fixture.controller.confirmInvitation('Anna MacBook');
}

function queueHappyReview(
  remoteApi: FakeRemoteApi,
  reviewOverrides: Record<string, unknown> = {},
): void {
  remoteApi.enqueue('discover', {
    body: discoveryBody(),
    finalUrl: `${SERVER_ORIGIN}/.well-known/havemind`,
    status: 200,
  });
  remoteApi.enqueue('review', {
    body: {
      expiresAt: '2026-07-15T04:15:00.000Z',
      intendedMemberDisplayName: 'Anna',
      inviterDisplayName: 'Mikolaj',
      memberId: MEMBER_ID,
      vaultId: VAULT_ID,
      vaultName: 'Shared research',
      version: 1,
      ...reviewOverrides,
    },
    finalUrl: `${API_BASE_URL}/invitations/review`,
    status: 200,
  });
}

function discoveryBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiBaseUrl: API_BASE_URL,
    authMethods: ['opaque-token'],
    capabilities: [],
    name: 'Test Havemind',
    protocol: { major: 1, maxMinor: 0, minMinor: 0 },
    service: 'havemind',
    ...overrides,
  };
}

function pendingResponse(): RemoteResponse {
  return {
    body: {
      pendingCredential: PENDING_CREDENTIAL,
      pendingDeviceId: PENDING_DEVICE_ID,
      status: 'pending',
      verificationPhrase: VERIFICATION_PHRASE,
    },
    finalUrl: `${API_BASE_URL}/invitations/redeem`,
    status: 200,
  };
}

function approvedResponse(): RemoteResponse {
  return {
    body: {
      bootstrapCursor: null,
      deviceId: DEVICE_ID,
      membershipId: MEMBERSHIP_ID,
      status: 'approved',
    },
    finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
    status: 200,
  };
}
