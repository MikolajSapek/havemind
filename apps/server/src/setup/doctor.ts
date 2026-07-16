import { statSync } from 'node:fs';

import {
  ConfigValidationError,
  parseServerConfig,
  type ServerEnvironment,
} from '../config.js';

/**
 * Server-side diagnostics (`havemind doctor`).
 *
 * Hard rule (plan/01, plan/04 §"Zakaz przekazywania sekretów"): this command
 * NEVER reveals a raw token, password, or the contents of any file under
 * `/srv/secrets`. It is built so leakage is structurally impossible — the
 * checks only ever receive metadata (path, byte length, permission bits),
 * never secret material.
 */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

export type DoctorOutputMode = 'text' | 'json';

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  /** Secret-free, human-readable explanation. */
  readonly detail: string;
}

export interface DoctorReport {
  /** Worst status across all checks. */
  readonly status: DoctorStatus;
  readonly checks: readonly DoctorCheck[];
}

export interface PathStat {
  readonly size: number;
  /** Permission bits only (mode & 0o777). */
  readonly mode: number;
  readonly isDirectory: boolean;
}

export interface DoctorDependencies {
  readonly env: ServerEnvironment;
  /** Returns metadata only — never file contents. */
  readonly stat?: (path: string) => PathStat | null;
}

export const DEFAULT_DB_KEY_FILE = '/srv/secrets/havemind_db_key';
const MIN_DB_KEY_BYTES = 32;
const OWNER_READ_WRITE_MASK = 0o077;

function defaultStat(path: string): PathStat | null {
  try {
    const stats = statSync(path);
    return {
      isDirectory: stats.isDirectory(),
      mode: stats.mode & 0o777,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

function toOctal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function checkConfig(env: ServerEnvironment): DoctorCheck {
  try {
    const config = parseServerConfig(env);
    return {
      detail: `Configuration valid (server "${config.serverName}", host ${config.host}, port ${config.port}).`,
      name: 'config',
      status: 'ok',
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return {
        detail: `Configuration invalid: ${error.issues.join('; ')}.`,
        name: 'config',
        status: 'fail',
      };
    }
    return {
      detail: 'Configuration could not be parsed.',
      name: 'config',
      status: 'fail',
    };
  }
}

function checkDatabaseKeySecret(
  env: ServerEnvironment,
  stat: (path: string) => PathStat | null,
): DoctorCheck {
  const path = env.HAVEMIND_DB_KEY_FILE ?? DEFAULT_DB_KEY_FILE;
  const info = stat(path);
  if (info === null || info.isDirectory) {
    return {
      detail: `Database key secret is missing at ${path}.`,
      name: 'db-key-secret',
      status: 'fail',
    };
  }
  if ((info.mode & OWNER_READ_WRITE_MASK) !== 0) {
    return {
      detail: `Database key secret at ${path} has permissive mode ${toOctal(info.mode)}; expected 0600.`,
      name: 'db-key-secret',
      status: 'warn',
    };
  }
  if (info.size < MIN_DB_KEY_BYTES) {
    return {
      detail: `Database key secret at ${path} is ${info.size} bytes; expected at least ${MIN_DB_KEY_BYTES} (256 bits).`,
      name: 'db-key-secret',
      status: 'warn',
    };
  }
  return {
    detail: `Database key secret present at ${path} (${info.size} bytes, mode ${toOctal(info.mode)}).`,
    name: 'db-key-secret',
    status: 'ok',
  };
}

function checkDataDirectory(
  env: ServerEnvironment,
  stat: (path: string) => PathStat | null,
): DoctorCheck {
  const path = env.HAVEMIND_DATA_DIR;
  if (path === undefined || path.trim() === '') {
    return {
      detail: 'HAVEMIND_DATA_DIR is not set.',
      name: 'data-dir',
      status: 'warn',
    };
  }
  const info = stat(path);
  if (info === null) {
    return {
      detail: `Data directory ${path} does not exist.`,
      name: 'data-dir',
      status: 'fail',
    };
  }
  if (!info.isDirectory) {
    return {
      detail: `Data directory ${path} is not a directory.`,
      name: 'data-dir',
      status: 'fail',
    };
  }
  return {
    detail: `Data directory present at ${path}.`,
    name: 'data-dir',
    status: 'ok',
  };
}

function worstStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === 'fail')) {
    return 'fail';
  }
  if (checks.some((check) => check.status === 'warn')) {
    return 'warn';
  }
  return 'ok';
}

export function runDoctor(dependencies: DoctorDependencies): DoctorReport {
  const stat = dependencies.stat ?? defaultStat;
  const checks: readonly DoctorCheck[] = [
    checkConfig(dependencies.env),
    checkDatabaseKeySecret(dependencies.env, stat),
    checkDataDirectory(dependencies.env, stat),
  ];
  return { checks, status: worstStatus(checks) };
}

export function formatDoctorReport(
  report: DoctorReport,
  mode: DoctorOutputMode,
): string {
  if (mode === 'json') {
    return JSON.stringify(report, null, 2);
  }
  const lines = [`Havemind doctor: ${report.status.toUpperCase()}`];
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}
