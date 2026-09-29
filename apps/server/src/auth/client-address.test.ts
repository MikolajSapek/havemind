import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { buildApp } from '../app.js';
import {
  createTestApp,
  makeTempDir,
  openMigratedDatabase,
  releaseTestResources,
} from '../test/fixtures/server-fixtures.js';
import { InvitationService } from './invitations.js';
import { SessionRepository } from './session-repository.js';

/**
 * Which address a pre-auth request is rate limited under. Behind `tailscale
 * serve` every request reaches the server through the same proxy, so unless the
 * operator names that proxy in HAVEMIND_TRUSTED_PROXIES the peer address is the
 * only thing to key on and all clients share one bucket (plans/001 section 8:
 * "Forwarded proxy information is trusted only from the explicitly configured
 * ingress").
 */

afterEach(releaseTestResources);

// The proxy as the server sees it in the shipped Compose stack: an address on
// the Compose network (the last test covers how a `::` listener reports it).
const PROXY = '172.18.0.1';
const TRUSTED = '172.18.0.0/16';
// Two devices, as `tailscale serve` reports them in X-Forwarded-For. Real
// tailnet addresses (the CGNAT range) trip the private-infra check, so these are
// documentation addresses (RFC 5737).
const CLIENT_A = '192.0.2.1';
const CLIENT_B = '192.0.2.2';

// One row per limiter that keys unauthenticated requests by client address.
const IP_KEYED_ROUTES = [
  {
    body: { invitationToken: 'junk' },
    name: 'invitation review (the shared pre-auth bucket)',
    url: '/invitations/review',
  },
  { body: {}, name: 'guessed refresh tokens', url: '/auth/refresh' },
  { body: {}, name: 'rejoin', url: '/auth/rejoin' },
  {
    body: {},
    name: 'membership revoke',
    url: `/owner/memberships/${randomUUID()}/revoke`,
  },
] as const;

type Route = (typeof IP_KEYED_ROUTES)[number];

const REVIEW = IP_KEYED_ROUTES[0];

/** An app that allows each client address exactly one request a minute. */
function makeApp(trustedProxies?: string): ReturnType<typeof buildApp> {
  const database = openMigratedDatabase(makeTempDir('havemind-client-address-'));
  return createTestApp(
    {
      database,
      invitations: new InvitationService(database),
      now: () => new Date('2026-09-29T00:00:00.000Z'),
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
      sessions: new SessionRepository(database),
    },
    {
      env:
        trustedProxies === undefined
          ? {}
          : { HAVEMIND_TRUSTED_PROXIES: trustedProxies },
      fixedClientKey: false,
    },
  );
}

async function send(
  app: ReturnType<typeof buildApp>,
  route: Route,
  connection: { readonly forwardedFor: string; readonly peer?: string },
): Promise<number> {
  const response = await app.inject({
    body: route.body,
    headers: { 'x-forwarded-for': connection.forwardedFor },
    method: 'POST',
    remoteAddress: connection.peer ?? PROXY,
    url: route.url,
  });
  return response.statusCode;
}

describe.each(IP_KEYED_ROUTES)('client address on $name', (route) => {
  it('gives each client behind a trusted proxy its own bucket', async () => {
    const app = makeApp(TRUSTED);

    expect(await send(app, route, { forwardedFor: CLIENT_A })).not.toBe(429);
    expect(await send(app, route, { forwardedFor: CLIENT_A })).toBe(429);
    expect(await send(app, route, { forwardedFor: CLIENT_B })).not.toBe(429);
  });

  it('keeps one shared bucket, header ignored, when no proxy is trusted', async () => {
    const app = makeApp();

    expect(await send(app, route, { forwardedFor: CLIENT_A })).not.toBe(429);
    expect(await send(app, route, { forwardedFor: CLIENT_B })).toBe(429);
  });
});

describe('X-Forwarded-For handling', () => {
  it('ignores the header from an address that is not a trusted proxy', async () => {
    const app = makeApp(TRUSTED);
    const stranger = { peer: '203.0.113.9' };

    expect(
      await send(app, REVIEW, { ...stranger, forwardedFor: CLIENT_A }),
    ).not.toBe(429);
    // A different claimed client changes nothing: the peer is the key.
    expect(
      await send(app, REVIEW, { ...stranger, forwardedFor: CLIENT_B }),
    ).toBe(429);
  });

  it('uses the address the trusted proxy appended, not one the client supplied', async () => {
    const app = makeApp(TRUSTED);

    expect(
      await send(app, REVIEW, { forwardedFor: `198.51.100.7, ${CLIENT_A}` }),
    ).not.toBe(429);
    // Same appended address behind a different invented prefix: same client.
    expect(
      await send(app, REVIEW, { forwardedFor: `203.0.113.99, ${CLIENT_A}` }),
    ).toBe(429);
    // Same invented prefix behind another appended address: another client.
    expect(
      await send(app, REVIEW, { forwardedFor: `198.51.100.7, ${CLIENT_B}` }),
    ).not.toBe(429);
  });

  it('recognises a proxy that a dual-stack listener reports as an IPv4-mapped address', async () => {
    const app = makeApp(TRUSTED);
    const mapped = { peer: `::ffff:${PROXY}` };

    expect(
      await send(app, REVIEW, { ...mapped, forwardedFor: CLIENT_A }),
    ).not.toBe(429);
    expect(
      await send(app, REVIEW, { ...mapped, forwardedFor: CLIENT_A }),
    ).toBe(429);
    expect(
      await send(app, REVIEW, { ...mapped, forwardedFor: CLIENT_B }),
    ).not.toBe(429);
  });
});
