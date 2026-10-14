/**
 * Plan 014: an AI agent joins a vault as its own member and syncs it into a
 * folder on disk, with no Obsidian at all.
 *
 * Real in-process server, real client code (`apps/obsidian-plugin/src/headless`):
 * the owner invites an agent, the agent redeems and shows six digits, the
 * owner approves them, the agent writes a note and syncs. A second agent then
 * receives that note into its own folder. The server records the note under
 * the first agent's own membership, marked as an agent.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../apps/server/src/app.js';
import { InvitationService } from '../../apps/server/src/auth/invitations.js';
import { SessionRepository } from '../../apps/server/src/auth/session-repository.js';
import { createLocalOwnerSetupContext, OwnerSetupService } from '../../apps/server/src/auth/setup.js';
import { generateRefreshToken } from '../../apps/server/src/auth/tokens.js';
import { BlobStore } from '../../apps/server/src/blob-store.js';
import { parseServerConfig } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/db.js';
import { runMigrations } from '../../apps/server/src/migrations.js';
import { RevisionRepository } from '../../apps/server/src/revision-repository.js';

import { HeadlessAgent, startJoin, type AgentPaths } from '../../apps/obsidian-plugin/src/headless/agent.js';
import type { ModelPort, ModelRequest } from '../../apps/obsidian-plugin/src/headless/model.js';
import { runAgentOnce } from '../../apps/obsidian-plugin/src/headless/runner.js';
import { approveRedeemedDevice } from '../../apps/obsidian-plugin/src/runtime/approve-device.js';
import { createVaultInvitation } from '../../apps/obsidian-plugin/src/runtime/create-invitation.js';
import type { RequestUrlFn } from '../../apps/obsidian-plugin/src/runtime/sync-transport.js';

const ORIGIN = 'https://sync.example.test';
const dirs: string[] = [];
const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `havemind-agent-${label}-`));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function startServer() {
  const dataDir = tempDir('server');
  const database = openDatabase(join(dataDir, 'havemind.sqlite'));
  runMigrations(database);
  const setup = new OwnerSetupService(database);
  const init = setup.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Alice',
    vaultDisplayName: 'Shared Vault',
  });
  const pair = setup.pairOwnerDevice({
    deviceDisplayName: 'Alice Laptop',
    deviceId: randomUUID(),
    initialRefreshToken: generateRefreshToken(),
    pairingToken: init.pairingToken,
    publicKey: Buffer.alloc(32, 0x11),
  });
  const vaultId = (database.prepare('SELECT id FROM vaults LIMIT 1').get() as { id: string }).id;
  const blobStore = new BlobStore(join(dataDir, 'blobs'));
  const app = buildApp({
    auth: {
      clientKey: () => 'test',
      database,
      sessions: new SessionRepository(database),
      invitations: new InvitationService(database),
      sync: { blobStore, database, revisions: new RevisionRepository(database, blobStore) },
    },
    config: parseServerConfig({ HAVEMIND_API_BASE_URL: ORIGIN, HAVEMIND_SERVER_NAME: 'Test' }),
    loggerStream: new Writable({ write: (_c, _e, done) => done() }),
  });
  const requestUrl: RequestUrlFn = async (options) => {
    const url = new URL(options.url);
    const response = await app.inject({
      method: options.method as never,
      url: `${url.pathname}${url.search}`,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { payload: options.body }),
    });
    let json: unknown;
    try {
      json = response.body.length > 0 ? JSON.parse(response.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, json, arrayBuffer: new Uint8Array(response.rawPayload).buffer };
  };
  return { app, database, requestUrl, vaultId, ownerToken: pair.accessToken };
}

type Server = ReturnType<typeof startServer>;

/** The owner invites a member by name; it joins with the owner's approval. */
async function addAgent(
  server: Server,
  name: string,
  kind: 'person' | 'agent' = 'agent',
): Promise<{ agent: HeadlessAgent; paths: AgentPaths }> {
  const owner = { requestUrl: server.requestUrl, apiBaseUrl: ORIGIN, vaultId: server.vaultId, getAccessToken: async () => server.ownerToken };
  const invitation = await createVaultInvitation({
    ...owner,
    serverOrigin: ORIGIN,
    intendedMemberDisplayName: name,
    intendedKind: kind,
  });
  const paths: AgentPaths = { stateDir: tempDir('state'), vaultDir: tempDir('vault'), requestUrl: server.requestUrl };
  const code = await startJoin(paths, invitation.envelope, `${name} on the server`);
  expect(code).toMatch(/^\d{6}$/u);
  await approveRedeemedDevice({ ...owner, invitationId: invitation.invitationId, verificationPhrase: code });
  const agent = await HeadlessAgent.open(paths);
  await agent.sync();
  return { agent, paths };
}

describe('headless agent (plan 014)', () => {
  it('joins as its own agent member, writes a note, and another agent receives it', async () => {
    const server = startServer();
    try {
      const { agent: sorter, paths } = await addAgent(server, 'Inbox sorter');
      expect(sorter.identity.name).toBe('Inbox sorter');

      await sorter.writeNote('Summaries/Today.md', '# Today\n\nThree notes filed.\n');
      await sorter.sync();

      const row = server.database
        .prepare(
          `SELECT m.kind AS kind, COUNT(r.membership_id) AS revisions
           FROM memberships m LEFT JOIN revisions r ON r.membership_id = m.id
           WHERE m.id = ? GROUP BY m.id`,
        )
        .get(sorter.identity.memberId) as { kind: string; revisions: number };
      expect(row).toEqual({ kind: 'agent', revisions: 1 });

      const { agent: gardener, paths: gardenerPaths } = await addAgent(server, 'Link gardener');
      await gardener.sync();
      expect(await gardener.readNote('Summaries/Today.md')).toBe('# Today\n\nThree notes filed.\n');
      expect(readFileSync(join(gardenerPaths.vaultDir, 'Summaries', 'Today.md'), 'utf8')).toContain('Three notes filed.');

      // A runner restarts often. Reopened from its files, an agent must find
      // nothing to send: no new revisions, no tombstones.
      const count = () => (server.database.prepare('SELECT COUNT(*) AS c FROM revisions').get() as { c: number }).c;
      const before = count();
      for (const reopenPaths of [paths, gardenerPaths]) {
        const reopened = await HeadlessAgent.open(reopenPaths);
        await reopened.sync();
        await reopened.sync();
      }
      expect(count()).toBe(before);

      // Tokens are on disk for the owner only.
      expect(statSync(join(paths.stateDir, 'secrets.json')).mode & 0o777).toBe(0o600);
    } finally {
      await server.app.close();
      server.database.close();
    }
  });

  it('does its task in the background when a person changes something, inside its folders only', async () => {
    const server = startServer();
    try {
      // The client is the same for a person and an agent; only the kind differs.
      const { agent: magda } = await addAgent(server, 'Magda', 'person');
      const { agent: sorter } = await addAgent(server, 'Inbox sorter');

      await magda.writeNote(
        'Havemind/Agents/Inbox sorter.md',
        '---\nmay_write: [Notes]\nevery: 1h\n---\nFile every note in Inbox/ under Notes/.\n',
      );
      await magda.writeNote('Inbox/idea.md', 'Buy a Raspberry Pi.\n');
      await magda.sync();

      const seen: ModelRequest[] = [];
      const model: ModelPort = async (request) => {
        seen.push(request);
        if (seen.length === 1) {
          return {
            stopReason: 'tool_use',
            content: [
              { type: 'tool_use', id: 't1', name: 'read_note', input: { path: 'Inbox/idea.md' } },
              { type: 'tool_use', id: 't2', name: 'write_note', input: { path: 'Notes/idea.md', content: 'Buy a Raspberry Pi.\n' } },
              // A note must never get the agent to widen its own scope.
              { type: 'tool_use', id: 't3', name: 'write_note', input: { path: 'Havemind/Agents/Inbox sorter.md', content: 'may_write: [""]' } },
            ],
          };
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Filed 1 note.' }] };
      };

      const first = await runAgentOnce({ agent: sorter, model, memory: { lastRunAt: 0, lastSequence: 0 }, now: 1_000 });
      expect(first.kind).toBe('done');
      if (first.kind !== 'done') return;
      expect(first.writes).toEqual(['Notes/idea.md']);
      expect(first.summary).toBe('Filed 1 note.');
      expect(seen[0]?.messages[0]?.content).toContain('Inbox/idea.md');
      expect(JSON.stringify(seen[1]?.messages)).toContain('may never write in Havemind/');

      await magda.sync();
      expect(await magda.readNote('Notes/idea.md')).toBe('Buy a Raspberry Pi.\n');
      expect(await magda.readNote('Havemind/Agents/Inbox sorter.md')).toContain('may_write: [Notes]');

      // Its own writes never wake it again, even when the schedule allows.
      const second = await runAgentOnce({ agent: sorter, model, memory: first.memory, now: 1_000 + 2 * 3_600_000 });
      expect(second.kind).toBe('nothing-new');
      // And before the schedule says so, it does not even look.
      const early = await runAgentOnce({ agent: sorter, model, memory: first.memory, now: 2_000 });
      expect(early.kind).toBe('not-due');
      expect(seen).toHaveLength(2);
    } finally {
      await server.app.close();
      server.database.close();
    }
  });
});
