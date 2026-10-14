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
import { createClaudeModel, DEFAULT_AGENT_MODEL } from './model';
import { serveMcp } from './mcp';
import { runAgentOnce, type RunMemory } from './runner';

const APPROVAL_POLL_MS = 3_000;
const APPROVAL_WAIT_MS = 15 * 60_000;
const RUN_LOOP_MS = 60_000;

const agentsDir = (): string => process.env.HAVEMIND_AGENTS_DIR ?? join(homedir(), '.havemind-agents');
const pathsFor = (folder: string): AgentPaths => ({
  stateDir: join(agentsDir(), folder, 'state'),
  vaultDir: join(agentsDir(), folder, 'vault'),
});
const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function folderFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'agent';
}

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
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('joining-')).map((e) => e.name).sort();
}

async function readMemory(paths: AgentPaths): Promise<RunMemory> {
  try {
    return JSON.parse(await fs.readFile(join(paths.stateDir, 'runner.json'), 'utf8')) as RunMemory;
  } catch {
    return { lastRunAt: 0, lastSequence: 0 };
  }
}

function modelFromEnvironment() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (apiKey === '') throw new Error('Set ANTHROPIC_API_KEY for the agents (in the server .env), then start again.');
  return createClaudeModel({ apiKey, model: process.env.HAVEMIND_AGENT_MODEL ?? DEFAULT_AGENT_MODEL });
}

async function runOne(folder: string, force: boolean): Promise<void> {
  const paths = pathsFor(folder);
  const release = await lock(paths);
  if (release === null) {
    say(`${folder}: busy (an MCP session or another runner holds it), skipped.`);
    return;
  }
  try {
    const agent = await HeadlessAgent.open(paths);
    const outcome = await runAgentOnce({
      agent,
      model: modelFromEnvironment(),
      memory: await readMemory(paths),
      now: Date.now(),
      force,
    });
    await fs.writeFile(join(paths.stateDir, 'runner.json'), JSON.stringify(outcome.memory), { mode: 0o600 });
    if (outcome.kind === 'done') {
      say(`${agent.identity.name}: ${outcome.writes.length} note(s) changed. ${outcome.summary}`);
    } else if (force || outcome.kind === 'no-task') {
      say(`${agent.identity.name}: ${outcome.kind}.`);
    }
  } finally {
    await release();
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
      modelFromEnvironment();
      say(`Running ${(await agentFolders()).length} agent(s); checking every minute.`);
      for (;;) {
        for (const folder of await agentFolders()) {
          await runOne(folder, false).catch((error: unknown) => {
            say(`${folder}: ${error instanceof Error ? error.message : 'failed'}`);
          });
        }
        await sleep(RUN_LOOP_MS);
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
