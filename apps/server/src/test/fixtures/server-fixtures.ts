/**
 * Shared scaffolding for the server test suites.
 *
 * Every suite used to carry its own copy of the same preamble: temporary
 * directories and databases tracked for cleanup, raw `INSERT`s for users,
 * devices, vaults and memberships, a session minted through the repository,
 * a `buildApp` call with a fixed rate-limit bucket, and the revision header a
 * push needs. The copies live here once. Anything a suite depends on that
 * differs between suites (timestamps, the device public key, the vault a row
 * belongs to) stays a parameter, so each suite seeds exactly what it did.
 *
 * Suites call `afterEach(releaseTestResources)`. Vitest isolates modules per
 * test file, so the tracking lists below are private to the file that imports
 * them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { PROTOCOL_VERSION, type ProtectedRevisionHeader } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import type { AuthRoutesDeps } from '../../auth/auth-routes.js';
import type { SessionRepository } from '../../auth/session-repository.js';
import { generateRefreshToken } from '../../auth/tokens.js';
import { parseServerConfig } from '../../config.js';
import { openDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';

export const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

export const ACCESS_TTL_SECONDS = 600;
export const REFRESH_TTL_SECONDS = 24 * 60 * 60;

export const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

// ---------------------------------------------------------------------------
// Tracked resources
// ---------------------------------------------------------------------------

const databases: Database.Database[] = [];
const directories: string[] = [];
const applications: FastifyInstance[] = [];

/** A fresh directory under the OS temp dir, removed by `releaseTestResources`. */
export function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Registers a database to be closed by `releaseTestResources`. */
export function trackDatabase<T extends Database.Database>(database: T): T {
  databases.push(database);
  return database;
}

/** Opens (without migrating) a database closed by `releaseTestResources`. */
export function openTrackedDatabase(filename: string): Database.Database {
  return trackDatabase(openDatabase(filename));
}

/** Opens `<directory>/havemind.sqlite`, tracked and fully migrated. */
export function openMigratedDatabase(directory: string): Database.Database {
  const database = openTrackedDatabase(join(directory, 'havemind.sqlite'));
  runMigrations(database);
  return database;
}

/** Registers an app to be closed by `releaseTestResources`. */
export function trackApp<T extends FastifyInstance>(app: T): T {
  applications.push(app);
  return app;
}

/** Closes every tracked app and database, then removes every tracked directory. */
export async function releaseTestResources(): Promise<void> {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Polls `predicate` every 5 ms, failing once `timeoutMs` has passed. */
export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor condition timed out');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface MutableClock {
  readonly now: () => Date;
  advance(milliseconds: number): void;
}

export function createClock(initial: string): MutableClock {
  let milliseconds = Date.parse(initial);
  return {
    advance(value): void {
      milliseconds += value;
    },
    now: () => new Date(milliseconds),
  };
}

// ---------------------------------------------------------------------------
// Identity rows
// ---------------------------------------------------------------------------

export type MembershipRole = 'owner' | 'editor';

export interface DeviceRowOptions {
  /** `devices.vault_id`; NULL (the column default) when omitted. */
  readonly vaultId?: string | null;
  /** Defaults to the seeder's timestamp. */
  readonly approvedAt?: string;
  /** `devices.rejoin_secret_hash`; NULL when omitted. */
  readonly rejoinSecretHash?: string | null;
}

export interface MembershipRowOptions {
  /** Defaults to the seeder's timestamp. */
  readonly createdAt?: string;
  /** Marks the membership revoked at this time; active when omitted. */
  readonly revokedAt?: string;
}

export interface RowSeeder {
  insertUser(database: Database.Database, id: string, name: string, owner?: 0 | 1): void;
  insertDevice(
    database: Database.Database,
    id: string,
    userId: string,
    name: string,
    options?: DeviceRowOptions,
  ): void;
  insertVault(database: Database.Database, id: string, name: string, createdAt?: string): void;
  insertMembership(
    database: Database.Database,
    id: string,
    vaultId: string,
    userId: string,
    role?: MembershipRole,
    options?: MembershipRowOptions,
  ): void;
}

/**
 * Raw row inserts for the identity tables, every timestamp defaulting to `at`.
 * Devices are inserted approved, with `publicKey` (32 bytes of 0x11 unless a
 * suite pins its own).
 */
export function rowSeeder(
  at: string,
  publicKey: Buffer = Buffer.alloc(32, 0x11),
): RowSeeder {
  return {
    insertDevice(database, id, userId, name, options = {}): void {
      database
        .prepare(
          `INSERT INTO devices (
             id, user_id, display_name, public_key, status,
             created_at, approved_at, revoked_at, rejoin_secret_hash, vault_id
           ) VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          userId,
          name,
          publicKey,
          at,
          options.approvedAt ?? at,
          options.rejoinSecretHash ?? null,
          options.vaultId ?? null,
        );
    },
    insertMembership(database, id, vaultId, userId, role = 'owner', options = {}): void {
      database
        .prepare(
          `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          vaultId,
          userId,
          role,
          options.revokedAt === undefined ? 'active' : 'revoked',
          options.createdAt ?? at,
          options.revokedAt ?? null,
        );
    },
    insertUser(database, id, name, owner = 0): void {
      database
        .prepare(
          `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
           VALUES (?, ?, ?, 'active', ?, NULL)`,
        )
        .run(id, name, owner, at);
    },
    insertVault(database, id, name, createdAt = at): void {
      database
        .prepare(
          `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
           VALUES (?, ?, 0, 1, ?, NULL)`,
        )
        .run(id, name, createdAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface OpenedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly familyId: string;
}

/**
 * Issues a live session through the repository (never by hand: refresh tokens
 * live in a family table with rotation state a raw INSERT would skip), keeping
 * the raw refresh token the client would hold.
 */
export function openSession(
  database: Database.Database,
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): OpenedSession {
  const refreshToken = generateRefreshToken();
  const issued = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId,
      initialRefreshToken: refreshToken,
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId,
    }),
  );
  const result = issued.immediate();
  return { accessToken: result.accessToken, familyId: result.familyId, refreshToken };
}

export function mintAccessToken(
  database: Database.Database,
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): string {
  return openSession(database, sessions, userId, deviceId).accessToken;
}

// ---------------------------------------------------------------------------
// Two tenants
// ---------------------------------------------------------------------------

export const USER_A = '70000000-0000-4000-8000-0000000000a1';
export const USER_B = '70000000-0000-4000-8000-0000000000b1';
export const DEVICE_A = '70000000-0000-4000-8000-0000000000a2';
export const DEVICE_B = '70000000-0000-4000-8000-0000000000b2';
export const VAULT_A = '70000000-0000-4000-8000-0000000000a3';
export const VAULT_B = '70000000-0000-4000-8000-0000000000b3';
export const MEMBERSHIP_A = '70000000-0000-4000-8000-0000000000a4';
export const MEMBERSHIP_B = '70000000-0000-4000-8000-0000000000b4';

/**
 * Two tenants that share nothing: Alice owns Vault A from her laptop, Bob owns
 * Vault B from his, each with a live session.
 */
export function seedTwoTenants(
  database: Database.Database,
  sessions: SessionRepository,
  at: string,
): { readonly accessTokenA: string; readonly accessTokenB: string } {
  const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(at);
  insertUser(database, USER_A, 'Alice');
  insertUser(database, USER_B, 'Bob');
  insertDevice(database, DEVICE_A, USER_A, 'Alice Laptop');
  insertDevice(database, DEVICE_B, USER_B, 'Bob Laptop');
  insertVault(database, VAULT_A, 'Vault A');
  insertVault(database, VAULT_B, 'Vault B');
  insertMembership(database, MEMBERSHIP_A, VAULT_A, USER_A);
  insertMembership(database, MEMBERSHIP_B, VAULT_B, USER_B);
  return {
    accessTokenA: mintAccessToken(database, sessions, USER_A, DEVICE_A),
    accessTokenB: mintAccessToken(database, sessions, USER_B, DEVICE_B),
  };
}

// ---------------------------------------------------------------------------
// Row probes
// ---------------------------------------------------------------------------

interface HasDatabase {
  readonly database: Database.Database;
}

function statusOf(
  fixture: HasDatabase,
  table: 'devices' | 'memberships' | 'refresh_token_families',
  id: string,
): string {
  return (
    fixture.database.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as {
      status: string;
    }
  ).status;
}

export function deviceStatus(fixture: HasDatabase, deviceId: string): string {
  return statusOf(fixture, 'devices', deviceId);
}

export function familyStatus(fixture: HasDatabase, familyId: string): string {
  return statusOf(fixture, 'refresh_token_families', familyId);
}

export function membershipStatus(fixture: HasDatabase, membershipId: string): string {
  return statusOf(fixture, 'memberships', membershipId);
}

/** Access tokens issued to `deviceId` that are not revoked. */
export function liveAccessTokenCount(fixture: HasDatabase, deviceId: string): number {
  return (
    fixture.database
      .prepare(
        `SELECT COUNT(*) AS live FROM access_tokens
         WHERE device_id = ? AND revoked_at IS NULL`,
      )
      .get(deviceId) as { live: number }
  ).live;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/** `values` without its `undefined` entries, for optional dependency fields. */
export function definedOnly<T extends object>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export interface TestAppOptions {
  /** Extra `HAVEMIND_*` settings layered over {@link TEST_ENV}. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Suites default to a single fixed rate-limit bucket for simplicity. Pass
   * `false` to exercise the real default `clientKey` (device-keyed for
   * authenticated requests, IP-keyed otherwise).
   */
  readonly fixedClientKey?: boolean;
  readonly loggerStream?: Writable | undefined;
}

/** A logger sink that keeps everything written to it. */
export function collectLogs(): { writer: Writable; read: () => string } {
  const chunks: string[] = [];
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { read: () => chunks.join(''), writer };
}

/** `POST /owner/rejoin-grants` for `membershipId`, as the owner holding `token`. */
export function requestRejoinGrant(app: FastifyInstance, token: string, membershipId: string) {
  return app.inject({
    body: { membershipId },
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    url: '/owner/rejoin-grants',
  });
}

/** `buildApp` over `TEST_ENV`, tracked for `releaseTestResources`. */
export function createTestApp(
  auth: AuthRoutesDeps,
  options: TestAppOptions = {},
): FastifyInstance {
  return trackApp(
    buildApp({
      auth: {
        ...(options.fixedClientKey === false
          ? {}
          : { clientKey: () => 'fixed-test-client' }),
        ...auth,
      },
      config: parseServerConfig({ ...TEST_ENV, ...options.env }),
      ...definedOnly({ loggerStream: options.loggerStream }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export interface RevisionAuthor {
  readonly deviceId: string;
  readonly membershipId: string;
}

export interface RevisionInput {
  header: ProtectedRevisionHeader;
  idempotencyKey: string;
  payload: string;
}

export function revisionHeader(
  vaultId: string,
  author: RevisionAuthor,
  revisionId: string,
  fileId: string,
  parents: readonly string[] = [],
  overrides: Partial<ProtectedRevisionHeader> = {},
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: author.deviceId,
    expectedMemberId: author.membershipId,
    fileId,
    parentRevisionIds: [...parents],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId,
    ...overrides,
  };
}

/** A push entry carrying `content` as the base64 UTF-8 payload. */
export function revisionEntry(
  header: ProtectedRevisionHeader,
  idempotencyKey: string,
  content: string,
): RevisionInput {
  return {
    header,
    idempotencyKey,
    payload: Buffer.from(content, 'utf8').toString('base64'),
  };
}

/** `POST /vaults/:vaultId/revisions` as `token`. */
export function pushRevisions(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  revisions: readonly RevisionInput[],
) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    payload: { revisions },
    url: `/vaults/${vaultId}/revisions`,
  });
}

export function setVaultQuota(
  database: Database.Database,
  vaultId: string,
  quota: number,
): void {
  database.prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`).run(quota, vaultId);
}
