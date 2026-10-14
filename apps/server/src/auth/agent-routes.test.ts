/**
 * Plan 015: an AI agent added with one click. The owner enrolls it; the agents
 * service, holding the server's service token, claims it; the server runs its
 * own invite, redeem and approve steps in-process. The model key is a file,
 * never a database row.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TTL_SECONDS,
  createTestApp,
  makeTempDir,
  mintAccessToken,
  openMigratedDatabase,
  REFRESH_TTL_SECONDS,
  releaseTestResources,
  rowSeeder,
} from '../test/fixtures/server-fixtures.js';
import { InvitationService } from './invitations.js';
import { SessionRepository } from './session-repository.js';
import { createRefreshSuccessor, generateRefreshToken } from './tokens.js';

const START = '2026-10-14T03:00:00.000Z';
const OWNER_USER = '90000000-0000-4000-8000-0000000000a1';
const OWNER_DEVICE = '90000000-0000-4000-8000-0000000000a2';
const VAULT = '90000000-0000-4000-8000-0000000000a3';
const OWNER_MEMBERSHIP = '90000000-0000-4000-8000-0000000000a4';
const EDITOR_USER = '90000000-0000-4000-8000-0000000000b1';
const EDITOR_DEVICE = '90000000-0000-4000-8000-0000000000b2';
const EDITOR_MEMBERSHIP = '90000000-0000-4000-8000-0000000000b4';
const SERVICE_TOKEN = 'hm_svc_' + 'x'.repeat(43);
const SERVICE_HEADER = 'x-havemind-agent-service-token';

const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(START, Buffer.alloc(32, 0x22));

afterEach(() => releaseTestResources());

function setup(options: { serviceToken?: boolean } = {}) {
  const database = openMigratedDatabase(makeTempDir('havemind-agents-'));
  const secretsDir = makeTempDir('havemind-agent-secrets-');
  const sessions = new SessionRepository(database, { accessTokenTtlSeconds: ACCESS_TTL_SECONDS });
  const invitations = new InvitationService(database, {
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS,
    refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
  });
  insertUser(database, OWNER_USER, 'Alice', 1);
  insertDevice(database, OWNER_DEVICE, OWNER_USER, 'Alice Laptop');
  insertVault(database, VAULT, 'Shared Vault');
  insertMembership(database, OWNER_MEMBERSHIP, VAULT, OWNER_USER);
  insertUser(database, EDITOR_USER, 'Bob', 0);
  insertDevice(database, EDITOR_DEVICE, EDITOR_USER, 'Bob Laptop');
  insertMembership(database, EDITOR_MEMBERSHIP, VAULT, EDITOR_USER, 'editor');
  const app = createTestApp(
    { database, invitations, sessions },
    options.serviceToken === false
      ? {}
      : { env: { HAVEMIND_AGENT_SERVICE_TOKEN: SERVICE_TOKEN, HAVEMIND_AGENT_SECRETS_DIR: secretsDir } },
  );
  return {
    app,
    database,
    secretsDir,
    owner: mintAccessToken(database, sessions, OWNER_USER, OWNER_DEVICE),
    editor: mintAccessToken(database, sessions, EDITOR_USER, EDITOR_DEVICE),
  };
}

type Setup = ReturnType<typeof setup>;

const enroll = (s: Setup, token: string, name: string) =>
  s.app.inject({
    method: 'POST',
    url: `/vaults/${VAULT}/agents`,
    headers: { authorization: `Bearer ${token}` },
    body: { name },
  });

const claim = (s: Setup, redemptionId: string, refreshToken = generateRefreshToken(), service = SERVICE_TOKEN) =>
  s.app.inject({
    method: 'POST',
    url: '/agent-service/claim',
    headers: { [SERVICE_HEADER]: service },
    body: { initialRefreshToken: refreshToken, redemptionId },
  });

const agentRow = (database: Database.Database, membershipId: string) =>
  database
    .prepare(
      `SELECT m.kind AS kind, m.role AS role, u.display_name AS name
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    )
    .get(membershipId) as { kind: string; role: string; name: string } | undefined;

describe('one-click agents (plan 015)', () => {
  it('lets the owner add an agent that the service then claims, without any code', async () => {
    const s = setup();
    expect((await enroll(s, s.owner, 'Inbox sorter')).statusCode).toBe(201);

    const refreshToken = generateRefreshToken();
    const claimed = await claim(s, '90000000-0000-4000-8000-00000000c001', refreshToken);
    expect(claimed.statusCode).toBe(200);
    const body = claimed.json() as {
      apiBaseUrl: string; vaultId: string; vaultName: string; membershipId: string; deviceId: string; name: string;
    };
    expect(body).toMatchObject({ vaultId: VAULT, vaultName: 'Shared Vault', name: 'Inbox sorter' });
    expect(body.apiBaseUrl).toMatch(/^https:\/\//u);
    expect(JSON.stringify(body)).not.toContain(refreshToken);
    expect(agentRow(s.database, body.membershipId)).toEqual({ kind: 'agent', role: 'editor', name: 'Inbox sorter' });

    // The service's own refresh token now works for that device.
    const refresh = await s.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      body: (() => {
        const successor = createRefreshSuccessor();
        return { refreshToken, rotationId: successor.rotationId, successorRefreshToken: successor.refreshToken };
      })(),
    });
    expect(refresh.statusCode).toBe(200);

    // Nothing else waits.
    expect((await claim(s, '90000000-0000-4000-8000-00000000c002')).statusCode).toBe(204);
  });

  it('answers a repeated claim with the same agent, never a second one', async () => {
    const s = setup();
    await enroll(s, s.owner, 'Daily summary');
    const id = '90000000-0000-4000-8000-00000000c003';
    const token = generateRefreshToken();
    const first = (await claim(s, id, token)).json() as { membershipId: string };
    const again = await claim(s, id, token);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { membershipId: string }).membershipId).toBe(first.membershipId);
    const agents = s.database.prepare("SELECT COUNT(*) AS c FROM memberships WHERE kind = 'agent'").get() as { c: number };
    expect(agents.c).toBe(1);
  });

  it('only the owner adds agents, and only the service claims them', async () => {
    const s = setup();
    expect((await enroll(s, s.editor, 'Sneaky')).statusCode).toBe(403);
    await enroll(s, s.owner, 'Link gardener');
    expect((await claim(s, '90000000-0000-4000-8000-00000000c004', generateRefreshToken(), 'hm_svc_' + 'y'.repeat(43))).statusCode).toBe(401);
    const noHeader = await s.app.inject({
      method: 'POST',
      url: '/agent-service/claim',
      body: { initialRefreshToken: generateRefreshToken(), redemptionId: '90000000-0000-4000-8000-00000000c005' },
    });
    expect(noHeader.statusCode).toBe(401);
  });

  it('refuses a name a member or a waiting agent already has', async () => {
    const s = setup();
    expect((await enroll(s, s.owner, 'Bob')).statusCode).toBe(409);
    expect((await enroll(s, s.owner, 'Inbox sorter')).statusCode).toBe(201);
    expect((await enroll(s, s.owner, 'inbox SORTER')).statusCode).toBe(409);
  });

  it('keeps the model key in a 0600 file, never in the database, and never sends it back', async () => {
    const s = setup();
    const key = 'sk-ant-api03-' + 'k'.repeat(40);
    const status = () =>
      s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` } });
    expect((await status()).json()).toEqual({ configured: false, kind: null });
    const put = await s.app.inject({
      method: 'PUT',
      url: `/vaults/${VAULT}/agent-model`,
      headers: { authorization: `Bearer ${s.owner}` },
      body: { key },
    });
    expect(put.statusCode).toBe(204);
    expect(put.body).toBe('');
    expect((await status()).json()).toEqual({ configured: true, kind: 'api-key' });

    const file = join(s.secretsDir, 'model.key');
    expect(readFileSync(file, 'utf8').trim()).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const dump = s.database.prepare("SELECT group_concat(sql) AS s FROM sqlite_master").get() as { s: string };
    expect(dump.s).not.toMatch(/model_key|agent_settings/u);

    const editorPut = await s.app.inject({
      method: 'PUT',
      url: `/vaults/${VAULT}/agent-model`,
      headers: { authorization: `Bearer ${s.editor}` },
      body: { key },
    });
    expect(editorPut.statusCode).toBe(403);
  });

  it('takes a Claude subscription token instead of a key, and keeps only one login (plan 016)', async () => {
    const s = setup();
    const put = (body: Record<string, string>) =>
      s.app.inject({ method: 'PUT', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` }, body });
    const status = async () =>
      (await s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` } })).json();
    expect((await put({ oauthToken: 'sk-ant-oat01-' + 't'.repeat(40) })).statusCode).toBe(204);
    expect(await status()).toEqual({ configured: true, kind: 'subscription' });
    const oauthFile = join(s.secretsDir, 'model.oauth');
    expect(statSync(oauthFile).mode & 0o777).toBe(0o600);
    expect((await put({ key: 'sk-ant-api03-' + 'k'.repeat(40) })).statusCode).toBe(204);
    expect(await status()).toEqual({ configured: true, kind: 'api-key' });
    expect(existsSync(oauthFile)).toBe(false);
    expect((await put({ oauthToken: 'sk-ant-api03-wrong-kind-' + 'x'.repeat(30) })).statusCode).toBe(400);
    expect((await put({ key: 'a', oauthToken: 'b' })).statusCode).toBe(400);
  });

  it('offers none of it on a server without an agents service', async () => {
    const s = setup({ serviceToken: false });
    expect((await enroll(s, s.owner, 'Inbox sorter')).statusCode).toBe(404);
    expect((await claim(s, '90000000-0000-4000-8000-00000000c006')).statusCode).toBe(404);
    const discovery = (await s.app.inject({ method: 'GET', url: '/.well-known/havemind' })).json() as { capabilities: string[] };
    expect(discovery.capabilities).not.toContain('agent-service-v1');
    expect(existsSync(join(s.secretsDir, 'model.key'))).toBe(false);
  });

  it('lists agent-service-v1 in discovery when the service is set up', async () => {
    const s = setup();
    const discovery = (await s.app.inject({ method: 'GET', url: '/.well-known/havemind' })).json() as { capabilities: string[] };
    expect(discovery.capabilities).toContain('agent-service-v1');
  });
});
