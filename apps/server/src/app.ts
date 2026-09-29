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

import { registerAuthRoutes, type AuthRoutesDeps } from './auth/auth-routes.js';
import { registerMemberRosterRoutes } from './auth/member-roster-routes.js';
import { registerRejoinRoutes } from './auth/rejoin-routes.js';
import { registerRevokeRoutes } from './auth/revoke-routes.js';
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

// A 25 MiB attachment travels as a ~44.5 MiB base64 request, which a slow
// phone link cannot deliver in seconds: the whole-request budget is ten
// minutes so it is not cut off and retried forever. The header budget stays
// short against slowloris clients, and Node checks both every five seconds
// instead of its default thirty, so the limits are enforced close to their
// values. These go to http.createServer, because Node reads headersTimeout
// and the checking interval there; Fastify then reassigns requestTimeout
// from its own option, so that one is passed to both.
const REQUEST_TIMEOUT_MS = 600_000;
const HEADERS_TIMEOUT_MS = 30_000;
const CONNECTIONS_CHECKING_INTERVAL_MS = 5_000;

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks?: Readonly<Record<string, boolean>>;
}

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly auth?: AuthRoutesDeps;
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
    http: {
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    logController: new LogController({ disableRequestLogging: true }),
    logger,
    onConstructorPoisoning: 'error',
    onProtoPoisoning: 'error',
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Off unless the operator names their proxy: with it, a client could put
    // any address in X-Forwarded-For and pick its own rate-limit bucket.
    trustProxy:
      options.config.trustedProxies.length === 0
        ? false
        : [...options.config.trustedProxies],
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

  if (options.auth !== undefined) {
    registerAuthRoutes(app, options.auth);
    // F9 rejoin surface: a self-contained encapsulated plugin registered
    // alongside (not inside) auth-routes, so re-admitting a known contact after
    // a terminal auth failure needs no change to the auth-routes module.
    registerRejoinRoutes(app, {
      database: options.auth.database,
      sessions: options.auth.sessions,
      ...(options.auth.now === undefined ? {} : { now: options.auth.now }),
      ...(options.auth.rateLimit === undefined
        ? {}
        : { rateLimit: options.auth.rateLimit }),
    });
    // F9 remove-member surface: another self-contained encapsulated plugin
    // registered alongside (not inside) auth-routes, so the owner permanently
    // revoking a member's connection needs no change to the auth-routes module.
    registerRevokeRoutes(app, {
      database: options.auth.database,
      sessions: options.auth.sessions,
      ...(options.auth.now === undefined ? {} : { now: options.auth.now }),
      ...(options.auth.rateLimit === undefined
        ? {}
        : { rateLimit: options.auth.rateLimit }),
    });
    // The vault roster, read from the server rather than assembled from what
    // each device witnessed. Same access rule as /bootstrap: any active member
    // of the vault may read who else is in it.
    registerMemberRosterRoutes(app, {
      database: options.auth.database,
      sessions: options.auth.sessions,
    });
  }

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
