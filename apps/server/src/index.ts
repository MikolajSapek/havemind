// Server entrypoint used by the container CMD (apps/server/Dockerfile).
//
// It parses configuration from the process environment, opens the durable
// SQLite database under HAVEMIND_DATA_DIR, wires the auth/onboarding/sync
// repositories into `buildApp` (exactly as the integration harness does) and
// starts listening. Passing `auth` is what makes the invitation, owner-pairing,
// approval, bootstrap and sync routes exist — without it the process only
// serves discovery/health, which is why `/owner/pair` returned 404 in prod.

import { statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApp } from './app.js';
import { sweepOrphanedBlobs } from './blob-gc.js';
import { parseServerConfig, type ServerEnvironment } from './config.js';
import { DB_FILENAME, openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import { BlobStore } from './blob-store.js';
import { RevisionRepository } from './revision-repository.js';
import { InvitationService } from './auth/invitations.js';
import { SessionRepository } from './auth/session-repository.js';
import { VaultWakeRegistry } from './sync/vault-wake-registry.js';

// The setup CLI (`havemind setup`) writes the database under this name, so the
// server must open the same file it initialised. Blobs live beside it.
const BLOBS_DIRNAME = 'blobs';

function resolveDataDir(environment: ServerEnvironment): string {
  const dataDir = environment.HAVEMIND_DATA_DIR;
  if (dataDir === undefined || dataDir.trim() === '') {
    throw new Error(
      'HAVEMIND_DATA_DIR must point at the server data directory.',
    );
  }
  return dataDir;
}

async function main(): Promise<void> {
  const config = parseServerConfig(process.env);
  const dataDir = resolveDataDir(process.env);

  // Plain WAL SQLite (better-sqlite3): the live database and blob store are
  // stored UNENCRYPTED on the data volume. The `havemind_db_key` secret does
  // NOT encrypt this file — it is used only to seal checkpoint snapshots (see
  // checkpoint.ts). Protecting the live data at rest is the operator's
  // responsibility: a trusted host with tailnet-only access (see the README
  // security model). The server opens the file exactly as setup created it.
  const database = openDatabase(join(dataDir, DB_FILENAME));
  runMigrations(database);

  const sessions = new SessionRepository(database);
  const invitations = new InvitationService(database);
  const blobStore = new BlobStore(join(dataDir, BLOBS_DIRNAME));
  const revisions = new RevisionRepository(database, blobStore, {
    vaultQuotaBytes: config.vaultQuotaBytes,
  });

  // In-memory real-time push wake registry (see vault-wake-registry.ts). A
  // single instance is shared by the push route (notify on commit) and the
  // /wait long-poll route (subscribe while held).
  const wakeRegistry = new VaultWakeRegistry();

  // O(1) free-bytes probe on the data-root filesystem for the disk-pressure
  // guard (plans/005 S6). `bavail`/`bsize` give the space available to a
  // non-privileged writer without scanning any file.
  const freeDiskBytes = async (): Promise<number> => {
    const stats = await statfs(dataDir);
    return stats.bavail * stats.bsize;
  };

  // Reclaim blobs orphaned by rejected pushes (idempotency/revision-id reuse,
  // forbidden actor, missing parent, etc). This must run before the server
  // accepts any connections: it is the only point at which no push request
  // can be concurrently committing a revision that references a
  // freshly-written blob, so it is race-free (see blob-gc.ts).
  await sweepOrphanedBlobs(database, blobStore);

  const app = buildApp({
    config,
    auth: {
      database,
      sessions,
      invitations,
      vaultQuotaBytes: config.vaultQuotaBytes,
      sync: {
        blobStore,
        database,
        revisions,
        vaultQuotaBytes: config.vaultQuotaBytes,
        freeDiskBytes,
        minFreeDiskBytes: config.minFreeDiskBytes,
        wakeRegistry,
      },
    },
  });

  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void app.close().finally(() => {
      try {
        database.close();
      } catch {
        // The database may already be closed during shutdown; ignore.
      }
      process.exit(0);
    });
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start Havemind server: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
