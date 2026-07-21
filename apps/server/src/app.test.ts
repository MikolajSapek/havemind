import { Writable } from 'node:stream';

import { discoveryDocumentSchema } from '@havemind/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type ReadinessResult } from './app.js';
import {
  ConfigValidationError,
  DEFAULT_BODY_LIMIT_BYTES,
  parseServerConfig,
} from './config.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

describe('server configuration', () => {
  it('uses bounded defaults and a loopback listener', () => {
    const config = parseServerConfig(TEST_ENV);

    expect(config).toMatchObject({
      apiBaseUrl: 'https://sync.example.test/api/v1',
      bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
      host: '127.0.0.1',
      logLevel: 'info',
      port: 8787,
      serverName: 'Test Havemind',
    });
  });

  it('normalizes a trailing slash from the API base URL', () => {
    const config = parseServerConfig({
      ...TEST_ENV,
      HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1/',
    });

    expect(config.apiBaseUrl).toBe('https://sync.example.test/api/v1');
  });

  it.each([
    ['missing API base URL', { HAVEMIND_SERVER_NAME: 'Test' }],
    [
      'insecure public URL',
      { ...TEST_ENV, HAVEMIND_API_BASE_URL: 'http://sync.example.test/api/v1' },
    ],
    [
      'credential-bearing URL',
      {
        ...TEST_ENV,
        HAVEMIND_API_BASE_URL: 'https://user:secret@sync.example.test/api/v1',
      },
    ],
    ['invalid port', { ...TEST_ENV, HAVEMIND_PORT: '70000' }],
    ['invalid body limit', { ...TEST_ENV, HAVEMIND_BODY_LIMIT_BYTES: '100' }],
    ['invalid log level', { ...TEST_ENV, HAVEMIND_LOG_LEVEL: 'verbose' }],
    ['empty server name', { ...TEST_ENV, HAVEMIND_SERVER_NAME: '   ' }],
    ['invalid public-listener flag', { ...TEST_ENV, HAVEMIND_ALLOW_NON_LOOPBACK: 'yes' }],
  ])('rejects %s', (_caseName, environment) => {
    expect(() => parseServerConfig(environment)).toThrow(ConfigValidationError);
  });

  it('round-trips a body limit override that covers base64-inflated attachments', () => {
    // F9 binary attachments: a 25 MB raw file inflates to ~33.4 MB as base64,
    // so the body limit must be settable comfortably above the old 1 MB
    // default without hitting the bounds validator.
    const override = 40 * 1024 * 1024;

    const config = parseServerConfig({
      ...TEST_ENV,
      HAVEMIND_BODY_LIMIT_BYTES: String(override),
    });

    expect(config.bodyLimitBytes).toBe(override);
  });

  it('requires an explicit opt-in for a non-loopback listener', () => {
    expect(() =>
      parseServerConfig({
        ...TEST_ENV,
        HAVEMIND_HOST: '0.0.0.0',
      }),
    ).toThrow(ConfigValidationError);

    expect(
      parseServerConfig({
        ...TEST_ENV,
        HAVEMIND_ALLOW_NON_LOOPBACK: 'true',
        HAVEMIND_HOST: '0.0.0.0',
      }).host,
    ).toBe('0.0.0.0');
  });
});

describe('Fastify application', () => {
  const applications: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map(async (app) => app.close()));
  });

  function createApp(options?: {
    readiness?: () => Promise<ReadinessResult> | ReadinessResult;
    loggerStream?: Writable;
    bodyLimitBytes?: number;
  }) {
    const config = parseServerConfig({
      ...TEST_ENV,
      ...(options?.bodyLimitBytes === undefined
        ? {}
        : { HAVEMIND_BODY_LIMIT_BYTES: String(options.bodyLimitBytes) }),
    });
    const app = buildApp({
      config,
      ...(options?.readiness === undefined
        ? {}
        : { readiness: options.readiness }),
      ...(options?.loggerStream === undefined
        ? {}
        : { loggerStream: options.loggerStream }),
    });
    applications.push(app);
    return app;
  }

  it('does not start a listener when the application is built', () => {
    const app = createApp();

    expect(app.server.listening).toBe(false);
  });

  it('returns a protocol-valid discovery document without caching it', async () => {
    const app = createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/havemind',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(discoveryDocumentSchema.parse(response.json())).toEqual({
      apiBaseUrl: 'https://sync.example.test/api/v1',
      authMethods: ['opaque-token'],
      capabilities: [],
      name: 'Test Havemind',
      protocol: {
        major: 1,
        maxMinor: 0,
        minMinor: 0,
      },
      service: 'havemind',
    });
  });

  it('keeps liveness independent from readiness', async () => {
    const app = createApp({
      readiness: () => ({ ready: false, checks: { persistence: false } }),
    });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns readiness details when dependencies are ready', async () => {
    const app = createApp({
      readiness: () => ({ ready: true, checks: { persistence: true } }),
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      checks: { persistence: true },
      status: 'ready',
    });
  });

  it('is ready by default before persistence checks are registered', async () => {
    const app = createApp();

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 with failed readiness details', async () => {
    const app = createApp({
      readiness: () => ({ ready: false, checks: { persistence: false } }),
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checks: { persistence: false },
      status: 'not-ready',
    });
  });

  it('returns 503 without leaking a readiness exception', async () => {
    const stream = collectLogs();
    const app = createApp({
      loggerStream: stream.writer,
      readiness: () => {
        throw new Error('database-password-should-not-leak');
      },
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('database-password-should-not-leak');
    expect(response.json()).toEqual({ status: 'not-ready' });
  });

  it('redacts credentials and note data from structured logs', async () => {
    const stream = collectLogs();
    const app = createApp({ loggerStream: stream.writer });

    app.log.info(
      {
        accessToken: 'access-secret',
        authorization: 'Bearer authorization-secret',
        bootstrapToken: 'bootstrap-secret',
        invitationToken: 'invitation-secret',
        noteContent: 'private note body',
        refreshToken: 'refresh-secret',
        safeField: 'visible-value',
      },
      'redaction-check',
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = stream.read();

    expect(output).toContain('visible-value');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('access-secret');
    expect(output).not.toContain('authorization-secret');
    expect(output).not.toContain('bootstrap-secret');
    expect(output).not.toContain('invitation-secret');
    expect(output).not.toContain('private note body');
    expect(output).not.toContain('refresh-secret');
  });

  it('does not log raw request query strings', async () => {
    const stream = collectLogs();
    const app = createApp({ loggerStream: stream.writer });

    await app.inject({
      method: 'GET',
      url: '/healthz?invitationToken=query-secret',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.read()).not.toContain('query-secret');
  });

  it('rejects JSON bodies above the configured limit', async () => {
    const app = createApp({ bodyLimitBytes: 1024 });
    app.post('/test-only/json', async (request) => request.body);

    const accepted = await app.inject({
      method: 'POST',
      payload: { value: 'a'.repeat(900) },
      url: '/test-only/json',
    });
    const rejected = await app.inject({
      method: 'POST',
      payload: { value: 'a'.repeat(2048) },
      url: '/test-only/json',
    });

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(413);
  });
});

function collectLogs(): { writer: Writable; read: () => string } {
  const chunks: string[] = [];
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return {
    read: () => chunks.join(''),
    writer,
  };
}
