// F9 binary attachments: DEFAULT_MAX_PAYLOAD_BYTES in sync-routes.ts is 36 MiB
// (a 25 MB raw file inflates to ~33.4 MB as base64). The Fastify body limit
// must sit above that plus JSON envelope/batch overhead, so the default is
// raised to 40 MiB; MAX_BODY_LIMIT_BYTES is extended to keep env-var override
// headroom above the new default.
export const DEFAULT_BODY_LIMIT_BYTES = 40 * 1024 * 1024;

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
  readonly port: number;
  readonly serverName: string;
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
  const logLevel = parseLogLevel(environment.HAVEMIND_LOG_LEVEL);

  return Object.freeze({
    apiBaseUrl,
    bodyLimitBytes,
    host,
    logLevel,
    port,
    serverName,
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
