/**
 * `havemind-agent`, the command an agent runs as (plan 014).
 *
 *   havemind-agent join            paste the owner's invitation; prints six digits
 *   havemind-agent run             every joined agent, in the background, forever
 *   havemind-agent once <name>     one run now (--force ignores the schedule)
 *   havemind-agent mcp <name>      serve one agent to Claude Code over MCP (stdio)
 *   havemind-agent list            the joined agents
 *
 * Agents live in $HAVEMIND_AGENTS_DIR (default ~/.havemind-agents), one folder
 * each with `state/` (tokens, 0600) and `vault/`. The model key is read from
 * ANTHROPIC_API_KEY and never written anywhere. The invitation is read from
 * stdin, never from the command line, which shows up in `ps` and shell history.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { finishJoin, HeadlessAgent, startJoin, type AgentPaths } from './agent';
import { claimNextAgent, folderFor } from './claim';
import { createFetchRequestUrl } from './fetch-request-url';
import { serveMcp } from './mcp';
import { AgentPool } from './pool';
import { runAgentOnce, type AgentBrain, type RunMemory } from './runner';
import { brainFrom, parseBrain } from './brains';
import { ensureClaudeCode } from './tools';

const APPROVAL_POLL_MS = 3_000;
const APPROVAL_WAIT_MS = 15 * 60_000;
const RUN_LOOP_MS = 60_000;

const agentsDir = (): string => process.env.HAVEMIND_AGENTS_DIR ?? join(homedir(), '.havemind-agents');
const serverUrl = (): string | undefined => process.env.HAVEMIND_AGENT_SERVER_URL || undefined;
const pathsFor = (folder: string): AgentPaths => ({
  stateDir: join(agentsDir(), folder, 'state'),
  vaultDir: join(agentsDir(), folder, 'vault'),
  requestUrl: createFetchRequestUrl(serverUrl()),
});
const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


async function readInvitation(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const line = await rl.question('Paste the invitation from Havemind (Add agent), then Enter: ');
    rl.close();
    return line.trim();
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk.toString();
  return text.trim();
}

/** One process per agent at a time: a runner and an MCP session never share state. */
async function lock(paths: AgentPaths): Promise<(() => Promise<void>) | null> {
  const file = join(paths.stateDir, 'lock');
  try {
    await fs.writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    const pid = Number(await fs.readFile(file, 'utf8').catch(() => '0'));
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        return null;
      }
    } catch {
      // The process that held it is gone: take the lock over.
    }
    await fs.writeFile(file, String(process.pid), { mode: 0o600 });
  }
  return () => fs.rm(file, { force: true });
}

async function joinCommand(): Promise<void> {
  const envelope = await readInvitation();
  const temp = `joining-${randomBytes(4).toString('hex')}`;
  const paths = pathsFor(temp);
  const code = await startJoin(paths, envelope, `havemind-agent on ${hostname()}`);
  say(`\nIn Havemind, approve this agent with: ${code.slice(0, 3)} ${code.slice(3)}\nWaiting for the approval...`);
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  while (Date.now() < deadline) {
    const identity = await finishJoin(paths);
    if (identity !== null) {
      const folder = folderFor(identity.name);
      await fs.rename(join(agentsDir(), temp), join(agentsDir(), folder));
      const agent = await HeadlessAgent.open(pathsFor(folder));
      await agent.sync();
      // Its runs start from now: what people wrote before it joined is not news.
      await writeMemory(pathsFor(folder), { lastRunAt: 0, lastSequence: await agent.latestSequence() });
      say(`Joined "${identity.vaultName}" as ${identity.name}. Its task note: Havemind/Agents/${identity.name}.md`);
      return;
    }
    await sleep(APPROVAL_POLL_MS);
  }
  throw new Error('Not approved within 15 minutes. Make a new invitation and run join again.');
}

async function agentFolders(): Promise<string[]> {
  await fs.mkdir(agentsDir(), { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(agentsDir(), { withFileTypes: true });
  // Dot-folders hold the service's own tools (.tools), never an agent.
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('joining-') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function readMemory(paths: AgentPaths): Promise<RunMemory> {
  try {
    return JSON.parse(await fs.readFile(join(paths.stateDir, 'runner.json'), 'utf8')) as RunMemory;
  } catch {
    return { lastRunAt: 0, lastSequence: 0 };
  }
}

/** The model key: the environment, or the file the owner set from Havemind (plan 015). */
async function modelKey(): Promise<string | null> {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  if (fromEnv !== '') return fromEnv;
  const dir = process.env.HAVEMIND_AGENT_SECRETS_DIR;
  if (dir === undefined || dir === '') return null;
  const fromFile = (await fs.readFile(join(dir, 'model.key'), 'utf8').catch(() => '')).trim();
  return fromFile === '' ? null : fromFile;
}

async function readSecretFile(name: string): Promise<string | null> {
  const dir = process.env.HAVEMIND_AGENT_SECRETS_DIR;
  if (dir === undefined || dir === '') return null;
  const text = (await fs.readFile(join(dir, name), 'utf8').catch(() => '')).trim();
  return text === '' ? null : text;
}

/**
 * How the agents think (plan 016): the brain the owner chose in Havemind
 * (brain.json and its secret), else plan 015's single login, else the
 * environment; null to sync and wait.
 */
async function brainOrNull(): Promise<AgentBrain | null> {
  const saved = parseBrain(await readSecretFile('brain.json'));
  const claude = async () => ({ bin: await ensureClaudeCode(agentsDir()) });
  if (saved !== null) {
    return brainFrom(saved, await readSecretFile('brain.secret'), saved.provider === 'claude-code' ? await claude() : {});
  }
  const token = (await readSecretFile('model.oauth')) ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null);
  if (token !== null) return brainFrom({ provider: 'claude-code' }, token, await claude());
  const apiKey = await modelKey();
  return apiKey === null ? null : brainFrom({ provider: 'anthropic', ...(process.env.HAVEMIND_AGENT_MODEL ? { model: process.env.HAVEMIND_AGENT_MODEL } : {}) }, apiKey);
}

async function brainOrThrow(): Promise<AgentBrain> {
  const brain = await brainOrNull();
  if (brain === null) throw new Error('No Claude login yet: add one in Havemind (Add agent).');
  return brain;
}

/** Agents the owner added in Havemind, claimed with the server's service token (plan 015). */
async function claimNew(): Promise<void> {
  const serviceToken = process.env.HAVEMIND_AGENT_SERVICE_TOKEN ?? '';
  const apiBaseUrl = process.env.HAVEMIND_API_BASE_URL ?? '';
  if (serviceToken === '' || apiBaseUrl === '') return;
  for (;;) {
    const folder = await claimNextAgent({ agentsDir: agentsDir(), apiBaseUrl, serviceToken, requestUrl: createFetchRequestUrl(serverUrl()) });
    if (folder === null) return;
    const agent = await HeadlessAgent.open(pathsFor(folder));
    await agent.sync();
    await writeMemory(pathsFor(folder), { lastRunAt: 0, lastSequence: await agent.latestSequence() });
    say(`${agent.identity.name}: added from Havemind.`);
  }
}

async function writeMemory(paths: AgentPaths, memory: RunMemory): Promise<void> {
  await fs.writeFile(join(paths.stateDir, 'runner.json'), JSON.stringify(memory), { mode: 0o600 });
}

async function openLocked(folder: string): Promise<{ agent: HeadlessAgent; release: () => Promise<void> } | null> {
  const paths = pathsFor(folder);
  const release = await lock(paths);
  if (release === null) return null;
  try {
    return { agent: await HeadlessAgent.open(paths), release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function runWith(agent: HeadlessAgent, folder: string, force: boolean): Promise<void> {
  const paths = pathsFor(folder);
  const outcome = await runAgentOnce({
    agent,
    brain: await brainOrThrow(),
    memory: await readMemory(paths),
    now: Date.now(),
    force,
  });
  await writeMemory(paths, outcome.memory);
  if (outcome.kind === 'done') {
    say(`${agent.identity.name}: ${outcome.writes.length} note(s) changed. ${outcome.summary}`);
  } else if (outcome.kind === 'failed') {
    say(`${agent.identity.name}: failed, will try again after its interval. ${outcome.error}`);
  } else if (force || outcome.kind === 'no-task' || outcome.kind === 'day-cap') {
    say(`${agent.identity.name}: ${outcome.kind}.`);
  }
}

async function runOne(folder: string, force: boolean): Promise<void> {
  const opened = await openLocked(folder);
  if (opened === null) {
    say(`${folder}: busy (an MCP session or another runner holds it), skipped.`);
    return;
  }
  try {
    await runWith(opened.agent, folder, force);
  } finally {
    await opened.release();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const name = rest.find((arg) => !arg.startsWith('--'));
  switch (command) {
    case 'join':
      return joinCommand();
    case 'list':
      for (const folder of await agentFolders()) process.stdout.write(`${folder}\n`);
      return;
    case 'once':
      if (name === undefined) throw new Error('Usage: havemind-agent once <name> [--force]');
      return runOne(folderFor(name), rest.includes('--force'));
    case 'run':
      say('Agents service started; checking every minute.');
      {
        // Each agent stays open, and locked, for the life of this process.
        // Without a model key it still adds and syncs agents, and waits.
        const pool = new AgentPool(openLocked);
        let toldNoKey = false;
        for (;;) {
          await claimNew().catch((error: unknown) => {
            say(`Adding agents: ${error instanceof Error ? error.message : 'failed'}`);
          });
          const haveKey = (await brainOrNull()) !== null;
          if (!haveKey && !toldNoKey) say('No Claude login yet; agents sync but do not run until one is added in Havemind.');
          toldNoKey = !haveKey;
          for (const folder of await agentFolders()) {
            try {
              const agent = await pool.get(folder);
              if (agent === null) continue;
              if (haveKey) await runWith(agent, folder, false);
              else await agent.sync();
            } catch (error) {
              say(`${folder}: ${error instanceof Error ? error.message : 'failed'}`);
              await pool.drop(folder);
            }
          }
          await sleep(RUN_LOOP_MS);
        }
      }
    case 'mcp': {
      if (name === undefined) throw new Error('Usage: havemind-agent mcp <name>');
      const paths = pathsFor(folderFor(name));
      const release = await lock(paths);
      if (release === null) throw new Error(`${name} is busy in another process.`);
      try {
        const agent = await HeadlessAgent.open(paths);
        await agent.sync();
        await serveMcp(agent, process.stdin, process.stdout);
      } finally {
        await release();
      }
      return;
    }
    default:
      say('Usage: havemind-agent join | run | once <name> [--force] | mcp <name> | list');
      process.exitCode = command === undefined ? 0 : 2;
  }
}

if (process.argv[1] !== undefined && /havemind-agent(\.m?js)?$/u.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    say(`havemind-agent: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  });
}
