/**
 * Real-server harness for the F8-01 two-client fault matrix.
 *
 * This spins up a genuine Fastify instance built by `buildApp` from
 * `apps/server`, backed by a real SQLite database, blob store and revision
 * repository. Two members share one vault. Nothing here mocks the server: the
 * clients (see `client.ts`) drive it exactly as the plugin would, via HTTP
 * `inject`, so every fault row exercises the true opaque-server contract.
 *
 * The harness owns durable state on disk (`dataDir`) so it can model a server
 * restart (reopen the same files) and a restore onto a clean instance (backup
 * then `restoreInstance`, which rotates the server epoch).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { buildApp } from '../../../apps/server/src/app.js';
import type { AuthRateLimitConfig } from '../../../apps/server/src/auth/auth-routes.js';
import { SessionRepository } from '../../../apps/server/src/auth/session-repository.js';
import {
  createLocalOwnerSetupContext,
  OwnerSetupService,
} from '../../../apps/server/src/auth/setup.js';
import { generateRefreshToken } from '../../../apps/server/src/auth/tokens.js';
import {
  createBackup,
  readInstanceEpoch,
  restoreInstance,
} from '../../../apps/server/src/backup-restore.js';
import { BlobStore } from '../../../apps/server/src/blob-store.js';
import { InvitationService } from '../../../apps/server/src/auth/invitations.js';
import { parseServerConfig } from '../../../apps/server/src/config.js';
import { DB_FILENAME, openDatabase } from '../../../apps/server/src/db.js';
import { runMigrations } from '../../../apps/server/src/migrations.js';
import { RevisionRepository } from '../../../apps/server/src/revision-repository.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Fault Harness Havemind',
} as const;

const START_TIME = '2026-07-16T03:00:00.000Z';
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const BLOBS_DIRNAME = 'blobs';

export interface ClientIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly vaultId: string;
  readonly accessToken: string;
  /**
   * The raw current refresh token backing this identity's session (generation
   * zero). Exposed so tests can exercise `/auth/refresh` directly at the HTTP
   * route level instead of only through the access token.
   */
  readonly refreshToken: string;
}

type FastifyApp = ReturnType<typeof buildApp>;

interface ServerRuntime {
  dataDir: string;
  database: ReturnType<typeof openDatabase>;
  blobStore: BlobStore;
  revisions: RevisionRepository;
  sessions: SessionRepository;
  app: FastifyApp;
}

/** Options for {@link ServerHarness.create}. */
export interface ServerHarnessOptions {
  /**
   * Overrides the per-device auth/sync rate limit (default: production's
   * 120 requests/60s). Only intended for tests deliberately exercising a
   * request volume the default limit would otherwise gate, e.g. a
   * multi-page pull backlog that also fetches one blob per applied
   * revision. Tests exercising the rate limiter itself should not set this.
   */
  readonly authRateLimit?: AuthRateLimitConfig;
}

export class ServerHarness {
  #runtime: ServerRuntime;
  #closed = false;
  readonly #authRateLimit: AuthRateLimitConfig | undefined;

  public readonly alice: ClientIdentity;
  public readonly bob: ClientIdentity;

  private constructor(
    runtime: ServerRuntime,
    alice: ClientIdentity,
    bob: ClientIdentity,
    authRateLimit: AuthRateLimitConfig | undefined,
  ) {
    this.#runtime = runtime;
    this.#authRateLimit = authRateLimit;
    this.alice = alice;
    this.bob = bob;
  }

  /** Current live Fastify instance; changes across restart/restore. */
  public get app(): FastifyApp {
    return this.#runtime.app;
  }

  /** Reads the current server epoch (rotates on restore). */
  public serverEpoch(): string {
    const epoch = readInstanceEpoch(this.#runtime.database);
    if (epoch === null) {
      throw new Error('instance is not initialized');
    }
    return epoch.serverEpoch;
  }

  /** Number of committed revisions across the whole instance. */
  public revisionCount(): number {
    const row = this.#runtime.database
      .prepare('SELECT COUNT(*) AS count FROM revisions')
      .get() as { count: number };
    return row.count;
  }

  /** Number of durable vault events across the whole instance. */
  public eventCount(): number {
    const row = this.#runtime.database
      .prepare('SELECT COUNT(*) AS count FROM vault_events')
      .get() as { count: number };
    return row.count;
  }

  /** The canonical head revision set the server holds for a file. */
  public heads(vaultId: string, fileId: string): string[] {
    return this.#runtime.revisions.getHeads(vaultId, fileId);
  }

  /** Every fileId committed in a vault, ascending by id. */
  public fileIds(vaultId: string): string[] {
    const rows = this.#runtime.database
      .prepare(
        'SELECT id AS id FROM files WHERE vault_id = ? ORDER BY id',
      )
      .all(vaultId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Simulates a hard server restart: closes the process and reopens the same
   * on-disk state. Durable revisions, blobs and sessions survive; nothing is
   * re-derived, so a client that already got a receipt must not double-commit.
   */
  public async restart(): Promise<void> {
    const { dataDir } = this.#runtime;
    await this.#teardownRuntime();
    this.#runtime = openRuntime(dataDir, this.#authRateLimit);
  }

  /**
   * Simulates operator disaster recovery: back the instance up, then restore
   * it onto a brand-new empty directory. `restoreInstance` verifies integrity
   * and rotates the server epoch, which is what forces every client holding an
   * old cursor to reconcile.
   */
  public async restoreOntoCleanInstance(): Promise<string> {
    const backupDir = mkdtempSync(join(tmpdir(), 'havemind-e2e-backup-'));
    trackedDirectories.push(backupDir);
    await createBackup({
      backupDir,
      database: this.#runtime.database,
      dataDir: this.#runtime.dataDir,
    });

    const targetDir = mkdtempSync(join(tmpdir(), 'havemind-e2e-restore-'));
    trackedDirectories.push(targetDir);
    // `restoreInstance` requires an empty target; the mkdtemp dir is empty.
    rmSync(targetDir, { force: true, recursive: true });
    const restored = await restoreInstance({ backupDir, targetDir });

    await this.#teardownRuntime();
    this.#runtime = openRuntime(targetDir, this.#authRateLimit);
    return restored.serverEpoch;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#teardownRuntime();
  }

  async #teardownRuntime(): Promise<void> {
    await this.#runtime.app.close();
    this.#runtime.database.close();
  }

  public static async create(
    options: ServerHarnessOptions = {},
  ): Promise<ServerHarness> {
    const { authRateLimit } = options;
    const dataDir = mkdtempSync(join(tmpdir(), 'havemind-e2e-data-'));
    trackedDirectories.push(dataDir);

    const database = openDatabase(join(dataDir, DB_FILENAME));
    runMigrations(database);

    const now = (): Date => new Date(START_TIME);
    const setup = new OwnerSetupService(database, { now });
    const init = setup.initializeOwner(createLocalOwnerSetupContext(), {
      ownerDisplayName: 'Alice',
      vaultDisplayName: 'Shared Vault',
    });

    const aliceDeviceId = randomUUID();
    const aliceRefreshToken = generateRefreshToken();
    const pair = setup.pairOwnerDevice({
      deviceDisplayName: 'Alice Laptop',
      deviceId: aliceDeviceId,
      initialRefreshToken: aliceRefreshToken,
      pairingToken: init.pairingToken,
      publicKey: Buffer.alloc(32, 0x11),
    });

    const vaultRow = database
      .prepare('SELECT id AS id FROM vaults LIMIT 1')
      .get() as { id: string };
    const vaultId = vaultRow.id;

    const sessions = new SessionRepository(database, { now });

    // Add the second collaborator (Bob) directly into the shared vault. This
    // mirrors an accepted device-approval outcome; the fault matrix is about
    // sync behaviour, not the invitation flow (covered by F2-01).
    const bobUserId = randomUUID();
    const bobDeviceId = randomUUID();
    const bobMembershipId = randomUUID();
    insertUser(database, bobUserId, 'Bob');
    insertDevice(database, bobDeviceId, bobUserId, 'Bob Laptop');
    insertMembership(database, bobMembershipId, vaultId, bobUserId);
    const bobSession = mintAccessToken(database, sessions, bobUserId, bobDeviceId);

    const blobStore = new BlobStore(join(dataDir, BLOBS_DIRNAME));
    const revisions = new RevisionRepository(database, blobStore, { now });
    // `invitations` gates registration of the pre-auth onboarding scope
    // (registerAuthRoutes), which is where `/auth/refresh` lives, without it
    // that route (and the rest of the invite/redeem/refresh surface) 404s.
    const invitations = new InvitationService(database, { now });
    const app = buildApp({
      auth: {
        clientKey: () => 'fixed-test-client',
        database,
        invitations,
        ...(authRateLimit === undefined ? {} : { rateLimit: authRateLimit }),
        sessions,
        sync: { blobStore, database, revisions },
      },
      config: parseServerConfig(TEST_ENV),
      loggerStream: silentLogStream(),
    });

    const runtime: ServerRuntime = {
      app,
      blobStore,
      database,
      dataDir,
      revisions,
      sessions,
    };

    const alice: ClientIdentity = {
      accessToken: pair.accessToken,
      deviceId: aliceDeviceId,
      membershipId: init.membershipId,
      refreshToken: aliceRefreshToken,
      userId: init.ownerUserId,
      vaultId,
    };
    const bob: ClientIdentity = {
      accessToken: bobSession.accessToken,
      deviceId: bobDeviceId,
      membershipId: bobMembershipId,
      refreshToken: bobSession.refreshToken,
      userId: bobUserId,
      vaultId,
    };

    return new ServerHarness(runtime, alice, bob, authRateLimit);
  }
}

/**
 * Reopens a server runtime over an existing data directory. Used by both
 * restart (same directory) and restore (fresh directory), in each case the
 * durable state already exists and is not re-derived.
 */
function openRuntime(
  dataDir: string,
  authRateLimit: AuthRateLimitConfig | undefined,
): ServerRuntime {
  const now = (): Date => new Date(START_TIME);
  const database = openDatabase(join(dataDir, DB_FILENAME));
  runMigrations(database);
  const sessions = new SessionRepository(database, { now });
  const blobStore = new BlobStore(join(dataDir, BLOBS_DIRNAME));
  const revisions = new RevisionRepository(database, blobStore, { now });
  const invitations = new InvitationService(database, { now });
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database,
      invitations,
      ...(authRateLimit === undefined ? {} : { rateLimit: authRateLimit }),
      sessions,
      sync: { blobStore, database, revisions },
    },
    config: parseServerConfig(TEST_ENV),
    loggerStream: silentLogStream(),
  });
  return { app, blobStore, database, dataDir, revisions, sessions };
}

/** Discards Fastify's request logs so the fault-matrix run stays readable. */
function silentLogStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

const trackedDirectories: string[] = [];

/** Removes every temp directory created by the harness. Call in afterEach. */
export function cleanupHarnessDirectories(): void {
  for (const directory of trackedDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

function insertUser(
  database: ServerRuntime['database'],
  id: string,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, 0, 'active', ?, NULL)`,
    )
    .run(id, name, START_TIME);
}

function insertDevice(
  database: ServerRuntime['database'],
  id: string,
  userId: string,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(id, userId, name, Buffer.alloc(32, 0x22), START_TIME, START_TIME);
}

function insertMembership(
  database: ServerRuntime['database'],
  id: string,
  vaultId: string,
  userId: string,
): void {
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'editor', 'active', ?, NULL)`,
    )
    .run(id, vaultId, userId, START_TIME);
}

interface MintedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function mintAccessToken(
  database: ServerRuntime['database'],
  sessions: SessionRepository,
  userId: string,
  deviceId: string,
): MintedSession {
  const refreshToken = generateRefreshToken();
  const issue = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId,
      initialRefreshToken: refreshToken,
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId,
    }),
  );
  return { accessToken: issue.immediate().accessToken, refreshToken };
}
