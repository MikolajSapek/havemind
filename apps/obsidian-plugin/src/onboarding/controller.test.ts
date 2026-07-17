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
const VERIFICATION_PHRASE = '123456';
const SERVER_ORIGIN = 'https://sync.example.test';
const API_BASE_URL = `${SERVER_ORIGIN}/api/v1`;
const ENVELOPE = buildInviteEnvelope({
  invitationToken: INVITATION_TOKEN,
  serverOrigin: SERVER_ORIGIN,
});
const NOW = Date.parse('2026-07-15T04:00:00.000Z');

type RemoteMethod =
  | 'bootstrap'
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

  async fetchBootstrapPage(
    request: Parameters<RemoteApiPort['fetchBootstrapPage']>[0],
  ): Promise<RemoteResponse> {
    return this.respond('bootstrap', request);
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
  readonly bootstrapPages: unknown[][] = [];
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

  async commitBootstrapPage(
    items: readonly unknown[],
    state: DurableOnboardingState,
  ): Promise<void> {
    this.bootstrapPages.push(structuredClone([...items]));
    await this.saveState(state);
  }
}

class MemoryOnboardingSecrets implements OnboardingSecretsPort {
  invitationEnvelope: string | null = null;
  pendingCredential: string | null = null;
  refreshToken: string | null = null;

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

  it('resumes pending approval and a paged bootstrap across controller restarts', async () => {
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
      phase: 'approval-received',
    });
    expect(fixture.secrets.refreshToken).toBe(REFRESH_TOKEN);
    expect(JSON.stringify(fixture.store.state)).not.toContain(REFRESH_TOKEN);

    const transitionController = createController({
      remoteApi: new FakeRemoteApi(),
      secrets: fixture.secrets,
      store: fixture.store,
    });
    await expect(transitionController.resume()).resolves.toMatchObject({
      bootstrapCursor: null,
      downloadedItems: 0,
      phase: 'bootstrapping',
    });
    expect(fixture.secrets.pendingCredential).toBeNull();

    const firstPageRemote = new FakeRemoteApi();
    firstPageRemote.enqueue('bootstrap', {
      body: {
        complete: false,
        items: [{ eventId: 'event-01' }],
        nextCursor: 'cursor-01',
        version: 1,
      },
      finalUrl: `${API_BASE_URL}/bootstrap`,
      status: 200,
    });
    await expect(
      createController({
        remoteApi: firstPageRemote,
        secrets: fixture.secrets,
        store: fixture.store,
      }).resume(),
    ).resolves.toMatchObject({
      bootstrapCursor: 'cursor-01',
      downloadedItems: 1,
      phase: 'bootstrapping',
    });

    const finalPageRemote = new FakeRemoteApi();
    finalPageRemote.enqueue('bootstrap', {
      body: {
        complete: true,
        items: [{ eventId: 'event-02' }],
        nextCursor: null,
        version: 1,
      },
      finalUrl: `${API_BASE_URL}/bootstrap`,
      status: 200,
    });
    const connected = await createController({
      remoteApi: finalPageRemote,
      secrets: fixture.secrets,
      store: fixture.store,
    }).resume();

    expect(connected).toMatchObject({
      downloadedItems: 2,
      phase: 'connected',
    });
    expect(fixture.store.bootstrapPages).toEqual([
      [{ eventId: 'event-01' }],
      [{ eventId: 'event-02' }],
    ]);
    expect(JSON.stringify(fixture.store.state)).not.toContain(REFRESH_TOKEN);
    expect(firstPageRemote.calls[0]?.request).toMatchObject({
      cursor: null,
      redirect: 'error',
      refreshToken: REFRESH_TOKEN,
      url: `${API_BASE_URL}/bootstrap`,
    });
    expect(String(firstPageRemote.calls[0]?.request.url)).not.toContain(
      REFRESH_TOKEN,
    );
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
      status: 'approved',
    },
    finalUrl: `${API_BASE_URL}/devices/${PENDING_DEVICE_ID}/approval`,
    status: 200,
  };
}
