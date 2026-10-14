import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeCodeOneShot } from './claude-code';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `claude` that records how it was called and answers like Claude Code. */
function fakeClaude(answer: string, exitCode = 0): { bin: string; seen: () => { args: string[]; token: string; apiKey: string; stdin: string } } {
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
  process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({
    args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN || '', apiKey: process.env.ANTHROPIC_API_KEY || '', stdin }));
  process.stdout.write(${JSON.stringify(answer)});
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
    try {
      const ask = createClaudeCodeOneShot({ bin: claude.bin, oauthToken: 'sk-ant-oat01-secret' });
      expect(await ask('You are an agent.', 'the notes')).toBe('{"writes":[]}');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const seen = claude.seen();
    expect(seen.args).toEqual(expect.arrayContaining(['-p', '--tools', '', '--no-session-persistence', '--system-prompt', 'You are an agent.']));
    expect(seen.args.join(' ')).not.toContain('sk-ant-oat01');
    expect(seen.token).toBe('sk-ant-oat01-secret');
    expect(seen.apiKey).toBe('');
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
});
