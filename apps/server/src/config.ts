import { join } from 'node:path';

// F9 binary attachments: DEFAULT_MAX_PAYLOAD_BYTES in sync-routes.ts is 36 MiB
// (a 25 MB raw file inflates to ~33.4 MB as base64). The Fastify body limit
// must sit above that plus JSON envelope/batch overhead, so the default is
// raised to 40 MiB; MAX_BODY_LIMIT_BYTES is extended to keep env-var override
// headroom above the new default.
// AUD-10(c): this is a PER-REQUEST cap only. Nothing bounds how many requests
// may be in flight at once, so peak transient memory is `concurrent requests x
// up to this limit` (~100-150 MiB for a handful of parallel large-attachment
// pushes). Accepted for the two-device, single-trusted-operator tailnet
// deployment, where every caller is authenticated and legitimate concurrency is
// small. Add a semaphore around the push handler if the trust boundary widens
// (more members, a shared tailnet, or any unauthenticated path to /revisions).
// See docs/pilot/known-limitations.md, "Server audit follow-ups (backlog AUD-10)".
export const DEFAULT_BODY_LIMIT_BYTES = 40 * 1024 * 1024;

// Per-vault storage quota (F9 attachments/quota, plans/005). Accounting is a
// pure byte sum over the DISTINCT blob_hash set a vault references, so the
// server stays opaque: it never inspects payload contents, only `blob_size`.
// Default 2 GiB leaves ample room for the two disposable pilot vaults plus
// retained history inside sapserver's ~96 GB free disk, while staying low
// enough that a single client cannot fill the box (see the disk-pressure guard
// below). `MAX_VAULT_QUOTA_BYTES` (64 GiB) is a hard configuration ceiling that
// keeps the free-disk guard meaningful even if the quota is mis-set.
export const DEFAULT_VAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_VAULT_QUOTA_BYTES = 64 * 1024 * 1024 * 1024;

// Disk-pressure guard: an O(1) statfs-style free-bytes check on the data-root
// filesystem, evaluated once per push before any blob is written. Below this
// threshold writes fail closed with STORAGE_UNAVAILABLE (507). Reads are never
// blocked. This is the last line of defence shared across every vault, WAL and
// backup directory on the single ITX box.
export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024 * 1024;

const MIN_BODY_LIMIT_BYTES = 1024;
const MAX_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_SERVER_NAME = 'Havemind';
const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type ServerLogLevel = (typeof LOG_LEVELS)[number];

export type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export interface ServerConfig {
  readonly apiBaseUrl: string;
  readonly bodyLimitBytes: number;
  readonly host: string;
  readonly logLevel: ServerLogLevel;
  readonly minFreeDiskBytes: number;
  readonly port: number;
  readonly serverName: string;
  readonly vaultQuotaBytes: number;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Havemind server configuration: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export function parseServerConfig(environment: ServerEnvironment): ServerConfig {
  const apiBaseUrl = parseApiBaseUrl(environment.HAVEMIND_API_BASE_URL);
  const serverName = parseServerName(environment.HAVEMIND_SERVER_NAME);
  const host = parseHost(environment.HAVEMIND_HOST);
  const allowNonLoopback = parseBoolean(
    environment.HAVEMIND_ALLOW_NON_LOOPBACK,
    'HAVEMIND_ALLOW_NON_LOOPBACK',
    false,
  );

  if (!isLoopbackHost(host) && !allowNonLoopback) {
    throw new ConfigValidationError([
      'HAVEMIND_HOST must be loopback unless HAVEMIND_ALLOW_NON_LOOPBACK is true',
    ]);
  }

  const port = parseBoundedInteger(
    environment.HAVEMIND_PORT,
    'HAVEMIND_PORT',
    DEFAULT_PORT,
    1,
    65_535,
  );
  const bodyLimitBytes = parseBoundedInteger(
    environment.HAVEMIND_BODY_LIMIT_BYTES,
    'HAVEMIND_BODY_LIMIT_BYTES',
    DEFAULT_BODY_LIMIT_BYTES,
    MIN_BODY_LIMIT_BYTES,
    MAX_BODY_LIMIT_BYTES,
  );
  const vaultQuotaBytes = parseBoundedInteger(
    environment.HAVEMIND_VAULT_QUOTA_BYTES,
    'HAVEMIND_VAULT_QUOTA_BYTES',
    DEFAULT_VAULT_QUOTA_BYTES,
    0,
    MAX_VAULT_QUOTA_BYTES,
  );
  const minFreeDiskBytes = parseBoundedInteger(
    environment.HAVEMIND_MIN_FREE_DISK_BYTES,
    'HAVEMIND_MIN_FREE_DISK_BYTES',
    DEFAULT_MIN_FREE_DISK_BYTES,
    0,
    MAX_MIN_FREE_DISK_BYTES,
  );
  const logLevel = parseLogLevel(environment.HAVEMIND_LOG_LEVEL);

  return Object.freeze({
    apiBaseUrl,
    bodyLimitBytes,
    host,
    logLevel,
    minFreeDiskBytes,
    port,
    serverName,
    vaultQuotaBytes,
  });
}

function parseApiBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ConfigValidationError(['HAVEMIND_API_BASE_URL is required']);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigValidationError(['HAVEMIND_API_BASE_URL must be a valid URL']);
  }

  if (url.protocol !== 'https:') {
    throw new ConfigValidationError(['HAVEMIND_API_BASE_URL must use HTTPS']);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigValidationError([
      'HAVEMIND_API_BASE_URL must not contain credentials',
    ]);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigValidationError([
      'HAVEMIND_API_BASE_URL must not contain a query or fragment',
    ]);
  }

  const serialized = url.toString();
  return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
}

function parseServerName(value: string | undefined): string {
  const serverName = value?.trim() ?? DEFAULT_SERVER_NAME;
  if (serverName.length === 0 || serverName.length > 80) {
    throw new ConfigValidationError([
      'HAVEMIND_SERVER_NAME must contain between 1 and 80 characters',
    ]);
  }
  if (containsControlCharacter(serverName)) {
    throw new ConfigValidationError([
      'HAVEMIND_SERVER_NAME must not contain control characters',
    ]);
  }
  return serverName;
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() ?? DEFAULT_HOST;
  if (
    host.length === 0 ||
    host.length > 255 ||
    containsControlCharacter(host) ||
    /[\s/]/u.test(host)
  ) {
    throw new ConfigValidationError(['HAVEMIND_HOST is invalid']);
  }
  return host;
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ConfigValidationError([`${name} must be true or false`]);
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(value)) {
    throw new ConfigValidationError([`${name} must be an integer`]);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigValidationError([
      `${name} must be between ${minimum} and ${maximum}`,
    ]);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): ServerLogLevel {
  const logLevel = value ?? 'info';
  const matched = LOG_LEVELS.find((candidate) => candidate === logLevel);
  if (matched === undefined) {
    throw new ConfigValidationError([
      `HAVEMIND_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
    ]);
  }
  return matched;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// --- Scheduled backups (AUD-10 / 1.0 release gate) --------------------------

/** Default cadence of the in-process backup timer, in hours. */
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;
/** Default number of newest artifacts kept on the host after each run. */
export const DEFAULT_BACKUP_KEEP = 7;
const MAX_BACKUP_INTERVAL_HOURS = 24 * 30;
const MAX_BACKUP_KEEP = 365;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export interface ScheduledBackupSettings {
  readonly backupsRoot: string;
  readonly intervalMs: number;
  readonly keep: number;
}

/**
 * Resolves the scheduled-backup settings, or null when the feature is off.
 *
 * Backups are OPT-IN: with `HAVEMIND_BACKUP_DIR` unset the server starts exactly
 * as before and writes no artifacts, so a deployment without a prepared,
 * writable backup directory cannot fail at boot or silently fill its data volume.
 */
export function parseScheduledBackupConfig(
  environment: ServerEnvironment,
): ScheduledBackupSettings | null {
  const backupDir = environment.HAVEMIND_BACKUP_DIR;
  if (backupDir === undefined || backupDir.trim() === '') {
    return null;
  }

  const intervalHours = parseBoundedInteger(
    environment.HAVEMIND_BACKUP_INTERVAL_HOURS,
    'HAVEMIND_BACKUP_INTERVAL_HOURS',
    DEFAULT_BACKUP_INTERVAL_HOURS,
    1,
    MAX_BACKUP_INTERVAL_HOURS,
  );
  const keep = parseBoundedInteger(
    environment.HAVEMIND_BACKUP_KEEP,
    'HAVEMIND_BACKUP_KEEP',
    DEFAULT_BACKUP_KEEP,
    1,
    MAX_BACKUP_KEEP,
  );

  return Object.freeze({
    backupsRoot: backupDir.trim(),
    intervalMs: intervalHours * MILLISECONDS_PER_HOUR,
    keep,
  });
}

// --- Encrypted checkpoints (plans/006) --------------------------------------

/** A 32-byte X25519 recipient public key is 64 lowercase hex characters. */
export const CHECKPOINT_PUBLIC_KEY_HEX_LENGTH = 64;

const CHECKPOINTS_DIRNAME = 'checkpoints';
const HEX32_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Validates the checkpoint recipient PUBLIC key from the environment. The
 * server only ever holds the public key (it can seal a new checkpoint but never
 * open any, plans/006 "Key management"). Returns null when unset so the
 * CLI can require it only for `checkpoint create`.
 */
export function parseCheckpointPublicKeyHex(
  value: string | undefined,
): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!HEX32_PATTERN.test(normalized)) {
    throw new ConfigValidationError([
      'HAVEMIND_CHECKPOINT_PUBLIC_KEY must be 64 lowercase hex characters (a 32-byte X25519 public key)',
    ]);
  }
  return normalized;
}

/**
 * Resolves the directory checkpoints are written to. Explicit
 * `HAVEMIND_CHECKPOINT_DIR` wins; otherwise `<HAVEMIND_DATA_DIR>/checkpoints`.
 * Returns null when neither is set.
 */
export function resolveCheckpointDir(env: ServerEnvironment): string | null {
  const explicit = env.HAVEMIND_CHECKPOINT_DIR;
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit.trim();
  }
  const dataDir = env.HAVEMIND_DATA_DIR;
  if (dataDir !== undefined && dataDir.trim() !== '') {
    return join(dataDir.trim(), CHECKPOINTS_DIRNAME);
  }
  return null;
}
