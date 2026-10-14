/**
 * Agents that think with a coding CLI the owner already pays for (plan 016):
 * Claude Code, Codex or Cursor Agent, each through its own headless mode and
 * its own login, plus any OpenAI-compatible API (OpenAI, OpenRouter, Gemini,
 * a local Ollama...).
 *
 * One call per run: read-only or no tools, an empty working folder, no saved
 * session. On the server the login is a secret the owner gave once (a Claude
 * `setup-token`, a Codex `auth.json`, a Cursor API key); on the owner's
 * computer it is the CLI they are already signed in to. Secrets reach the child
 * through its environment or a 0600 file in its private folder, never its
 * command line, and an error never repeats the notes.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One question, one answer (the model's text). */
export type OneShotPort = (system: string, prompt: string) => Promise<string>;

export type CliProvider = 'claude-code' | 'codex' | 'cursor';

export interface CliOptions {
  /** The CLI on PATH unless given. */
  readonly bin?: string;
  /** The server-side login; absent on a computer already signed in. */
  readonly secret?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ClaudeCodeError extends Error {
  override readonly name = 'ClaudeCodeError';
}

const NAMES: Readonly<Record<CliProvider, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent' };

function run(name: string, bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, stdin: string, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ClaudeCodeError(`${name} could not start (${(error as NodeJS.ErrnoException).code ?? 'error'}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ClaudeCodeError(`${name} stopped with code ${code ?? 'killed'}.`));
    });
    child.stdin.end(stdin);
  });
}

/** Claude Code and Cursor Agent answer `--output-format json` the same way. */
function resultText(name: string, stdout: string): string {
  const result = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; subtype?: unknown };
  if (result.is_error === true || typeof result.result !== 'string') {
    // The subtype only: the text could echo the notes.
    throw new ClaudeCodeError(`${name} answered with an error (${String(result.subtype ?? 'unknown')}).`);
  }
  return result.result;
}

export function createCliOneShot(provider: CliProvider, options: CliOptions = {}): OneShotPort {
  const name = NAMES[provider];
  return async (system, prompt) => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'havemind-agent-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never let a stray API key in the environment win over the chosen login.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const model = options.model;
    try {
      if (provider === 'claude-code') {
        if (options.secret !== undefined) {
          env.CLAUDE_CODE_OAUTH_TOKEN = options.secret;
          env.HOME = cwd;
        }
        const args = [
          '-p', '--output-format', 'json', '--tools', '', '--no-session-persistence',
          '--setting-sources', '', '--system-prompt', system,
          ...(model === undefined ? [] : ['--model', model]),
        ];
        return resultText(name, await run(name, options.bin ?? 'claude', args, env, cwd, prompt, timeout));
      }
      if (provider === 'cursor') {
        if (options.secret !== undefined) env.CURSOR_API_KEY = options.secret;
        const args = ['-p', '--output-format', 'json', '--trust', '--mode', 'ask', ...(model === undefined ? [] : ['--model', model])];
        return resultText(name, await run(name, options.bin ?? 'cursor-agent', args, env, cwd, `${system}\n\n${prompt}`, timeout));
      }
      // Codex: the login is its auth.json, in a private CODEX_HOME on the server.
      if (options.secret !== undefined) {
        const home = join(cwd, '.codex');
        await fs.mkdir(home, { mode: 0o700 });
        await fs.writeFile(join(home, 'auth.json'), options.secret, { mode: 0o600 });
        env.CODEX_HOME = home;
      }
      const answerFile = join(cwd, 'answer.txt');
      const args = [
        'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
        '--ignore-user-config', '--ignore-rules', '-o', answerFile,
        ...(model === undefined ? [] : ['-m', model]),
        '-',
      ];
      await run(name, options.bin ?? 'codex', args, env, cwd, `${system}\n\n${prompt}`, timeout);
      return await fs.readFile(answerFile, 'utf8');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}

/** Kept for callers from plan 016's first step. */
export function createClaudeCodeOneShot(options: CliOptions & { oauthToken?: string } = {}): OneShotPort {
  const { oauthToken, ...rest } = options;
  return createCliOneShot('claude-code', { ...rest, ...(oauthToken === undefined ? {} : { secret: oauthToken }) });
}

/** Any OpenAI-compatible chat API: OpenAI, OpenRouter, Gemini, Ollama, Groq, Mistral... */
export function createOpenAiCompatibleOneShot(options: { baseUrl: string; model: string; apiKey?: string }): OneShotPort {
  return async (system, prompt) => {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey === undefined || options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
    const text = body?.choices?.[0]?.message?.content;
    if (!response.ok || typeof text !== 'string') throw new ClaudeCodeError(`The model API answered ${response.status}.`);
    return text;
  };
}
