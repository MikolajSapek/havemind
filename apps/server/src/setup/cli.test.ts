import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerEnvironment } from '../config.js';
import { runCli } from './cli.js';
import { InvitationService } from '../auth/invitations.js';
import { OwnerSetupService } from '../auth/setup.js';
import { generateRefreshToken, parsePairingToken } from '../auth/tokens.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';

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

describe('create-vault', () => {
  const CREATE_VAULT_PATTERN = /hm_pt_[A-Za-z0-9_-]{43}/u;

  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(
      ['create-vault', '--owner', 'Magda', '--vault', 'Second'],
      { env: baseEnv() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('fails cleanly when the instance owner is not initialised', () => {
    const dataDir = makeDataDir();
    const result = runCli(
      ['create-vault', '--owner', 'Magda', '--vault', 'Second'],
      { env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('create-vault failed');
  });

  it('creates an independent vault and prints a single-use pairing token', () => {
    const dataDir = makeDataDir();
    const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
    const setup = runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], {
      env,
    });
    const setupToken = setup.stdout.match(CREATE_VAULT_PATTERN)?.[0];

    const result = runCli(
      ['create-vault', '--owner', 'Magda', '--vault', 'Second'],
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vault created.');
    const token = result.stdout.match(CREATE_VAULT_PATTERN)?.[0];
    expect(token).not.toBeUndefined();
    expect(token).not.toBe(setupToken);
    expect(() => parsePairingToken(token ?? '')).not.toThrow();

    // The instance owner and their first vault remain intact; the new owner is
    // an independent, non-instance-owner user.
    const database = openDatabase(join(dataDir, 'havemind.db'));
    try {
      const owners = database
        .prepare(
          `SELECT COUNT(*) AS count FROM users
           WHERE is_instance_owner = 1 AND status = 'active'`,
        )
        .get() as { count: number };
      const vaults = database
        .prepare('SELECT COUNT(*) AS count FROM vaults')
        .get() as { count: number };
      const secondaryOwners = database
        .prepare(
          `SELECT COUNT(*) AS count FROM users WHERE is_instance_owner = 0`,
        )
        .get() as { count: number };
      expect(owners.count).toBe(1);
      expect(vaults.count).toBe(2);
      expect(secondaryOwners.count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects invalid input without leaking internals', () => {
    const dataDir = makeDataDir();
    const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
    runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], { env });
    const result = runCli(
      ['create-vault', '--owner', '', '--vault', 'Second'],
      { env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('create-vault failed');
  });
});

const PAIRING_PATTERN = /hm_pt_[A-Za-z0-9_-]{43}/u;
const NON_ZERO_PUBLIC_KEY = Buffer.alloc(32, 1);

interface OwnerContext {
  readonly membershipId: string;
  readonly userId: string;
  readonly vaultId: string;
}

/** Runs setup and pairs an approved owner device on the same on-disk database. */
function seedOwnerWithDevice(dataDir: string): {
  readonly env: ServerEnvironment;
  readonly ownerDeviceId: string;
} {
  const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
  const setup = runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], {
    env,
  });
  const pairingToken = setup.stdout.match(PAIRING_PATTERN)?.[0] ?? '';

  const database = openDatabase(join(dataDir, 'havemind.db'));
  runMigrations(database);
  const ownerDeviceId = randomUUID();
  try {
    new OwnerSetupService(database).pairOwnerDevice({
      deviceDisplayName: 'Owner laptop',
      deviceId: ownerDeviceId,
      initialRefreshToken: generateRefreshToken(),
      pairingToken,
      publicKey: NON_ZERO_PUBLIC_KEY,
    });
  } finally {
    database.close();
  }
  return { env, ownerDeviceId };
}

function loadOwnerContext(dataDir: string): OwnerContext {
  const database = openDatabase(join(dataDir, 'havemind.db'));
  try {
    return database
      .prepare(
        `SELECT id AS membershipId, user_id AS userId, vault_id AS vaultId
         FROM memberships WHERE role = 'owner' AND status = 'active' LIMIT 1`,
      )
      .get() as OwnerContext;
  } finally {
    database.close();
  }
}

/** Extends the owner seed to a redeemed (pending-approval) second device. */
function seedPendingDevice(dataDir: string): {
  readonly env: ServerEnvironment;
  readonly expectedPhrase: string;
  readonly invitationId: string;
} {
  const { env, ownerDeviceId } = seedOwnerWithDevice(dataDir);
  const owner = loadOwnerContext(dataDir);

  const database = openDatabase(join(dataDir, 'havemind.db'));
  try {
    const invitations = new InvitationService(database);
    const created = invitations.createInvitation({
      createdByMembershipId: owner.membershipId,
      intendedMemberDisplayName: 'Magda',
      intendedRole: 'editor',
      inviterDeviceId: ownerDeviceId,
      vaultId: owner.vaultId,
    });
    const redeemed = invitations.redeemInvitationForOnboarding({
      deviceLabel: 'Magda iPad',
      initialRefreshToken: generateRefreshToken(),
      invitationToken: created.invitationToken,
      redemptionId: randomUUID(),
    });
    return {
      env,
      expectedPhrase: redeemed.verificationPhrase,
      invitationId: created.invitationId,
    };
  } finally {
    database.close();
  }
}

const VAULT_ID_PATTERN = /Vault id:\s+([0-9a-f-]{36})/u;

/** Seeds the instance owner plus an additional (create-vault) secondary vault. */
function seedSecondaryVault(dataDir: string): {
  readonly env: ServerEnvironment;
  readonly secondaryToken: string;
  readonly vaultId: string;
} {
  const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
  runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], { env });
  const created = runCli(
    ['create-vault', '--owner', 'Magda', '--vault', 'Second'],
    { env },
  );
  const vaultId = created.stdout.match(VAULT_ID_PATTERN)?.[1] ?? '';
  const secondaryToken = created.stdout.match(PAIRING_PATTERN)?.[0] ?? '';
  return { env, secondaryToken, vaultId };
}

/** Extends a secondary vault with an owner device and a pending-approval device. */
function seedSecondaryVaultPendingDevice(dataDir: string): {
  readonly env: ServerEnvironment;
  readonly expectedPhrase: string;
  readonly invitationId: string;
  readonly vaultId: string;
} {
  const { env, secondaryToken, vaultId } = seedSecondaryVault(dataDir);
  const database = openDatabase(join(dataDir, 'havemind.db'));
  runMigrations(database);
  try {
    const secondaryDeviceId = randomUUID();
    new OwnerSetupService(database).pairOwnerDevice({
      deviceDisplayName: 'Magda laptop',
      deviceId: secondaryDeviceId,
      initialRefreshToken: generateRefreshToken(),
      pairingToken: secondaryToken,
      publicKey: NON_ZERO_PUBLIC_KEY,
    });
    const owner = database
      .prepare(
        `SELECT id AS membershipId, user_id AS userId, vault_id AS vaultId
         FROM memberships
         WHERE vault_id = ? AND role = 'owner' AND status = 'active' LIMIT 1`,
      )
      .get(vaultId) as OwnerContext;

    const invitations = new InvitationService(database);
    const created = invitations.createInvitation({
      createdByMembershipId: owner.membershipId,
      intendedMemberDisplayName: 'Bartek',
      intendedRole: 'editor',
      inviterDeviceId: secondaryDeviceId,
      vaultId: owner.vaultId,
    });
    const redeemed = invitations.redeemInvitationForOnboarding({
      deviceLabel: 'Bartek iPad',
      initialRefreshToken: generateRefreshToken(),
      invitationToken: created.invitationToken,
      redemptionId: randomUUID(),
    });
    return {
      env,
      expectedPhrase: redeemed.verificationPhrase,
      invitationId: created.invitationId,
      vaultId,
    };
  } finally {
    database.close();
  }
}

function decodeEnvelope(envelope: string): Record<string, unknown> {
  const payload = envelope.slice('v1.'.length);
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

describe('create-invitation', () => {
  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(['create-invitation'], { env: baseEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('requires a canonical HAVEMIND_API_BASE_URL', () => {
    const dataDir = makeDataDir();
    const result = runCli(['create-invitation'], {
      env: { HAVEMIND_DATA_DIR: dataDir },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_API_BASE_URL');
  });

  it('fails cleanly when the owner is not initialised', () => {
    const dataDir = makeDataDir();
    const result = runCli(['create-invitation'], {
      env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('create-invitation failed');
  });

  it('fails cleanly when no owner device is paired', () => {
    const dataDir = makeDataDir();
    const env = baseEnv({ HAVEMIND_DATA_DIR: dataDir });
    runCli(['setup', '--owner', 'Alice', '--vault', 'Notes'], { env });
    const result = runCli(['create-invitation'], { env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('create-invitation failed');
    expect(result.stderr).toContain('device');
  });

  it('mints a canonical v1 envelope without leaking the raw token', () => {
    const dataDir = makeDataDir();
    const { env } = seedOwnerWithDevice(dataDir);
    const result = runCli(
      ['create-invitation', '--role', 'editor', '--name', 'Magda'],
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Magda');
    expect(result.stdout).toMatch(/Expires/u);
    // The raw invitation token must never be printed on its own.
    expect(result.stdout).not.toMatch(/hm_it_/u);

    const envelope = result.stdout.match(/v1\.[A-Za-z0-9_-]+/u)?.[0] ?? '';
    expect(envelope).not.toBe('');
    const decoded = decodeEnvelope(envelope);
    expect(decoded.version).toBe(1);
    expect(decoded.serverOrigin).toBe('https://havemind.example.ts.net');
    expect(String(decoded.invitationToken)).toMatch(/^hm_it_[A-Za-z0-9_-]{43}$/u);
  });
});

describe('approve', () => {
  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(['approve'], { env: baseEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('fails cleanly when the owner is not initialised', () => {
    const dataDir = makeDataDir();
    const result = runCli(['approve'], {
      env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('approve failed');
  });

  it('reports when nothing awaits approval', () => {
    const dataDir = makeDataDir();
    const { env } = seedOwnerWithDevice(dataDir);
    const result = runCli(['approve'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No devices awaiting approval');
  });

  it('lists a pending device without ever printing its verification PIN', () => {
    const dataDir = makeDataDir();
    const { env, expectedPhrase, invitationId } = seedPendingDevice(dataDir);
    const result = runCli(['approve'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(invitationId);
    expect(result.stdout).toContain('Magda');
    expect(result.stdout).toContain('editor');
    // The PIN's whole security guarantee is that only the joining device
    // shows it; the listing must never leak it to shell access.
    expect(result.stdout).not.toContain(expectedPhrase);
    expect(result.stdout.toLowerCase()).not.toContain('verification code');
  });

  it('rejects approve with no --pin instead of auto-approving', () => {
    const dataDir = makeDataDir();
    const { env, invitationId } = seedPendingDevice(dataDir);
    const result = runCli(['approve', '--invitation', invitationId], { env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('approve failed');
    expect(result.stderr).toContain('--pin');

    // Still pending: the missing-PIN call must not have approved it.
    const after = runCli(['approve'], { env });
    expect(after.stdout).toContain(invitationId);
  });

  it('approves a specific pending device given the correct --pin', () => {
    const dataDir = makeDataDir();
    const { env, expectedPhrase, invitationId } = seedPendingDevice(dataDir);
    const result = runCli(
      ['approve', '--invitation', invitationId, '--pin', expectedPhrase],
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('approved');

    // Once approved it no longer appears in the pending list.
    const after = runCli(['approve'], { env });
    expect(after.stdout).toContain('No devices awaiting approval');
  });

  it('rejects a mismatched verification PIN', () => {
    const dataDir = makeDataDir();
    const { env, expectedPhrase, invitationId } = seedPendingDevice(dataDir);
    const wrongPhrase = expectedPhrase === '000000' ? '111111' : '000000';
    const result = runCli(
      ['approve', '--invitation', invitationId, '--pin', wrongPhrase],
      { env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('approve failed');
  });

  it('fails when the invitation id matches no pending device', () => {
    const dataDir = makeDataDir();
    const { env } = seedPendingDevice(dataDir);
    const result = runCli(
      ['approve', '--invitation', randomUUID(), '--pin', '000000'],
      { env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('approve failed');
  });

  it('approves a device pending in a secondary (create-vault) vault', () => {
    const dataDir = makeDataDir();
    const { env, expectedPhrase, invitationId } =
      seedSecondaryVaultPendingDevice(dataDir);
    const result = runCli(
      ['approve', '--invitation', invitationId, '--pin', expectedPhrase],
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('approved');

    const after = runCli(['approve'], { env });
    expect(after.stdout).toContain('No devices awaiting approval');
  });

  it('annotates each pending device with its vault and filters by --vault', () => {
    const dataDir = makeDataDir();
    const { env, invitationId, vaultId } =
      seedSecondaryVaultPendingDevice(dataDir);

    const list = runCli(['approve'], { env });
    expect(list.stdout).toContain(invitationId);
    expect(list.stdout).toContain(vaultId);
    expect(list.stdout).toContain('Second');

    const filtered = runCli(['approve', '--vault', vaultId], { env });
    expect(filtered.stdout).toContain(invitationId);

    const other = runCli(['approve', '--vault', randomUUID()], { env });
    expect(other.stdout).toContain('No devices awaiting approval');
  });
});

describe('rotate-pairing (multi-vault)', () => {
  it('mints a fresh token for a secondary vault owner with --vault', () => {
    const dataDir = makeDataDir();
    const { env, vaultId } = seedSecondaryVault(dataDir);
    const result = runCli(['rotate-pairing', '--vault', vaultId], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Fresh pairing token');
    expect(result.stdout).toContain(vaultId);
    const token = result.stdout.match(PAIRING_PATTERN)?.[0];
    expect(token).not.toBeUndefined();
    expect(() => parsePairingToken(token ?? '')).not.toThrow();
  });

  it('fails cleanly for an unknown --vault', () => {
    const dataDir = makeDataDir();
    const { env } = seedSecondaryVault(dataDir);
    const result = runCli(['rotate-pairing', '--vault', randomUUID()], { env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rotate-pairing failed');
  });
});

describe('cleanup-stale', () => {
  it('requires HAVEMIND_DATA_DIR', () => {
    const result = runCli(['cleanup-stale'], { env: baseEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HAVEMIND_DATA_DIR');
  });

  it('rejects a non-numeric --pending-older-than-hours', () => {
    const dataDir = makeDataDir();
    const result = runCli(
      ['cleanup-stale', '--pending-older-than-hours', 'abc'],
      { env: baseEnv({ HAVEMIND_DATA_DIR: dataDir }) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cleanup-stale failed');
  });

  it('reports zero removals on a freshly-seeded database', () => {
    const dataDir = makeDataDir();
    const { env } = seedOwnerWithDevice(dataDir);
    const result = runCli(['cleanup-stale'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0 invitation(s) removed');
    expect(result.stdout).toContain('0 pending device(s) removed');
  });

  it('removes a stale, unapproved invitation while leaving the approved device untouched', () => {
    const dataDir = makeDataDir();
    const { env } = seedPendingDevice(dataDir);

    // Age the pending device beyond the default 24h threshold and expire its
    // invitation directly on disk, mirroring what accumulates during a pilot.
    const database = openDatabase(join(dataDir, 'havemind.db'));
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    database
      .prepare(
        `UPDATE devices SET created_at = ? WHERE status = 'pending'`,
      )
      .run(longAgo);
    database
      .prepare(`UPDATE invitations SET expires_at = ?`)
      .run(longAgo);
    database.close();

    const result = runCli(['cleanup-stale'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 invitation(s) removed');
    expect(result.stdout).toContain('1 pending device(s) removed');

    const after = openDatabase(join(dataDir, 'havemind.db'));
    const approvedDevice = after
      .prepare(`SELECT status FROM devices WHERE status = 'approved'`)
      .get() as { status: string } | undefined;
    after.close();
    expect(approvedDevice?.status).toBe('approved');
  });

  it('dry-run reports counts without deleting', () => {
    const dataDir = makeDataDir();
    const { env } = seedPendingDevice(dataDir);
    const database = openDatabase(join(dataDir, 'havemind.db'));
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    database
      .prepare(`UPDATE devices SET created_at = ? WHERE status = 'pending'`)
      .run(longAgo);
    database.exec('PRAGMA optimize;');
    database.close();

    const result = runCli(['cleanup-stale', '--dry-run'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(result.stdout).toContain('1 pending device(s) would be removed');

    const after = openDatabase(join(dataDir, 'havemind.db'));
    const stillPending = after
      .prepare(`SELECT COUNT(*) AS count FROM devices WHERE status = 'pending'`)
      .get() as { count: number };
    after.close();
    expect(stillPending.count).toBe(1);
  });

  it('honours a custom --pending-older-than-hours threshold', () => {
    const dataDir = makeDataDir();
    const { env } = seedPendingDevice(dataDir);
    const database = openDatabase(join(dataDir, 'havemind.db'));
    // 3h old: untouched by the default 24h threshold, but caught by a 2h one.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    database
      .prepare(`UPDATE devices SET created_at = ? WHERE status = 'pending'`)
      .run(threeHoursAgo);
    database.close();

    const untouched = runCli(['cleanup-stale', '--dry-run'], { env });
    expect(untouched.stdout).toContain('0 pending device(s) would be removed');

    const result = runCli(
      ['cleanup-stale', '--pending-older-than-hours', '2'],
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 pending device(s) removed');
  });
});
