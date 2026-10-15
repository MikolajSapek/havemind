import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HeadlessAgent } from './agent';
import { brainOrNull, oneLine, readMemory, renameNoClobber, writeMemory } from './cli';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-cli-'));
  dirs.push(dir);
  return dir;
};

const agentAt = (latest: number): Pick<HeadlessAgent, 'sync' | 'latestSequence'> => ({
  sync: async () => ({}) as never,
  latestSequence: async () => latest,
});

describe('runner.json (plan 018 item 8)', () => {
  it('is written whole through a 0600 temp file, leaving nothing else behind', async () => {
    const stateDir = tempDir();
    await writeMemory({ stateDir, vaultDir: '' }, { lastRunAt: 5, lastSequence: 9 });
    expect(JSON.parse(readFileSync(join(stateDir, 'runner.json'), 'utf8'))).toEqual({ lastRunAt: 5, lastSequence: 9 });
    expect(statSync(join(stateDir, 'runner.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(stateDir)).toEqual(['runner.json']);
  });

  it('is read back as saved', async () => {
    const stateDir = tempDir();
    await writeMemory({ stateDir, vaultDir: '' }, { lastRunAt: 5, lastSequence: 9, day: '2026-10-15', runsToday: 2 });
    expect(await readMemory({ stateDir, vaultDir: '' }, agentAt(99))).toEqual({
      lastRunAt: 5,
      lastSequence: 9,
      day: '2026-10-15',
      runsToday: 2,
    });
  });

  it('starts from the newest sequence when the file is absent or corrupt, never from 0', async () => {
    const stateDir = tempDir();
    expect(await readMemory({ stateDir, vaultDir: '' }, agentAt(42))).toEqual({ lastRunAt: 0, lastSequence: 42 });
    writeFileSync(join(stateDir, 'runner.json'), '{"lastRunAt": 1, "lastSeq');
    expect(await readMemory({ stateDir, vaultDir: '' }, agentAt(42))).toEqual({ lastRunAt: 0, lastSequence: 42 });
    writeFileSync(join(stateDir, 'runner.json'), '{"lastRunAt":"x"}');
    expect(await readMemory({ stateDir, vaultDir: '' }, agentAt(42))).toEqual({ lastRunAt: 0, lastSequence: 42 });
  });
});

describe('log lines (plan 018 item 12b)', () => {
  it('keeps one line of at most 120 characters', () => {
    expect(oneLine(`first\nsecond\r\nthird ${'x'.repeat(300)}`).length).toBeLessThanOrEqual(120);
    expect(oneLine('a\nb')).toBe('a b');
  });
});

describe('the brain is per vault (plan 018 item 13)', () => {
  function secrets(): string {
    const dir = tempDir();
    vi.stubEnv('HAVEMIND_AGENT_SECRETS_DIR', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    return dir;
  }
  const save = (dir: string, vaultId: string, brain: unknown, secret: string) => {
    mkdirSync(join(dir, vaultId), { recursive: true });
    writeFileSync(join(dir, vaultId, 'brain.json'), JSON.stringify(brain));
    writeFileSync(join(dir, vaultId, 'brain.secret'), secret);
  };

  it('reads the brain of the agent\'s own vault only', async () => {
    const dir = secrets();
    save(dir, 'vault-a', { provider: 'anthropic' }, 'sk-ant-a');
    expect((await brainOrNull('vault-a'))?.kind).toBe('tools');
    expect(await brainOrNull('vault-b')).toBeNull();
  });

  it('never falls back to the files at the root of the secrets folder', async () => {
    const dir = secrets();
    writeFileSync(join(dir, 'brain.json'), '{"provider":"anthropic"}');
    writeFileSync(join(dir, 'brain.secret'), 'sk-ant-root');
    writeFileSync(join(dir, 'model.key'), 'sk-ant-root');
    writeFileSync(join(dir, 'model.oauth'), 'oauth-root');
    expect(await brainOrNull('vault-a')).toBeNull();
  });

  it('still takes the environment key when the vault has no brain', async () => {
    secrets();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
    expect((await brainOrNull('vault-a'))?.kind).toBe('tools');
  });

  it('refuses a vault id that would leave its folder', async () => {
    const dir = secrets();
    save(dir, 'vault-a', { provider: 'anthropic' }, 'sk-ant-a');
    expect(await brainOrNull('../' + 'vault-a')).toBeNull();
    expect(await brainOrNull('')).toBeNull();
  });

  it('treats a Claude Code install that fails as no brain this tick (plan 018 item 12d)', async () => {
    const dir = secrets();
    save(dir, 'vault-a', { provider: 'claude-code' }, 'oauth-a');
    vi.stubEnv('HAVEMIND_AGENTS_DIR', tempDir());
    vi.stubEnv('PATH', '');
    await expect(brainOrNull('vault-a')).resolves.toBeNull();
  });
});

describe('joining an agent folder (plan 018 item 11)', () => {
  it('never moves a joining folder onto one that exists', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'joining-1'));
    mkdirSync(join(root, 'mail-bot'));
    writeFileSync(join(root, 'mail-bot', 'keep.txt'), 'first agent');
    await expect(renameNoClobber(join(root, 'joining-1'), join(root, 'mail-bot'))).rejects.toThrow(/already exists/u);
    expect(readFileSync(join(root, 'mail-bot', 'keep.txt'), 'utf8')).toBe('first agent');
    await renameNoClobber(join(root, 'joining-1'), join(root, 'fresh'));
    expect(readdirSync(root).sort()).toEqual(['fresh', 'mail-bot']);
  });
});
