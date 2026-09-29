import { isIP } from 'node:net';

// F9 binary attachments: a 25 MiB file is base64-encoded inside its revision
// payload (~33.4 MiB, under DEFAULT_MAX_PAYLOAD_BYTES = 36 MiB in
// sync-routes.ts), and the push body carries that payload base64-encoded AGAIN,
// so the request is ~44.5 MiB. The default sits above that; at 40 MiB every
// attachment from ~22.5 MiB up was refused with 413 and stuck in quarantine.
// tests/attachment-limits.test.ts builds the real request and keeps the
// plugin's size cap and this limit in agreement.
// AUD-10(c): this is a PER-REQUEST cap only. Nothing bounds how many requests
// may be in flight at once, so peak transient memory is `concurrent requests x
// up to this limit` (~150-200 MiB for a handful of parallel large-attachment
// pushes). Accepted for the two-device, single-trusted-operator tailnet
// deployment, where every caller is authenticated and legitimate concurrency is
// small. Add a semaphore around the push handler if the trust boundary widens
// (more members, a shared tailnet, or any unauthenticated path to /revisions).
// See docs/pilot/known-limitations.md, "Server audit follow-ups (backlog AUD-10)".
export const DEFAULT_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

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
  /**
   * Addresses (IPs or CIDR ranges) of the reverse proxy in front of the server,
   * as the server sees them. `X-Forwarded-For` is believed only on a connection
   * from one of these; empty, the default, ignores the header entirely.
   */
  readonly trustedProxies: readonly string[];
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
  const trustedProxies = parseTrustedProxies(
    environment.HAVEMIND_TRUSTED_PROXIES,
  );

  return Object.freeze({
    apiBaseUrl,
    bodyLimitBytes,
    host,
    logLevel,
    minFreeDiskBytes,
    port,
    serverName,
    trustedProxies,
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

/**
 * A comma-separated list of IP addresses and CIDR ranges, or nothing. Only
 * these forms, so that whatever passes here is also accepted by Fastify's
 * `trustProxy` (no hostnames, hop counts or named ranges). A prefix of 0 is
 * refused: a range matching every address would make `X-Forwarded-For`
 * client controlled, which is worse than trusting no proxy at all.
 */
function parseTrustedProxies(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value.split(',').map((item) => {
    const entry = item.trim();
    const [address = '', prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    const maximumPrefix = family === 4 ? 32 : 128;
    const validPrefix =
      prefix === undefined ||
      (/^\d+$/u.test(prefix) &&
        Number(prefix) >= 1 &&
        Number(prefix) <= maximumPrefix);
    if (family === 0 || !validPrefix || rest.length > 0) {
      throw new ConfigValidationError([
        `HAVEMIND_TRUSTED_PROXIES must list IP addresses or CIDR ranges, got "${entry}"`,
      ]);
    }
    return entry;
  });
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
