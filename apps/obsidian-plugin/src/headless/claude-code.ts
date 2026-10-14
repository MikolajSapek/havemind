/**
 * An agent that thinks with Claude Code (plan 016): the owner's Claude
 * subscription, through `claude -p`, instead of an API key.
 *
 * One call per run: no tools, an empty working folder, our own short system
 * prompt (Claude Code's default one is tens of thousands of tokens), no saved
 * session, no settings files. On the server the login is the token from
 * `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN); on the owner's computer it is
 * the Claude Code they are already signed in to. The token is passed in the
 * child's environment only, never on its command line.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One question, one answer (the model's text). */
export type OneShotPort = (system: string, prompt: string) => Promise<string>;

export interface ClaudeCodeOptions {
  /** `claude` on PATH unless given. */
  readonly bin?: string;
  /** From `claude setup-token`; absent on a computer already signed in. */
  readonly oauthToken?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ClaudeCodeError extends Error {
  override readonly name = 'ClaudeCodeError';
}

export function createClaudeCodeOneShot(options: ClaudeCodeOptions = {}): OneShotPort {
  return async (system, prompt) => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'havemind-agent-'));
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',
      '--no-session-persistence',
      '--setting-sources', '',
      '--system-prompt', system,
      ...(options.model === undefined ? [] : ['--model', options.model]),
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.oauthToken !== undefined) {
      env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
      // A server has no home of its own for Claude Code to write to.
      env.HOME = cwd;
    }
    // Never let an API key in the environment win over the chosen login.
    delete env.ANTHROPIC_API_KEY;
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(options.bin ?? 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.stderr.resume();
        const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(new ClaudeCodeError(`Claude Code could not start (${(error as NodeJS.ErrnoException).code ?? 'error'}).`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new ClaudeCodeError(`Claude Code stopped with code ${code ?? 'killed'}.`));
        });
        child.stdin.end(prompt);
      });
      const result = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; subtype?: unknown };
      if (result.is_error === true || typeof result.result !== 'string') {
        // The subtype only: the text could echo the notes.
        throw new ClaudeCodeError(`Claude Code answered with an error (${String(result.subtype ?? 'unknown')}).`);
      }
      return result.result;
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}
