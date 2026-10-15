import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeCodeOneShot, createCliOneShot, createOpenAiCompatibleOneShot } from './claude-code';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `claude` that records how it was called and answers like Claude Code. */
function fakeClaude(answer: string, exitCode = 0): {
  bin: string;
  seen: () => { args: string[]; token: string; apiKey: string; stdin: string; cursorKey: string; codexAuth: string; codexAuthMode: number };
} {
  const dir = mkdtempSync(join(tmpdir(), 'hm-fake-claude-'));
  dirs.push(dir);
  const log = join(dir, 'seen.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const fs = process.getBuiltinModule('fs');
  const args = process.argv.slice(2);
  const home = process.env.CODEX_HOME;
  const auth = home ? home + '/auth.json' : '';
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
    args, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || '', apiKey: process.env.ANTHROPIC_API_KEY || '', stdin,
    serviceToken: process.env.HAVEMIND_AGENT_SERVICE_TOKEN || '',
    cursorKey: process.env.CURSOR_API_KEY || '',
    codexAuth: auth && fs.existsSync(auth) ? fs.readFileSync(auth, 'utf8') : '',
    codexAuthMode: auth && fs.existsSync(auth) ? fs.statSync(auth).mode & 0o777 : 0 }));
  const o = args.indexOf('-o');
  if (o !== -1) fs.writeFileSync(args[o + 1], ${JSON.stringify(answer)});
  else process.stdout.write(${JSON.stringify(answer)});
  process.exit(${exitCode});
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, seen: () => JSON.parse(readFileSync(log, 'utf8')) };
}

describe('thinking with Claude Code (plan 016)', () => {
  it('asks once with no tools, our system prompt, and the token only in its environment', async () => {
    const claude = fakeClaude(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"writes":[]}' }));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-leak';
    process.env.HAVEMIND_AGENT_SERVICE_TOKEN = 'hm_svc_should-not-leak';
    try {
      const ask = createClaudeCodeOneShot({ bin: claude.bin, oauthToken: 'sk-ant-oat01-secret' });
      expect(await ask('You are an agent.', 'the notes')).toBe('{"writes":[]}');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.HAVEMIND_AGENT_SERVICE_TOKEN;
    }
    const seen = claude.seen();
    expect(seen.args).toEqual(expect.arrayContaining(['-p', '--tools', '', '--no-session-persistence', '--system-prompt', 'You are an agent.']));
    expect(seen.args.join(' ')).not.toContain('sk-ant-oat01');
    expect(seen.token).toBe('sk-ant-oat01-secret');
    expect(seen.apiKey).toBe('');
    expect((seen as { serviceToken?: string }).serviceToken).toBe('');
    expect(seen.stdin).toBe('the notes');
  });

  it('turns a failure into a plain error that never repeats the notes', async () => {
    const failing = fakeClaude(JSON.stringify({ subtype: 'error_during_execution', is_error: true, result: 'secret note text' }));
    await expect(createClaudeCodeOneShot({ bin: failing.bin })('s', 'p')).rejects.toThrow(/error_during_execution/u);
    await expect(createClaudeCodeOneShot({ bin: failing.bin })('s', 'p')).rejects.not.toThrow(/secret note text/u);
    const crashed = fakeClaude('', 3);
    await expect(createClaudeCodeOneShot({ bin: crashed.bin })('s', 'p')).rejects.toThrow(/code 3/u);
    await expect(createClaudeCodeOneShot({ bin: '/nonexistent/claude' })('s', 'p')).rejects.toThrow(/could not start/u);
  });

  it('asks Codex read-only, its ChatGPT login in a private 0600 auth.json', async () => {
    const codex = fakeClaude('{"writes":[]}');
    const ask = createCliOneShot('codex', { bin: codex.bin, secret: '{"tokens":"x"}', model: 'gpt-5-codex' });
    expect(await ask('System.', 'Notes.')).toBe('{"writes":[]}');
    const seen = codex.seen();
    expect(seen.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--ephemeral', '-m', 'gpt-5-codex', '-']));
    expect(seen.codexAuth).toBe('{"tokens":"x"}');
    expect(seen.codexAuthMode).toBe(0o600);
    expect(seen.stdin).toBe('System.\n\nNotes.');
  });

  it('asks Cursor Agent in its read-only mode, the key only in its environment', async () => {
    const cursor = fakeClaude(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    expect(await createCliOneShot('cursor', { bin: cursor.bin, secret: 'crsr_key' })('S', 'P')).toBe('ok');
    const seen = cursor.seen();
    expect(seen.args).toEqual(['-p', '--output-format', 'json', '--trust', '--mode', 'ask']);
    expect(seen.cursorKey).toBe('crsr_key');
  });

  it('asks any OpenAI-compatible API (OpenRouter, Gemini, Ollama...)', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const ask = createOpenAiCompatibleOneShot({ baseUrl: 'https://openrouter.ai/api/v1/', model: 'google/gemini-2.5-pro', apiKey: 'sk-or-1' });
      expect(await ask('S', 'P')).toBe('answer');
      expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(calls[0]?.auth).toBe('Bearer sk-or-1');
      expect(calls[0]?.body).toMatchObject({ model: 'google/gemini-2.5-pro', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }] });
      await createOpenAiCompatibleOneShot({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' })('S', 'P');
      expect(calls[1]?.auth).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** A stand-in CLI that runs `body` as a node script. */
function scriptBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hm-fake-cli-'));
  dirs.push(dir);
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('a misbehaving CLI (plan 018 item 12)', () => {
  it('reports a fixed message when its output is not JSON, never the output', async () => {
    const bin = scriptBin(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('SECRET-NOTE-TEXT not json'); });`);
    const failure = await createClaudeCodeOneShot({ bin })('s', 'p').then(() => '', (error: Error) => error.message);
    expect(failure).not.toBe('');
    expect(failure).not.toContain('SECRET');
  });

  it('survives a CLI that exits without reading its input (EPIPE)', async () => {
    const bin = scriptBin('process.exit(1);');
    await expect(createClaudeCodeOneShot({ bin })('s', 'x'.repeat(4_000_000))).rejects.toThrow(/stopped with code 1|answered/u);
  });

  it('stops a CLI that prints without end', async () => {
    const bin = scriptBin(`const chunk = 'y'.repeat(65536); const tick = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', tick); }; tick();`);
    await expect(createClaudeCodeOneShot({ bin, timeoutMs: 20_000 })('s', 'p')).rejects.toThrow(/too much/u);
  }, 30_000);

  it('kills the whole process group on timeout, not just the CLI', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hm-pid-')), 'child.pid');
    dirs.push(join(pidFile, '..'));
    const bin = scriptBin(
      `const { spawn } = process.getBuiltinModule('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => {}, 60000);`,
    );
    await expect(createClaudeCodeOneShot({ bin, timeoutMs: 700 })('s', 'p')).rejects.toThrow(/stopped|timed out/u);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, 'SIGKILL');
    expect(alive).toBe(false);
  }, 15_000);
});
