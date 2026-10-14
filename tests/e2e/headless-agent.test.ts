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

/** The owner invites an agent by name; the agent joins with the owner's approval. */
async function addAgent(server: Server, name: string): Promise<{ agent: HeadlessAgent; paths: AgentPaths }> {
  const owner = { requestUrl: server.requestUrl, apiBaseUrl: ORIGIN, vaultId: server.vaultId, getAccessToken: async () => server.ownerToken };
  const invitation = await createVaultInvitation({
    ...owner,
    serverOrigin: ORIGIN,
    intendedMemberDisplayName: name,
    intendedKind: 'agent',
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
});
