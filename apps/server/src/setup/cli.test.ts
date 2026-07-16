import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerEnvironment } from '../config.js';
import { runCli } from './cli.js';
import { parsePairingToken } from '../auth/tokens.js';

const temporaryDirectories: string[] = [];

function makeDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function baseEnv(overrides: ServerEnvironment = {}): ServerEnvironment {
  return {
    HAVEMIND_API_BASE_URL: 'https://havemind.example.ts.net',
    ...overrides,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe('runCli dispatch', () => {
  it('prints usage when no command is given', () => {
    const result = runCli([], { env: baseEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: havemind');
  });

  it('prints usage for help', () => {
    const result = runCli(['help'], { env: baseEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Commands:');
  });

  it('rejects an unknown command with exit 1', () => {
    const result = runCli(['frobnicate'], { env: baseEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command: frobnicate');
  });
});

describe('generate-db-key', () => {
  it('prints a 256-bit hex key and its fingerprint', () => {
    const result = runCli(['generate-db-key'], { env: baseEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}\n/u);
    expect(result.stdout).toContain('256-bit key');
    expect(result.stdout).toContain('Fingerprint');
  });

  it('honours an injected random source', () => {
    const result = runCli(['generate-db-key'], {
      env: baseEnv(),
      randomBytesSource: () => Buffer.alloc(32, 0xcd),
    });
    expect(result.stdout.startsWith('cd'.repeat(32))).toBe(true);
  });
});

describe('doctor', () => {
  it('returns exit 0 with a text report by default', () => {
    const result = runCli(['doctor'], {
      env: baseEnv(),
      stat: () => ({ isDirectory: false, mode: 0o600, size: 64 }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Havemind doctor:');
  });

  it('emits JSON with --json', () => {
    const result = runCli(['doctor', '--json'], {
      env: baseEnv(),
      stat: () => ({ isDirectory: false, mode: 0o600, size: 64 }),
    });
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
  });

  it('returns exit 1 when a check fails', () => {
    const result = runCli(['doctor'], { env: {}, stat: () => null });
    expect(result.exitCode).toBe(1);
  });
});

describe('setup', () => {
  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], {
      env: baseEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('initialises the owner and prints a single-use pairing token', () => {
    const dataDir = makeDataDir();
    const result = runCli(
      ['setup', '--owner', 'Alice', '--vault', 'Notes'],
      { env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }) },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Instance owner initialised.');
    const match = result.stdout.match(/hm_pt_[A-Za-z0-9_-]{43}/u);
    expect(match).not.toBeNull();
    // The printed token must be a real, parseable pairing token.
    expect(() => parsePairingToken(match?.[0] ?? '')).not.toThrow();
  });

  it('fails cleanly when already initialised', () => {
    const dataDir = makeDataDir();
    const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
    const first = runCli(
      ['setup', '--owner', 'Alice', '--vault', 'Notes'],
      { env },
    );
    expect(first.exitCode).toBe(0);
    const second = runCli(
      ['setup', '--owner', 'Alice', '--vault', 'Notes'],
      { env },
    );
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('setup failed');
  });

  it('rejects invalid owner input without leaking internals', () => {
    const dataDir = makeDataDir();
    const result = runCli(['setup', '--owner', '', '--vault', 'Notes'], {
      env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('setup failed');
  });
});

describe('rotate-pairing', () => {
  const PAIRING_PATTERN = /hm_pt_[A-Za-z0-9_-]{43}/u;

  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(['rotate-pairing'], { env: baseEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('invalidates the old token and prints a fresh single-use one', () => {
    const dataDir = makeDataDir();
    const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
    const setup = runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], {
      env,
    });
    const setupToken = setup.stdout.match(PAIRING_PATTERN)?.[0];

    const result = runCli(['rotate-pairing'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Fresh pairing token');
    const rotatedToken = result.stdout.match(PAIRING_PATTERN)?.[0];
    expect(rotatedToken).not.toBeUndefined();
    expect(rotatedToken).not.toBe(setupToken);
    expect(() => parsePairingToken(rotatedToken ?? '')).not.toThrow();
  });

  it('fails cleanly when the owner is not initialised', () => {
    const dataDir = makeDataDir();
    const result = runCli(['rotate-pairing'], {
      env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rotate-pairing failed');
  });
});
