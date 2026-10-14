/**
 * One-click agents (plan 015): the owner's routes and the agents service's.
 *
 * Owner (bearer session): POST /vaults/:vaultId/agents adds an agent by name;
 * GET/PUT /vaults/:vaultId/agent-model say whether a model key is set, and set
 * it. Service (x-havemind-agent-service-token): POST /agent-service/claim.
 * Registered only when the server has an agents service configured.
 */

import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { AgentEnrollmentService, AgentNameTakenError } from './agent-enrollment.js';
import { InvitationError, type InvitationService } from './invitations.js';
import { loadActiveMembership, requireAuthSession } from './request-auth.js';

export interface AgentRoutesDeps {
  readonly database: Database.Database;
  readonly invitations: InvitationService;
  readonly serviceToken: string;
  readonly secretsDir: string;
  readonly apiBaseUrl: string;
}

export const AGENT_SERVICE_HEADER = 'x-havemind-agent-service-token';
/** What the agents think with (plan 016): provider, model and endpoint; no secret. */
const BRAIN_FILE = 'brain.json';
/** Its login, apart: a token, a key or a Codex auth.json. */
const BRAIN_SECRET_FILE = 'brain.secret';
/** Plan 015's single-login files, removed when a brain is set. */
const LEGACY_FILES = ['model.key', 'model.oauth'];

const modelName = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/@-]+$/u);
const claudeToken = z.string().trim().regex(/^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,400}$/u);
const anthropicKey = z.string().trim().regex(/^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,300}$/u);
const codexAuth = z
  .string()
  .trim()
  .max(20_000)
  .refine((text) => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    } catch {
      return false;
    }
  });
/** HTTPS anywhere, or plain HTTP only to this machine (a local Ollama). */
const apiBase = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname));
  });
const genericKey = z.string().trim().min(1).max(500).regex(/^[\x21-\x7e]+$/u);

const modelLoginBody = z.union([
  z.object({ key: anthropicKey }).strict(),
  z.object({ oauthToken: claudeToken }).strict(),
  z.object({ provider: z.literal('claude-code'), secret: claudeToken, model: modelName.optional() }).strict(),
  z.object({ provider: z.literal('codex'), secret: codexAuth, model: modelName.optional() }).strict(),
  z.object({ provider: z.literal('anthropic'), secret: anthropicKey, model: modelName.optional() }).strict(),
  z.object({ provider: z.literal('openai-compatible'), baseUrl: apiBase, model: modelName, secret: genericKey.optional() }).strict(),
]);

type Brain = { provider: string; model?: string | undefined; baseUrl?: string | undefined };

function brainOf(body: z.infer<typeof modelLoginBody>): { brain: Brain; secret: string | undefined } {
  if ('key' in body) return { brain: { provider: 'anthropic' }, secret: body.key };
  if ('oauthToken' in body) return { brain: { provider: 'claude-code' }, secret: body.oauthToken };
  const { secret, ...brain } = body;
  return { brain, secret };
}

async function writePrivate(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}

const vaultParams = z.object({ vaultId: z.string().uuid() });
const enrollBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const claimBody = z.object({ initialRefreshToken: z.string().min(1).max(200), redemptionId: z.string().uuid() }).strict();

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  reply.header('cache-control', 'no-store');
  return reply.status(status).send({ error: { code } });
}

function sameToken(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Owner routes; register inside the bearer-authenticated scope. */
export function registerOwnerAgentRoutes(instance: FastifyInstance, deps: AgentRoutesDeps): void {
  const enrollments = new AgentEnrollmentService(deps.database, deps.invitations);
  const ownerOf = (request: Parameters<typeof requireAuthSession>[0], reply: FastifyReply) => {
    const params = vaultParams.safeParse(request.params);
    if (!params.success) {
      fail(reply, 400, 'INVALID_REQUEST');
      return null;
    }
    const session = requireAuthSession(request, reply);
    if (session === null) return null;
    const membership = loadActiveMembership(deps.database, session.userId, params.data.vaultId);
    if (membership === null || membership.role !== 'owner') {
      fail(reply, 403, 'FORBIDDEN');
      return null;
    }
    return { vaultId: params.data.vaultId, membership, session };
  };

  instance.post('/vaults/:vaultId/agents', async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    const body = enrollBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST');
    try {
      const enrollmentId = enrollments.enroll({
        vaultId: owner.vaultId,
        ownerMembershipId: owner.membership.membershipId,
        ownerDeviceId: owner.session.deviceId,
        name: body.data.name,
      });
      reply.header('cache-control', 'no-store');
      return reply.status(201).send({ enrollmentId });
    } catch (error) {
      if (error instanceof AgentNameTakenError) return fail(reply, 409, 'NAME_TAKEN');
      throw error;
    }
  });

  instance.get('/vaults/:vaultId/agent-model', async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    const saved = await fs.readFile(join(deps.secretsDir, BRAIN_FILE), 'utf8').catch(() => null);
    let kind: string | null;
    if (saved !== null) {
      kind = (JSON.parse(saved) as Brain).provider;
    } else {
      const has = (file: string) => fs.access(join(deps.secretsDir, file)).then(() => true, () => false);
      kind = (await has('model.oauth')) ? 'claude-code' : (await has('model.key')) ? 'anthropic' : null;
    }
    reply.header('cache-control', 'no-store');
    return { configured: kind !== null, kind };
  });

  instance.put('/vaults/:vaultId/agent-model', async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    const body = modelLoginBody.safeParse(request.body);
    // Never echo the body back, not even in an error.
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST');
    const { brain, secret } = brainOf(body.data);
    // One brain at a time: the secret is written or removed with it.
    const secretFile = join(deps.secretsDir, BRAIN_SECRET_FILE);
    if (secret === undefined) await fs.rm(secretFile, { force: true });
    else await writePrivate(secretFile, `${secret}\n`);
    await writePrivate(join(deps.secretsDir, BRAIN_FILE), `${JSON.stringify(brain)}\n`);
    for (const legacy of LEGACY_FILES) await fs.rm(join(deps.secretsDir, legacy), { force: true });
    reply.header('cache-control', 'no-store');
    return reply.status(204).send();
  });
}

/** Service routes; register in a rate-limited scope without a bearer session. */
export function registerAgentServiceRoutes(instance: FastifyInstance, deps: AgentRoutesDeps): void {
  const enrollments = new AgentEnrollmentService(deps.database, deps.invitations);
  instance.post('/agent-service/claim', async (request, reply) => {
    if (!sameToken(request.headers[AGENT_SERVICE_HEADER], deps.serviceToken)) {
      return fail(reply, 401, 'UNAUTHENTICATED');
    }
    const body = claimBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST');
    try {
      const claimed = enrollments.claim(body.data);
      reply.header('cache-control', 'no-store');
      if (claimed === null) return reply.status(204).send();
      return { ...claimed, apiBaseUrl: deps.apiBaseUrl };
    } catch (error) {
      if (error instanceof InvitationError) return fail(reply, 400, 'INVALID_REQUEST');
      throw error;
    }
  });
}
