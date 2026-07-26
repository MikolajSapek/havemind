import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  OwnerSetupError,
  OwnerSetupService,
  createLocalOwnerSetupContext,
  type OwnerSetupErrorCode,
} from './setup.js';
import { SessionRepository } from './session-repository.js';
import {
  generateRefreshToken,
  hashAccessToken,
  hashPairingToken,
  hashRefreshToken,
  parseAccessToken,
  parsePairingToken,
  parseRefreshToken,
} from './tokens.js';

const START_TIME = '2026-07-15T03:00:00.000Z';
const DEVICE_ID = '70000000-0000-4000-8000-000000000001';
const PUBLIC_KEY = Buffer.alloc(32, 0x7a);

interface MutableClock {
  readonly now: () => Date;
  advance(milliseconds: number): void;
}

interface SetupFixture {
  readonly clock: MutableClock;
  readonly database: Database.Database;
  readonly service: OwnerSetupService;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createClock(initial = START_TIME): MutableClock {
  let milliseconds = Date.parse(initial);
  return {
    advance(value): void {
      milliseconds += value;
    },
    now: () => new Date(milliseconds),
  };
}

function trackDatabase(database: Database.Database): Database.Database {
  databases.push(database);
  return database;
}

function makeFixture(): SetupFixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-owner-setup-'));
  temporaryDirectories.push(directory);
  const database = trackDatabase(openDatabase(join(directory, 'havemind.sqlite')));
  runMigrations(database);
  const clock = createClock();
  const service = new OwnerSetupService(database, {
    accessTokenTtlSeconds: 600,
    now: clock.now,
    refreshTokenTtlSeconds: 24 * 60 * 60,
  });
  return { clock, database, service };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function initialize(service: OwnerSetupService) {
  return service.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Mikolaj',
    vaultDisplayName: 'Havemind',
  });
}

function expectSetupCode(
  action: () => unknown,
  code: OwnerSetupErrorCode,
): OwnerSetupError {
  try {
    action();
    throw new Error(`Expected setup error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerSetupError);
    expect((error as OwnerSetupError).code).toBe(code);
    return error as OwnerSetupError;
  }
}

function count(database: Database.Database, table: string): number {
  const allowed = new Set([
    'access_tokens',
    'devices',
    'instance_state',
    'memberships',
    'owner_pairings',
    'refresh_token_families',
    'refresh_tokens',
    'users',
    'vaults',
  ]);
  if (!allowed.has(table)) {
    throw new Error('Unexpected test table.');
  }
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

describe('OwnerSetupService', () => {
  it('requires a non-serializable local CLI capability and initializes once', () => {
    const { database, service } = makeFixture();

    expectSetupCode(
      () =>
        service.initializeOwner({ kind: 'local-cli' } as never, {
          ownerDisplayName: 'Mikolaj',
          vaultDisplayName: 'Havemind',
        }),
      'LOCAL_CONTEXT_REQUIRED',
    );
    expect(count(database, 'instance_state')).toBe(0);

    const result = initialize(service);
    expect(parsePairingToken(result.pairingToken)).toBe(result.pairingToken);
    expect(result.pairingExpiresAt).toBe('2026-07-15T03:15:00.000Z');
    expect(result.instanceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.serverEpoch).toMatch(/^[0-9a-f-]{36}$/u);

    expect(count(database, 'instance_state')).toBe(1);
    expect(count(database, 'users')).toBe(1);
    expect(count(database, 'vaults')).toBe(1);
    expect(count(database, 'memberships')).toBe(1);
    expect(count(database, 'owner_pairings')).toBe(1);
    expect(
      database
        .prepare(
          `SELECT is_instance_owner AS isOwner, status
           FROM users WHERE id = ?`,
        )
        .get(result.ownerUserId),
    ).toEqual({ isOwner: 1, status: 'active' });
    expect(
      database
        .prepare('SELECT role, status FROM memberships WHERE id = ?')
        .get(result.membershipId),
    ).toEqual({ role: 'owner', status: 'active' });

    const pairing = database
      .prepare(
        `SELECT token_hash AS tokenHash, consumed_at AS consumedAt
         FROM owner_pairings`,
      )
      .get() as { consumedAt: string | null; tokenHash: string };
    expect(pairing.tokenHash).toBe(
      hashPairingToken(parsePairingToken(result.pairingToken)),
    );
    expect(pairing.consumedAt).toBeNull();
    expect(JSON.stringify(pairing)).not.toContain(result.pairingToken);

    expectSetupCode(() => initialize(service), 'ALREADY_INITIALIZED');
    expect(count(database, 'owner_pairings')).toBe(1);
  });

  it('rolls the entire initialization back when its final insert fails', () => {
    const { database, service } = makeFixture();
    database.exec(`
      CREATE TRIGGER fail_owner_pairing
      BEFORE INSERT ON owner_pairings
      BEGIN
        SELECT RAISE(ABORT, 'owner-pairing-write-failure');
      END;
    `);

    expect(() => initialize(service)).toThrow('owner-pairing-write-failure');
    for (const table of [
      'instance_state',
      'users',
      'vaults',
      'memberships',
      'owner_pairings',
    ]) {
      expect(count(database, table)).toBe(0);
    }

    database.exec('DROP TRIGGER fail_owner_pairing');
    expect(initialize(service).ownerUserId).toBeDefined();
  });

  it('pairs one approved owner device and stores only token hashes', () => {
    const { clock, database, service } = makeFixture();
    const initialized = initialize(service);
    const initialRefreshToken = generateRefreshToken();

    const paired = service.pairOwnerDevice({
      deviceDisplayName: 'MacBook',
      deviceId: DEVICE_ID,
      initialRefreshToken,
      pairingToken: initialized.pairingToken,
      publicKey: PUBLIC_KEY,
    });

    expect(parseAccessToken(paired.accessToken)).toBe(paired.accessToken);
    expect(paired.accessExpiresAt).toBe('2026-07-15T03:10:00.000Z');
    expect(paired.refreshExpiresAt).toBe('2026-07-16T03:00:00.000Z');
    expect(paired.deviceId).toBe(DEVICE_ID);
    expect(paired.ownerUserId).toBe(initialized.ownerUserId);

    const device = database
      .prepare(
        `SELECT status, public_key AS publicKey
         FROM devices WHERE id = ?`,
      )
      .get(DEVICE_ID) as { publicKey: Buffer; status: string };
    expect(device.status).toBe('approved');
    expect(device.publicKey).toEqual(PUBLIC_KEY);

    const family = database
      .prepare(
        `SELECT status, current_generation AS generation
         FROM refresh_token_families WHERE id = ?`,
      )
      .get(paired.familyId);
    expect(family).toEqual({ generation: 0, status: 'active' });
    const refresh = database
      .prepare(
        `SELECT token_hash AS tokenHash, consumed_at AS consumedAt
         FROM refresh_tokens`,
      )
      .get() as { consumedAt: string | null; tokenHash: string };
    expect(refresh.tokenHash).toBe(
      hashRefreshToken(parseRefreshToken(initialRefreshToken)),
    );
    expect(refresh.consumedAt).toBeNull();
    const access = database
      .prepare('SELECT token_hash AS tokenHash FROM access_tokens')
      .get() as { tokenHash: string };
    expect(access.tokenHash).toBe(
      hashAccessToken(parseAccessToken(paired.accessToken)),
    );

    const serializedRows = JSON.stringify({ access, refresh });
    expect(serializedRows).not.toContain(initialRefreshToken);
    expect(serializedRows).not.toContain(paired.accessToken);
    const pairing = database
      .prepare(
        `SELECT consumed_at AS consumedAt,
                consumed_by_device_id AS consumedByDeviceId
         FROM owner_pairings`,
      )
      .get();
    expect(pairing).toEqual({
      consumedAt: START_TIME,
      consumedByDeviceId: DEVICE_ID,
    });

    const sessions = new SessionRepository(database, {
      accessTokenTtlSeconds: 600,
      now: clock.now,
    });
    expect(sessions.lookupAccess(paired.accessToken)).toMatchObject({
      deviceId: DEVICE_ID,
      familyId: paired.familyId,
      userId: initialized.ownerUserId,
    });
    expectSetupCode(
      () =>
        service.pairOwnerDevice({
          deviceDisplayName: 'Second device',
          deviceId: '70000000-0000-4000-8000-000000000002',
          initialRefreshToken: generateRefreshToken(),
          pairingToken: initialized.pairingToken,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_PAIRING',
    );
    expect(count(database, 'devices')).toBe(1);
  });

  it('rejects expired or malformed pairing tokens without exposing them', () => {
    const { clock, service } = makeFixture();
    const initialized = initialize(service);
    clock.advance(15 * 60 * 1_000 + 1);

    const expired = expectSetupCode(
      () =>
        service.pairOwnerDevice({
          deviceDisplayName: 'MacBook',
          deviceId: DEVICE_ID,
          initialRefreshToken: generateRefreshToken(),
          pairingToken: initialized.pairingToken,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_PAIRING',
    );
    expect(JSON.stringify(expired)).not.toContain(initialized.pairingToken);

    const malformed = 'hm_pt_SECRET_MUST_NOT_LEAK';
    const invalid = expectSetupCode(
      () =>
        service.pairOwnerDevice({
          deviceDisplayName: 'MacBook',
          deviceId: DEVICE_ID,
          initialRefreshToken: generateRefreshToken(),
          pairingToken: malformed,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_PAIRING',
    );
    expect([invalid.message, invalid.stack, JSON.stringify(invalid)].join('\n')).not.toContain(
      malformed,
    );
  });

  it('rolls pairing back completely when access issuance fails', () => {
    const { database, service } = makeFixture();
    const initialized = initialize(service);
    const initialRefreshToken = generateRefreshToken();
    const input = {
      deviceDisplayName: 'MacBook',
      deviceId: DEVICE_ID,
      initialRefreshToken,
      pairingToken: initialized.pairingToken,
      publicKey: PUBLIC_KEY,
    };
    database.exec(`
      CREATE TRIGGER fail_access_issue
      BEFORE INSERT ON access_tokens
      BEGIN
        SELECT RAISE(ABORT, 'access-write-failure');
      END;
    `);

    expect(() => service.pairOwnerDevice(input)).toThrow('access-write-failure');
    for (const table of [
      'devices',
      'refresh_token_families',
      'refresh_tokens',
      'access_tokens',
    ]) {
      expect(count(database, table)).toBe(0);
    }
    expect(
      database
        .prepare('SELECT consumed_at AS consumedAt FROM owner_pairings')
        .get(),
    ).toEqual({ consumedAt: null });

    database.exec('DROP TRIGGER fail_access_issue');
    expect(service.pairOwnerDevice(input).deviceId).toBe(DEVICE_ID);
  });

  it('validates display names, generated UUIDs, device IDs, keys, and clocks', () => {
    const { clock, database, service } = makeFixture();
    for (const ownerDisplayName of ['', ' padded ', 'x'.repeat(81), 'line\nbreak']) {
      expectSetupCode(
        () =>
          service.initializeOwner(createLocalOwnerSetupContext(), {
            ownerDisplayName,
            vaultDisplayName: 'Havemind',
          }),
        'INVALID_INPUT',
      );
    }
    expect(count(database, 'instance_state')).toBe(0);

    const badUuidService = new OwnerSetupService(database, {
      now: clock.now,
      randomUuid: () => 'not-a-uuid',
    });
    expectSetupCode(() => initialize(badUuidService), 'INVALID_INPUT');
    const initialized = initialize(service);
    const validRefresh = generateRefreshToken();
    const invalidInputs = [
      { deviceId: 'not-a-uuid' },
      { deviceDisplayName: ' padded ' },
      { publicKey: Buffer.alloc(31, 1) },
      { publicKey: Buffer.alloc(32) },
    ];
    for (const override of invalidInputs) {
      expectSetupCode(
        () =>
          service.pairOwnerDevice({
            deviceDisplayName: 'MacBook',
            deviceId: DEVICE_ID,
            initialRefreshToken: validRefresh,
            pairingToken: initialized.pairingToken,
            publicKey: PUBLIC_KEY,
            ...override,
          }),
        'INVALID_INPUT',
      );
    }
    expect(count(database, 'devices')).toBe(0);

    const invalidClock = new OwnerSetupService(database, {
      now: () => new Date(Number.NaN),
    });
    expectSetupCode(
      () =>
        invalidClock.pairOwnerDevice({
          deviceDisplayName: 'MacBook',
          deviceId: DEVICE_ID,
          initialRefreshToken: validRefresh,
          pairingToken: initialized.pairingToken,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_CLOCK',
    );
  });
});

describe('OwnerSetupService.createVault', () => {
  const NEW_DEVICE = '70000000-0000-4000-8000-000000000003';

  function createSecondVault(service: OwnerSetupService) {
    return service.createVault({
      ownerDisplayName: 'Magda',
      vaultDisplayName: 'Second vault',
    });
  }

  it('creates an independent, non-instance-owner vault with a working pairing token', () => {
    const { database, service } = makeFixture();
    const owner = initialize(service);

    const created = createSecondVault(service);
    expect(created.vaultId).not.toBe(undefined);
    expect(created.ownerUserId).not.toBe(owner.ownerUserId);
    expect(parsePairingToken(created.pairingToken)).toBe(created.pairingToken);

    // The new owner is NOT the instance owner and is active.
    expect(
      database
        .prepare(
          `SELECT is_instance_owner AS isOwner, status
           FROM users WHERE id = ?`,
        )
        .get(created.ownerUserId),
    ).toEqual({ isOwner: 0, status: 'active' });

    // An active owner-role membership links the new user to the new vault.
    expect(
      database
        .prepare(
          `SELECT role, status, vault_id AS vaultId, user_id AS userId
           FROM memberships WHERE id = ?`,
        )
        .get(created.membershipId),
    ).toEqual({
      role: 'owner',
      status: 'active',
      userId: created.ownerUserId,
      vaultId: created.vaultId,
    });

    // The single instance owner and their first vault are untouched.
    expect(count(database, 'users')).toBe(2);
    expect(count(database, 'vaults')).toBe(2);
    expect(count(database, 'memberships')).toBe(2);
    expect(count(database, 'owner_pairings')).toBe(2);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM users
           WHERE is_instance_owner = 1 AND status = 'active'`,
        )
        .get(),
    ).toEqual({ count: 1 });

    // The minted pairing token is stored only as a hash, never in plaintext.
    const pairing = database
      .prepare(
        `SELECT token_hash AS tokenHash, consumed_at AS consumedAt
         FROM owner_pairings WHERE user_id = ?`,
      )
      .get(created.ownerUserId) as {
      consumedAt: string | null;
      tokenHash: string;
    };
    expect(pairing.tokenHash).toBe(
      hashPairingToken(parsePairingToken(created.pairingToken)),
    );
    expect(pairing.consumedAt).toBeNull();
    expect(JSON.stringify(pairing)).not.toContain(created.pairingToken);
  });

  it('rejects create-vault before the instance owner is initialized', () => {
    const { database, service } = makeFixture();
    expectSetupCode(() => createSecondVault(service), 'NOT_INITIALIZED');
    expect(count(database, 'vaults')).toBe(0);
  });

  it('mints a single-use pairing token that pairs once then cannot be reused', () => {
    const { database, service } = makeFixture();
    initialize(service);
    const created = createSecondVault(service);

    const paired = service.pairOwnerDevice({
      deviceDisplayName: 'Magda laptop',
      deviceId: NEW_DEVICE,
      initialRefreshToken: generateRefreshToken(),
      pairingToken: created.pairingToken,
      publicKey: PUBLIC_KEY,
    });
    expect(paired.ownerUserId).toBe(created.ownerUserId);

    expectSetupCode(
      () =>
        service.pairOwnerDevice({
          deviceDisplayName: 'Magda phone',
          deviceId: '70000000-0000-4000-8000-000000000004',
          initialRefreshToken: generateRefreshToken(),
          pairingToken: created.pairingToken,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_PAIRING',
    );
    expect(count(database, 'devices')).toBe(1);
  });

  it('validates display names exactly like owner setup does', () => {
    const { database, service } = makeFixture();
    initialize(service);
    for (const ownerDisplayName of ['', ' padded ', 'x'.repeat(81), 'line\nbreak']) {
      expectSetupCode(
        () =>
          service.createVault({
            ownerDisplayName,
            vaultDisplayName: 'Second vault',
          }),
        'INVALID_INPUT',
      );
    }
    for (const vaultDisplayName of ['', ' padded ', 'x'.repeat(81), 'line\nbreak']) {
      expectSetupCode(
        () =>
          service.createVault({
            ownerDisplayName: 'Magda',
            vaultDisplayName,
          }),
        'INVALID_INPUT',
      );
    }
    // No partial rows leaked from the rejected attempts.
    expect(count(database, 'vaults')).toBe(1);
    expect(count(database, 'users')).toBe(1);
  });
});

describe('OwnerSetupService.rotateOwnerPairing', () => {
  const SECOND_DEVICE = '70000000-0000-4000-8000-000000000002';

  it('invalidates the old pairing token and issues a working fresh one', () => {
    const { database, service } = makeFixture();
    const initial = initialize(service);

    const rotated = service.rotateOwnerPairing(createLocalOwnerSetupContext());
    expect(rotated.pairingToken).not.toBe(initial.pairingToken);
    expect(rotated.ownerUserId).toBe(initial.ownerUserId);

    // The old token no longer pairs.
    expectSetupCode(
      () =>
        service.pairOwnerDevice({
          deviceDisplayName: 'Old device',
          deviceId: DEVICE_ID,
          initialRefreshToken: generateRefreshToken(),
          pairingToken: initial.pairingToken,
          publicKey: PUBLIC_KEY,
        }),
      'INVALID_PAIRING',
    );

    // The fresh token pairs the owner's device.
    const paired = service.pairOwnerDevice({
      deviceDisplayName: 'New device',
      deviceId: SECOND_DEVICE,
      initialRefreshToken: generateRefreshToken(),
      pairingToken: rotated.pairingToken,
      publicKey: PUBLIC_KEY,
    });
    expect(paired.ownerUserId).toBe(initial.ownerUserId);

    // Vault and membership data are untouched; exactly one pairing remains
    // unconsumed → consumed by the successful pair above.
    expect(count(database, 'vaults')).toBe(1);
    expect(count(database, 'memberships')).toBe(1);
  });

  it('rejects rotation before the owner is initialized', () => {
    const { service } = makeFixture();
    expectSetupCode(
      () => service.rotateOwnerPairing(createLocalOwnerSetupContext()),
      'NOT_INITIALIZED',
    );
  });

  it('requires the non-serializable local CLI capability', () => {
    const { service } = makeFixture();
    initialize(service);
    expectSetupCode(
      () => service.rotateOwnerPairing({ kind: 'local-cli' } as never),
      'LOCAL_CONTEXT_REQUIRED',
    );
  });
});
