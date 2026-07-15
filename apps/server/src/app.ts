import type { Writable } from 'node:stream';

import {
  HAVEMIND_SERVICE_ID,
  MAX_SUPPORTED_PROTOCOL_MINOR,
  MIN_SUPPORTED_PROTOCOL_MINOR,
  PROTOCOL_MAJOR_VERSION,
  discoveryDocumentSchema,
  type DiscoveryDocument,
} from '@havemind/protocol';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import type { ServerConfig } from './config.js';

const LOGGER_REDACTION_PATHS = [
  'accessToken',
  'authorization',
  'bootstrapToken',
  'body',
  'headers.authorization',
  'headers.cookie',
  'invitationToken',
  'noteContent',
  'payload',
  'refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
] as const;

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks?: Readonly<Record<string, boolean>>;
}

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly loggerStream?: Writable;
  readonly readiness?: () => Promise<ReadinessResult> | ReadinessResult;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const readiness = options.readiness ?? defaultReadiness;
  const logger = {
    level: options.config.logLevel,
    redact: {
      censor: '[REDACTED]',
      paths: [...LOGGER_REDACTION_PATHS],
    },
    ...(options.loggerStream === undefined
      ? {}
      : { stream: options.loggerStream }),
  };
  const app = Fastify({
    bodyLimit: options.config.bodyLimitBytes,
    logController: new LogController({ disableRequestLogging: true }),
    logger,
    onConstructorPoisoning: 'error',
    onProtoPoisoning: 'error',
    requestTimeout: 30_000,
    trustProxy: false,
  });

  const discovery = createDiscoveryDocument(options.config);

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      'request completed',
    );
  });

  app.get('/.well-known/havemind', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return discovery;
  });

  app.get('/healthz', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/readyz', async (request, reply) => {
    reply.header('cache-control', 'no-store');

    try {
      const result = await readiness();
      if (!result.ready) {
        reply.code(503);
        return {
          ...(result.checks === undefined ? {} : { checks: result.checks }),
          status: 'not-ready',
        };
      }

      return {
        ...(result.checks === undefined ? {} : { checks: result.checks }),
        status: 'ready',
      };
    } catch {
      request.log.warn('readiness check failed');
      reply.code(503);
      return { status: 'not-ready' };
    }
  });

  return app;
}

function createDiscoveryDocument(config: ServerConfig): DiscoveryDocument {
  return discoveryDocumentSchema.parse({
    apiBaseUrl: config.apiBaseUrl,
    authMethods: ['opaque-token'],
    capabilities: [],
    name: config.serverName,
    protocol: {
      major: PROTOCOL_MAJOR_VERSION,
      maxMinor: MAX_SUPPORTED_PROTOCOL_MINOR,
      minMinor: MIN_SUPPORTED_PROTOCOL_MINOR,
    },
    service: HAVEMIND_SERVICE_ID,
  });
}

function defaultReadiness(): ReadinessResult {
  return { ready: true };
}
