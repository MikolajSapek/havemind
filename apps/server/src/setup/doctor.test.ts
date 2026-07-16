import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerEnvironment } from '../config.js';
import {
  DEFAULT_DB_KEY_FILE,
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
  type PathStat,
} from './doctor.js';

const INJECTED_SECRET =
  'SUPER-SECRET-DB-KEY-4a7f2c9e8b1d6f3a0e5c7b9d2f4a6c8e0b1d3f5a';

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-doctor-'));
  temporaryDirectories.push(directory);
  return directory;
}

function validEnv(overrides: ServerEnvironment = {}): ServerEnvironment {
  return {
    HAVEMIND_API_BASE_URL: 'https://havemind.example.ts.net',
    ...overrides,
  };
}

function findCheck(report: DoctorReport, name: string): string {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (check === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return check.status;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe('runDoctor', () => {
  it('fails when the configuration is invalid', () => {
    const report = runDoctor({ env: {}, stat: () => null });
    expect(findCheck(report, 'config')).toBe('fail');
    expect(report.status).toBe('fail');
  });

  it('reports the db-key secret as missing when absent', () => {
    const report = runDoctor({ env: validEnv(), stat: () => null });
    expect(findCheck(report, 'db-key-secret')).toBe('fail');
  });

  it('warns when the db-key secret file has permissive permissions', () => {
    const stat = (): PathStat => ({
      isDirectory: false,
      mode: 0o644,
      size: 64,
    });
    const report = runDoctor({ env: validEnv(), stat });
    expect(findCheck(report, 'db-key-secret')).toBe('warn');
  });

  it('warns when the db-key secret file is too short', () => {
    const stat = (): PathStat => ({ isDirectory: false, mode: 0o600, size: 8 });
    const report = runDoctor({ env: validEnv(), stat });
    expect(findCheck(report, 'db-key-secret')).toBe('warn');
  });

  it('passes db-key check for a 0600, 256-bit file', () => {
    const stat = (): PathStat => ({
      isDirectory: false,
      mode: 0o600,
      size: 64,
    });
    const report = runDoctor({ env: validEnv(), stat });
    expect(findCheck(report, 'db-key-secret')).toBe('ok');
  });

  it('uses the default /srv/secrets path when unset', () => {
    let requested = '';
    runDoctor({
      env: validEnv(),
      stat: (path) => {
        requested = path;
        return null;
      },
    });
    expect(requested).toContain(DEFAULT_DB_KEY_FILE);
  });

  it('warns when the data directory is not configured', () => {
    const report = runDoctor({ env: validEnv(), stat: () => null });
    expect(findCheck(report, 'data-dir')).toBe('warn');
  });

  it('fails when the data directory is missing', () => {
    const report = runDoctor({
      env: validEnv({ HAVEMIND_DATA_DIR: '/no/such/dir' }),
      stat: () => null,
    });
    expect(findCheck(report, 'data-dir')).toBe('fail');
  });

  it('fails when the data directory path is a file', () => {
    const report = runDoctor({
      env: validEnv({ HAVEMIND_DATA_DIR: '/data' }),
      stat: () => ({ isDirectory: false, mode: 0o600, size: 1 }),
    });
    expect(findCheck(report, 'data-dir')).toBe('fail');
  });

  it('passes the data directory check for a real directory', () => {
    const dataDir = makeTempDir();
    const report = runDoctor({
      env: validEnv({ HAVEMIND_DATA_DIR: dataDir }),
    });
    expect(findCheck(report, 'data-dir')).toBe('ok');
  });
});

describe('secret non-disclosure (AC: grep output -> 0 hits)', () => {
  it('never prints the raw /srv/secrets contents in any output mode', () => {
    const dataDir = makeTempDir();
    const secretFile = join(dataDir, 'havemind_db_key');
    writeFileSync(secretFile, INJECTED_SECRET, { mode: 0o600 });
    chmodSync(secretFile, 0o600);

    const report = runDoctor({
      env: validEnv({
        // An operator mistake: a raw secret sitting in the environment.
        HAVEMIND_DATA_DIR: dataDir,
        HAVEMIND_DB_KEY_FILE: secretFile,
      }),
    });

    const text = formatDoctorReport(report, 'text');
    const json = formatDoctorReport(report, 'json');

    // The whole point of the AC: grep the output for the secret -> 0 hits.
    expect(text).not.toContain(INJECTED_SECRET);
    expect(json).not.toContain(INJECTED_SECRET);
    // Metadata (path + byte length) is still surfaced.
    expect(text).toContain(secretFile);
    expect(text).toContain(String(INJECTED_SECRET.length));
  });

  it('never echoes a raw secret injected via an environment value', () => {
    const report = runDoctor({
      env: validEnv({ HAVEMIND_SERVER_NAME: 'Havemind' }),
      stat: () => ({ isDirectory: false, mode: 0o600, size: 64 }),
    });
    const combined = `${formatDoctorReport(report, 'text')}${formatDoctorReport(
      report,
      'json',
    )}`;
    expect(combined).not.toContain(INJECTED_SECRET);
  });
});

describe('formatDoctorReport', () => {
  it('renders a text summary with a header and per-check lines', () => {
    const report = runDoctor({
      env: validEnv(),
      stat: () => ({ isDirectory: false, mode: 0o600, size: 64 }),
    });
    const text = formatDoctorReport(report, 'text');
    expect(text.startsWith('Havemind doctor:')).toBe(true);
    expect(text).toContain('[ok] config:');
  });

  it('renders valid JSON', () => {
    const report = runDoctor({ env: validEnv(), stat: () => null });
    const parsed = JSON.parse(formatDoctorReport(report, 'json')) as {
      status: string;
    };
    expect(parsed.status).toBe(report.status);
  });
});
