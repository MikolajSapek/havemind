import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from './setup.js';
import {
  SessionRepository,
  SessionRepositoryError,
  type SessionRepositoryErrorCode,
} from './session-repository.js';
import {
  createRefreshSuccessor,
  generateRefreshToken,
  hashRefreshToken,
  parseAccessToken,
  parseRefreshToken,
} from './tokens.js';

const START_TIME = '2026-07-15T03:00:00.000Z';
const DEVICE_ID = '70000000-0000-4000-8000-000000000001';
const PUBLIC_KEY = Buffer.alloc(32, 0x7a);

interface MutableClock {
  readonly now: () => Date;
  advance(milliseconds: number): void;
}

interface SessionFixture {
  readonly accessToken: string;
  readonly clock: MutableClock;
  readonly database: Database.Database;
  readonly databasePath: string;
  readonly deviceId: string;
  readonly familyId: string;
  readonly initialRefreshToken: string;
  readonly repository: SessionRepository;
  readonly userId: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createClock(): MutableClock {
  let milliseconds = Date.parse(START_TIME);
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

function makeFixture(): SessionFixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-sessions-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'havemind.sqlite');
  const database = trackDatabase(openDatabase(databasePath));
  runMigrations(database);
  const clock = createClock();
  const setup = new OwnerSetupService(database, {
    accessTokenTtlSeconds: 600,
    now: clock.now,
    refreshTokenTtlSeconds: 24 * 60 * 60,
  });
  const initialized = setup.initializeOwner(createLocalOwnerSetupContext(), {
    ownerDisplayName: 'Mikolaj',
    vaultDisplayName: 'Havemind',
  });
  const initialRefreshToken = generateRefreshToken();
  const paired = setup.pairOwnerDevice({
    deviceDisplayName: 'MacBook',
    deviceId: DEVICE_ID,
    initialRefreshToken,
    pairingToken: initialized.pairingToken,
    publicKey: PUBLIC_KEY,
  });
  const repository = new SessionRepository(database, {
    accessTokenTtlSeconds: 600,
    now: clock.now,
  });
  return {
    accessToken: paired.accessToken,
    clock,
    database,
    databasePath,
    deviceId: paired.deviceId,
    familyId: paired.familyId,
    initialRefreshToken,
    repository,
    userId: paired.ownerUserId,
  };
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

function expectSessionCode(
  action: () => unknown,
  code: SessionRepositoryErrorCode,
): SessionRepositoryError {
  try {
    action();
    throw new Error(`Expected session error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRepositoryError);
    expect((error as SessionRepositoryError).code).toBe(code);
    return error as SessionRepositoryError;
  }
}

describe('SessionRepository', () => {
  it('rotates atomically and makes an identical response-loss retry idempotent', () => {
    const fixture = makeFixture();
    const successor = createRefreshSuccessor();

    const rotated = fixture.repository.rotateRefresh({
      currentRefreshToken: fixture.initialRefreshToken,
      rotationId: successor.rotationId,
      successorRefreshToken: successor.refreshToken,
    });
    expect(rotated.generation).toBe(1);
    expect(rotated.wasRetry).toBe(false);
    expect(parseAccessToken(rotated.accessToken)).toBe(rotated.accessToken);
    expect(fixture.repository.lookupAccess(rotated.accessToken)).toMatchObject({
      deviceId: fixture.deviceId,
      familyId: fixture.familyId,
      userId: fixture.userId,
    });

    const stored = fixture.database
      .prepare(
        `SELECT generation, token_hash AS tokenHash,
                consumed_at AS consumedAt, rotation_id AS rotationId,
                successor_token_hash AS successorTokenHash
         FROM refresh_tokens ORDER BY generation`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      consumedAt: START_TIME,
      generation: 0,
      rotationId: successor.rotationId,
      successorTokenHash: hashRefreshToken(
        parseRefreshToken(successor.refreshToken),
      ),
    });
    expect(stored[1]).toMatchObject({
      consumedAt: null,
      generation: 1,
      tokenHash: hashRefreshToken(parseRefreshToken(successor.refreshToken)),
    });
    expect(JSON.stringify(stored)).not.toContain(successor.refreshToken);

    const retried = fixture.repository.rotateRefresh({
      currentRefreshToken: fixture.initialRefreshToken,
      rotationId: successor.rotationId,
      successorRefreshToken: successor.refreshToken,
    });
    expect(retried.wasRetry).toBe(true);
    expect(retried.generation).toBe(1);
    expect(retried.accessToken).not.toBe(rotated.accessToken);
    expect(fixture.repository.lookupAccess(retried.accessToken)).not.toBeNull();
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM refresh_tokens')
        .get(),
    ).toEqual({ count: 2 });
  });

  it.each(['successor', 'rotation'] as const)(
    'revokes the family when a consumed token is reused with a different %s',
    (difference) => {
      const fixture = makeFixture();
      const first = createRefreshSuccessor();
      const rotated = fixture.repository.rotateRefresh({
        currentRefreshToken: fixture.initialRefreshToken,
        rotationId: first.rotationId,
        successorRefreshToken: first.refreshToken,
      });
      const other = createRefreshSuccessor();
      const error = expectSessionCode(
        () =>
          fixture.repository.rotateRefresh({
            currentRefreshToken: fixture.initialRefreshToken,
            rotationId:
              difference === 'rotation' ? other.rotationId : first.rotationId,
            successorRefreshToken:
              difference === 'successor' ? other.refreshToken : first.refreshToken,
          }),
        'REFRESH_REUSE_DETECTED',
      );
      expect(
        fixture.database
          .prepare(
            `SELECT status, revoked_at AS revokedAt
             FROM refresh_token_families WHERE id = ?`,
          )
          .get(fixture.familyId),
      ).toEqual({ revokedAt: START_TIME, status: 'reuse-detected' });
      expect(fixture.repository.lookupAccess(fixture.accessToken)).toBeNull();
      expect(fixture.repository.lookupAccess(rotated.accessToken)).toBeNull();
      const serialized = [error.message, error.stack, JSON.stringify(error)].join(
        '\n',
      );
      expect(serialized).not.toContain(fixture.initialRefreshToken);
      expect(serialized).not.toContain(other.refreshToken);
    },
  );

  it('treats a late retry after another generation as reuse', () => {
    const fixture = makeFixture();
    const first = createRefreshSuccessor();
    fixture.repository.rotateRefresh({
      currentRefreshToken: fixture.initialRefreshToken,
      rotationId: first.rotationId,
      successorRefreshToken: first.refreshToken,
    });
    const second = createRefreshSuccessor();
    fixture.repository.rotateRefresh({
      currentRefreshToken: first.refreshToken,
      rotationId: second.rotationId,
      successorRefreshToken: second.refreshToken,
    });

    expectSessionCode(
      () =>
        fixture.repository.rotateRefresh({
          currentRefreshToken: fixture.initialRefreshToken,
          rotationId: first.rotationId,
          successorRefreshToken: first.refreshToken,
        }),
      'REFRESH_REUSE_DETECTED',
    );
    expect(
      fixture.database
        .prepare('SELECT status FROM refresh_token_families')
        .get(),
    ).toEqual({ status: 'reuse-detected' });
  });

  it('revokes the family when a fresh successor collides with an existing token hash', () => {
    const fixture = makeFixture();
    const first = createRefreshSuccessor();
    fixture.repository.rotateRefresh({
      currentRefreshToken: fixture.initialRefreshToken,
      rotationId: first.rotationId,
      successorRefreshToken: first.refreshToken,
    });

    // Rotate the live successor forward while re-proposing the original token
    // (generation zero) as the new successor: its hash already exists.
    expectSessionCode(
      () =>
        fixture.repository.rotateRefresh({
          currentRefreshToken: first.refreshToken,
          rotationId: createRefreshSuccessor().rotationId,
          successorRefreshToken: fixture.initialRefreshToken,
        }),
      'REFRESH_REUSE_DETECTED',
    );
    expect(
      fixture.database
        .prepare('SELECT status FROM refresh_token_families')
        .get(),
    ).toEqual({ status: 'reuse-detected' });
    expect(fixture.repository.lookupAccess(fixture.accessToken)).toBeNull();
  });

  it('revokes the family when a live token is presented at a stale generation', () => {
    const fixture = makeFixture();
    // Force the family ahead of its only live token without consuming it, the
    // durability-corruption guard that must still fail closed into a revocation.
    fixture.database
      .prepare(
        `UPDATE refresh_token_families SET current_generation = 1
         WHERE id = ?`,
      )
      .run(fixture.familyId);
    const successor = createRefreshSuccessor();

    expectSessionCode(
      () =>
        fixture.repository.rotateRefresh({
          currentRefreshToken: fixture.initialRefreshToken,
          rotationId: successor.rotationId,
          successorRefreshToken: successor.refreshToken,
        }),
      'REFRESH_REUSE_DETECTED',
    );
    expect(
      fixture.database
        .prepare('SELECT status FROM refresh_token_families')
        .get(),
    ).toEqual({ status: 'reuse-detected' });
  });

  it('rolls an interrupted rotation back and can safely retry after restart', () => {
    const fixture = makeFixture();
    const successor = createRefreshSuccessor();
    fixture.database.exec(`
      CREATE TRIGGER fail_rotated_access
      BEFORE INSERT ON access_tokens
      BEGIN
        SELECT RAISE(ABORT, 'rotation-access-write-failure');
      END;
    `);
    expect(() =>
      fixture.repository.rotateRefresh({
        currentRefreshToken: fixture.initialRefreshToken,
        rotationId: successor.rotationId,
        successorRefreshToken: successor.refreshToken,
      }),
    ).toThrow('rotation-access-write-failure');
    expect(
      fixture.database
        .prepare(
          `SELECT current_generation AS generation, status
           FROM refresh_token_families`,
        )
        .get(),
    ).toEqual({ generation: 0, status: 'active' });
    expect(
      fixture.database
        .prepare(
          `SELECT consumed_at AS consumedAt, rotation_id AS rotationId
           FROM refresh_tokens`,
        )
        .get(),
    ).toEqual({ consumedAt: null, rotationId: null });

    fixture.database.exec('DROP TRIGGER fail_rotated_access');
    fixture.database.close();
    const reopened = trackDatabase(openDatabase(fixture.databasePath));
    runMigrations(reopened);
    const restarted = new SessionRepository(reopened, {
      accessTokenTtlSeconds: 600,
      now: fixture.clock.now,
    });
    const result = restarted.rotateRefresh({
      currentRefreshToken: fixture.initialRefreshToken,
      rotationId: successor.rotationId,
      successorRefreshToken: successor.refreshToken,
    });
    expect(result.wasRetry).toBe(false);
    expect(restarted.lookupAccess(result.accessToken)).not.toBeNull();
  });

  it('rejects access after expiry or an inactive principal', () => {
    const fixture = makeFixture();
    fixture.clock.advance(600 * 1_000 + 1);
    expect(fixture.repository.lookupAccess(fixture.accessToken)).toBeNull();

    const states = [
      `UPDATE users SET status = 'revoked', revoked_at = '${START_TIME}'`,
      `UPDATE devices SET status = 'revoked', revoked_at = '${START_TIME}'`,
      `UPDATE refresh_token_families SET status = 'revoked', revoked_at = '${START_TIME}'`,
    ];
    for (const statement of states) {
      const current = makeFixture();
      current.database.exec(statement);
      expect(current.repository.lookupAccess(current.accessToken)).toBeNull();
    }
    expect(fixture.repository.lookupAccess('not-an-access-token')).toBeNull();
  });

  it('revokes one family or all sessions belonging to a device', () => {
    const session = makeFixture();
    session.repository.revokeSession(session.familyId);
    expect(session.repository.lookupAccess(session.accessToken)).toBeNull();
    expect(
      session.database
        .prepare('SELECT status FROM refresh_token_families WHERE id = ?')
        .get(session.familyId),
    ).toEqual({ status: 'revoked' });

    const device = makeFixture();
    device.repository.revokeDevice(device.deviceId);
    expect(device.repository.lookupAccess(device.accessToken)).toBeNull();
    expect(
      device.database
        .prepare('SELECT status FROM devices WHERE id = ?')
        .get(device.deviceId),
    ).toEqual({ status: 'revoked' });
    expectSessionCode(
      () => device.repository.revokeDevice('not-a-uuid'),
      'INVALID_INPUT',
    );
    expectSessionCode(
      () =>
        device.repository.revokeSession(
          '70000000-0000-4000-8000-000000000099',
        ),
      'NOT_FOUND',
    );
  });

  it('validates token inputs, TTL, and the clock with secret-free errors', () => {
    const fixture = makeFixture();
    const successor = createRefreshSuccessor();
    const secret = 'hm_rt_SECRET_MUST_NOT_LEAK';
    const error = expectSessionCode(
      () =>
        fixture.repository.rotateRefresh({
          currentRefreshToken: secret,
          rotationId: successor.rotationId,
          successorRefreshToken: successor.refreshToken,
        }),
      'INVALID_REFRESH',
    );
    expect([error.message, error.stack, JSON.stringify(error)].join('\n')).not.toContain(
      secret,
    );
    expectSessionCode(
      () =>
        fixture.repository.rotateRefresh({
          currentRefreshToken: fixture.initialRefreshToken,
          rotationId: 'invalid-rotation',
          successorRefreshToken: successor.refreshToken,
        }),
      'INVALID_INPUT',
    );
    expect(
      () => new SessionRepository(fixture.database, { accessTokenTtlSeconds: 599 }),
    ).toThrow(SessionRepositoryError);

    const invalidClock = new SessionRepository(fixture.database, {
      now: () => new Date(Number.NaN),
    });
    expectSessionCode(
      () =>
        invalidClock.rotateRefresh({
          currentRefreshToken: fixture.initialRefreshToken,
          rotationId: successor.rotationId,
          successorRefreshToken: successor.refreshToken,
        }),
      'INVALID_CLOCK',
    );
  });

  it('property: identical replay is idempotent, any divergence revokes the family', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        (divergeRotation, divergeSuccessor) => {
          const fixture = makeFixture();
          try {
            const first = createRefreshSuccessor();
            const rotated = fixture.repository.rotateRefresh({
              currentRefreshToken: fixture.initialRefreshToken,
              rotationId: first.rotationId,
              successorRefreshToken: first.refreshToken,
            });
            const other = createRefreshSuccessor();
            const replay = {
              currentRefreshToken: fixture.initialRefreshToken,
              rotationId: divergeRotation ? other.rotationId : first.rotationId,
              successorRefreshToken: divergeSuccessor
                ? other.refreshToken
                : first.refreshToken,
            };
            const readFamilyStatus = (): unknown =>
              fixture.database
                .prepare('SELECT status FROM refresh_token_families')
                .get();

            if (!divergeRotation && !divergeSuccessor) {
              const retried = fixture.repository.rotateRefresh(replay);
              expect(retried.wasRetry).toBe(true);
              expect(retried.generation).toBe(1);
              expect(
                fixture.repository.lookupAccess(retried.accessToken),
              ).not.toBeNull();
              expect(readFamilyStatus()).toEqual({ status: 'active' });
            } else {
              expectSessionCode(
                () => fixture.repository.rotateRefresh(replay),
                'REFRESH_REUSE_DETECTED',
              );
              expect(readFamilyStatus()).toEqual({ status: 'reuse-detected' });
              expect(
                fixture.repository.lookupAccess(fixture.accessToken),
              ).toBeNull();
              expect(
                fixture.repository.lookupAccess(rotated.accessToken),
              ).toBeNull();
            }
          } finally {
            fixture.database.close();
          }
        },
      ),
      { numRuns: 1_000 },
    );
  }, 120_000);
});
