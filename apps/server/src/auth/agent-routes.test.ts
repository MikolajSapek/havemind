/**
 * Plan 015: an AI agent added with one click. The owner enrolls it; the agents
 * service, holding the server's service token, claims it; the server runs its
 * own invite, redeem and approve steps in-process. The model key is a file,
 * never a database row.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TTL_SECONDS,
  collectLogs,
  createTestApp,
  makeTempDir,
  mintAccessToken,
  openMigratedDatabase,
  REFRESH_TTL_SECONDS,
  releaseTestResources,
  rowSeeder,
} from '../test/fixtures/server-fixtures.js';
import { AgentEnrollmentService } from './agent-enrollment.js';
import { InvitationError, InvitationService } from './invitations.js';
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
const OWNER_B_USER = '90000000-0000-4000-8000-0000000000c1';
const OWNER_B_DEVICE = '90000000-0000-4000-8000-0000000000c2';
const VAULT_B = '90000000-0000-4000-8000-0000000000c3';
const OWNER_B_MEMBERSHIP = '90000000-0000-4000-8000-0000000000c4';
const SERVICE_TOKEN = 'hm_svc_' + 'x'.repeat(43);
const SERVICE_HEADER = 'x-havemind-agent-service-token';

const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(START, Buffer.alloc(32, 0x22));

afterEach(() => releaseTestResources());

function setup(options: { serviceToken?: boolean; secondVault?: boolean; secretsDir?: string; loggerStream?: Writable } = {}) {
  const database = openMigratedDatabase(makeTempDir('havemind-agents-'));
  const secretsDir = options.secretsDir ?? makeTempDir('havemind-agent-secrets-');
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
  if (options.secondVault === true) {
    insertUser(database, OWNER_B_USER, 'Carol', 0);
    insertDevice(database, OWNER_B_DEVICE, OWNER_B_USER, 'Carol Laptop');
    insertVault(database, VAULT_B, 'Other Vault');
    insertMembership(database, OWNER_B_MEMBERSHIP, VAULT_B, OWNER_B_USER);
  }
  const app = createTestApp(
    { database, invitations, sessions },
    options.serviceToken === false
      ? {}
      : {
          env: { HAVEMIND_AGENT_SERVICE_TOKEN: SERVICE_TOKEN, HAVEMIND_AGENT_SECRETS_DIR: secretsDir },
          ...(options.loggerStream === undefined ? {} : { loggerStream: options.loggerStream }),
        },
  );
  return {
    app,
    database,
    secretsDir,
    owner: mintAccessToken(database, sessions, OWNER_USER, OWNER_DEVICE),
    editor: mintAccessToken(database, sessions, EDITOR_USER, EDITOR_DEVICE),
    ownerB: options.secondVault === true ? mintAccessToken(database, sessions, OWNER_B_USER, OWNER_B_DEVICE) : '',
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

  it('names the agent as an agent in the members list the plugin reads (plan 014)', async () => {
    const s = setup();
    await enroll(s, s.owner, 'Inbox sorter');
    const claimed = (await claim(s, '90000000-0000-4000-8000-00000000c009')).json() as { membershipId: string };
    const members = (await s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/members`, headers: { authorization: `Bearer ${s.owner}` } })).json() as {
      members: { membershipId: string; kind: string }[];
    };
    expect(members.members.find((m) => m.membershipId === claimed.membershipId)?.kind).toBe('agent');
    expect(members.members.find((m) => m.membershipId === OWNER_MEMBERSHIP)?.kind).toBe('person');
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
    expect((await status()).json()).toEqual({ configured: true, kind: 'anthropic' });

    const file = join(s.secretsDir, VAULT, 'brain.secret');
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
    expect(await status()).toEqual({ configured: true, kind: 'claude-code' });
    const secretFile = join(s.secretsDir, VAULT, 'brain.secret');
    expect(readFileSync(secretFile, 'utf8')).toContain('sk-ant-oat01-');
    expect((await put({ key: 'sk-ant-api03-' + 'k'.repeat(40) })).statusCode).toBe(204);
    expect(await status()).toEqual({ configured: true, kind: 'anthropic' });
    expect(readFileSync(secretFile, 'utf8')).toContain('sk-ant-api03-');
    expect((await put({ oauthToken: 'sk-ant-api03-wrong-kind-' + 'x'.repeat(30) })).statusCode).toBe(400);
    expect((await put({ key: 'a', oauthToken: 'b' })).statusCode).toBe(400);
  });

  it('takes any provider the agents service can run, with its model, the secret kept apart (plan 016)', async () => {
    const s = setup();
    const put = (body: Record<string, string>) =>
      s.app.inject({ method: 'PUT', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` }, body });
    const status = async () =>
      (await s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` } })).json();

    // Codex and Cursor can read the whole disk: not accepted until they run sandboxed.
    for (const provider of ['codex', 'cursor']) {
      expect((await put({ provider, secret: '{"tokens":{"refresh_token":"r"}}', model: 'gpt-5-codex' })).statusCode).toBe(400);
    }
    expect(await status()).toEqual({ configured: false, kind: null });

    expect((await put({ provider: 'anthropic', secret: 'sk-ant-api03-' + 'k'.repeat(40), model: 'claude-sonnet-4-5' })).statusCode).toBe(204);
    expect(JSON.parse(readFileSync(join(s.secretsDir, VAULT, 'brain.json'), 'utf8'))).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(readFileSync(join(s.secretsDir, VAULT, 'brain.secret'), 'utf8')).toContain('sk-ant-api03-');
    expect(statSync(join(s.secretsDir, VAULT)).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.secretsDir, VAULT, 'brain.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.secretsDir, VAULT, 'brain.secret')).mode & 0o777).toBe(0o600);

    expect((await put({ provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-pro', secret: 'sk-or-v1-abc' })).statusCode).toBe(204);
    expect(await status()).toEqual({ configured: true, kind: 'openai-compatible' });
    // Ollama on the same machine needs no key.
    expect((await put({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' })).statusCode).toBe(204);
    expect(existsSync(join(s.secretsDir, VAULT, 'brain.secret'))).toBe(false);

    expect((await put({ provider: 'openai-compatible', baseUrl: 'ftp://x', model: 'm' })).statusCode).toBe(400);
    expect((await put({ provider: 'openai-compatible', baseUrl: 'http://example.com/v1', model: 'm' })).statusCode).toBe(400);
    expect((await put({ provider: 'nonsense', secret: 'x' })).statusCode).toBe(400);
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

  describe('the brain, per vault (plan 018 item 13)', () => {
    const put = (s: Setup, token: string, vault: string, body: Record<string, string>) =>
      s.app.inject({ method: 'PUT', url: `/vaults/${vault}/agent-model`, headers: { authorization: `Bearer ${token}` }, body });
    const kind = async (s: Setup, token: string, vault: string) =>
      (await s.app.inject({ method: 'GET', url: `/vaults/${vault}/agent-model`, headers: { authorization: `Bearer ${token}` } })).json();

    it("keeps one vault's brain apart from another's", async () => {
      const s = setup({ secondVault: true });
      const keyA = 'sk-ant-api03-' + 'a'.repeat(40);
      const tokenB = 'sk-ant-oat01-' + 'b'.repeat(40);
      expect((await put(s, s.owner, VAULT, { key: keyA })).statusCode).toBe(204);
      expect(await kind(s, s.ownerB, VAULT_B)).toEqual({ configured: false, kind: null });
      expect((await put(s, s.ownerB, VAULT_B, { oauthToken: tokenB })).statusCode).toBe(204);
      expect(await kind(s, s.owner, VAULT)).toEqual({ configured: true, kind: 'anthropic' });
      expect(await kind(s, s.ownerB, VAULT_B)).toEqual({ configured: true, kind: 'claude-code' });
      expect(readFileSync(join(s.secretsDir, VAULT, 'brain.secret'), 'utf8').trim()).toBe(keyA);
      expect(readFileSync(join(s.secretsDir, VAULT_B, 'brain.secret'), 'utf8').trim()).toBe(tokenB);
      // The owner of B cannot reach A's brain, read or write.
      expect((await put(s, s.ownerB, VAULT, { key: keyA })).statusCode).toBe(403);
      expect((await s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.ownerB}` } })).statusCode).toBe(403);
    });

    it('never pairs a new provider with an old secret and leaves no temp files', async () => {
      const s = setup();
      await put(s, s.owner, VAULT, { key: 'sk-ant-api03-' + 'a'.repeat(40) });
      await put(s, s.owner, VAULT, { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
      expect(existsSync(join(s.secretsDir, VAULT, 'brain.secret'))).toBe(false);
      expect(readdirSync(join(s.secretsDir, VAULT)).sort()).toEqual(['brain.json']);
    });

    it('treats an unreadable brain.json as not configured instead of failing', async () => {
      const s = setup();
      mkdirSync(join(s.secretsDir, VAULT), { recursive: true });
      writeFileSync(join(s.secretsDir, VAULT, 'brain.json'), '{not json');
      const res = await s.app.inject({ method: 'GET', url: `/vaults/${VAULT}/agent-model`, headers: { authorization: `Bearer ${s.owner}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false, kind: null });
    });

    describe('legacy files in the secrets root', () => {
      const legacy = (dir: string) => {
        writeFileSync(join(dir, 'brain.json'), '{"provider":"anthropic","model":"m"}\n', { mode: 0o600 });
        writeFileSync(join(dir, 'brain.secret'), 'sk-ant-api03-legacy\n', { mode: 0o600 });
      };
      const build = (secondVault: boolean, seed: (dir: string) => void) => {
        const dir = makeTempDir('havemind-agent-legacy-');
        seed(dir);
        const logs = collectLogs();
        return { logs, ...setup({ secondVault, secretsDir: dir, loggerStream: logs.writer }) };
      };

      it('moves them into the only vault', () => {
        const s = build(false, legacy);
        expect(existsSync(join(s.secretsDir, 'brain.json'))).toBe(false);
        expect(existsSync(join(s.secretsDir, 'brain.secret'))).toBe(false);
        expect(JSON.parse(readFileSync(join(s.secretsDir, VAULT, 'brain.json'), 'utf8'))).toEqual({ provider: 'anthropic', model: 'm' });
        expect(readFileSync(join(s.secretsDir, VAULT, 'brain.secret'), 'utf8')).toBe('sk-ant-api03-legacy\n');
        expect(statSync(join(s.secretsDir, VAULT, 'brain.secret')).mode & 0o777).toBe(0o600);
      });

      it("translates plan 015's model.oauth and model.key", () => {
        const oauth = build(false, (dir) => writeFileSync(join(dir, 'model.oauth'), 'sk-ant-oat01-old\n', { mode: 0o600 }));
        expect(JSON.parse(readFileSync(join(oauth.secretsDir, VAULT, 'brain.json'), 'utf8'))).toEqual({ provider: 'claude-code' });
        expect(readFileSync(join(oauth.secretsDir, VAULT, 'brain.secret'), 'utf8')).toBe('sk-ant-oat01-old\n');
        expect(existsSync(join(oauth.secretsDir, 'model.oauth'))).toBe(false);
        const key = build(false, (dir) => writeFileSync(join(dir, 'model.key'), 'sk-ant-api03-old\n', { mode: 0o600 }));
        expect(JSON.parse(readFileSync(join(key.secretsDir, VAULT, 'brain.json'), 'utf8'))).toEqual({ provider: 'anthropic' });
        expect(existsSync(join(key.secretsDir, 'model.key'))).toBe(false);
      });

      it('leaves them alone with a warning when there are several vaults, and never reads them', async () => {
        const s = build(true, legacy);
        expect(existsSync(join(s.secretsDir, 'brain.json'))).toBe(true);
        expect(existsSync(join(s.secretsDir, VAULT, 'brain.json'))).toBe(false);
        expect(await kind(s, s.owner, VAULT)).toEqual({ configured: false, kind: null });
        const log = s.logs.read();
        expect(log).toContain('legacy agent brain files');
        expect(log).not.toContain('sk-ant');
      });
    });
  });

  describe('a claim that fails', () => {
    const failing = (s: Setup, error: Error) =>
      new AgentEnrollmentService(s.database, {
        createInvitation: () => {
          throw error;
        },
      } as unknown as InvitationService);
    const droppedAt = (s: Setup) =>
      (s.database.prepare('SELECT dropped_at AS d, dropped_reason AS r FROM agent_enrollments').get() as { d: string | null; r: string | null });
    const input = () => ({ initialRefreshToken: generateRefreshToken(), redemptionId: '90000000-0000-4000-8000-00000000c101' });

    it('keeps the enrollment when the failure may pass (a busy database)', async () => {
      const s = setup();
      await enroll(s, s.owner, 'Retry me');
      expect(() => failing(s, new Error('SQLITE_BUSY')).claim(input())).toThrow('SQLITE_BUSY');
      expect(droppedAt(s)).toEqual({ d: null, r: null });
      expect(() => failing(s, new InvitationError('INVITATION_EXPIRED')).claim(input())).toThrow(InvitationError);
      expect(droppedAt(s)).toEqual({ d: null, r: null });
    });

    it('drops the enrollment when it can never succeed', async () => {
      const s = setup();
      await enroll(s, s.owner, 'Orphan');
      expect(failing(s, new InvitationError('NOT_AUTHORIZED')).claim(input())).toBeNull();
      expect(droppedAt(s)).toEqual({ d: expect.any(String), r: 'NOT_AUTHORIZED' });
    });
  });
});
