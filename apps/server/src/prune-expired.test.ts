import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from './auth/setup.js';
import {
  SessionRepository,
  SessionRepositoryError,
} from './auth/session-repository.js';
import { createRefreshSuccessor, generateRefreshToken } from './auth/tokens.js';
import { openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import {
  PRUNE_GRACE_MS,
  pruneExpiredRecords,
  startExpiredRecordPruning,
} from './prune-expired.js';

const START_TIME = '2026-07-15T03:00:00.000Z';
const DEVICE_ID = '70000000-0000-4000-8000-000000000001';
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface Fixture {
  readonly advance: (milliseconds: number) => void;
  readonly database: Database.Database;
  readonly familyId: string;
  readonly initialRefreshToken: string;
  readonly now: () => Date;
  readonly repository: SessionRepository;
}

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-prune-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);
  let milliseconds = Date.parse(START_TIME);
  const now = (): Date => new Date(milliseconds);
  const setup = new OwnerSetupService(database, {
    accessTokenTtlSeconds: 600,
    now,
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
    publicKey: Buffer.alloc(32, 0x7a),
  });
  return {
    advance: (value) => {
      milliseconds += value;
    },
    database,
    familyId: paired.familyId,
    initialRefreshToken,
    now,
    repository: new SessionRepository(database, {
      accessTokenTtlSeconds: 600,
      now,
    }),
  };
}

function rotate(fixture: Fixture, current: string): string {
  const successor = createRefreshSuccessor();
  fixture.repository.rotateRefresh({
    currentRefreshToken: current,
    rotationId: successor.rotationId,
    successorRefreshToken: successor.refreshToken,
  });
  return successor.refreshToken;
}

function count(database: Database.Database, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof SessionRepositoryError) {
      return error.code;
    }
    throw error;
  }
  return 'NO_ERROR';
}

function insertIdempotencyRecord(
  database: Database.Database,
  key: string,
  expiresAt: string,
): void {
  database
    .prepare(
      `INSERT INTO idempotency_records (
         device_id, idempotency_key, request_hash, response_status,
         response_body, created_at, expires_at
       ) VALUES (?, ?, ?, 200, '{}', ?, ?)`,
    )
    .run(DEVICE_ID, key, 'a'.repeat(64), START_TIME, expiresAt);
}

describe('pruneExpiredRecords', () => {
  it('drops access tokens a day past expiry and keeps an active family whole', () => {
    const fixture = makeFixture();
    // Pairing issued one access token; each rotation issues another and
    // consumes one refresh row. The family slides a day ahead each time.
    let current = rotate(fixture, fixture.initialRefreshToken);
    fixture.advance(12 * HOUR_MS);
    current = rotate(fixture, current);
    fixture.advance(12 * HOUR_MS + 11 * MINUTE_MS);
    rotate(fixture, current);

    expect(count(fixture.database, 'access_tokens')).toBe(4);
    expect(count(fixture.database, 'refresh_tokens')).toBe(4);

    const result = pruneExpiredRecords(fixture.database, fixture.now());

    // The pairing token and the first rotation's token expired at 03:10 on
    // the first day, more than a day ago; the other two are recent.
    expect(result).toEqual({
      accessTokens: 2,
      idempotencyRecords: 0,
      refreshTokens: 0,
    });
    expect(count(fixture.database, 'access_tokens')).toBe(2);
    expect(count(fixture.database, 'refresh_tokens')).toBe(4);

    // Reuse detection for the active family still sees the consumed
    // generation zero token and burns the family.
    expect(
      errorCode(() => rotate(fixture, fixture.initialRefreshToken)),
    ).toBe('REFRESH_REUSE_DETECTED');
    expect(
      fixture.database
        .prepare('SELECT status FROM refresh_token_families WHERE id = ?')
        .get(fixture.familyId),
    ).toEqual({ status: 'reuse-detected' });
  });

  it('keeps a revoked family until a day after its window ends, then drops its tokens', () => {
    const fixture = makeFixture();
    const current = rotate(fixture, fixture.initialRefreshToken);
    const revokedAt = fixture.now().toISOString();
    fixture.database
      .prepare(
        `UPDATE refresh_token_families SET status = 'revoked', revoked_at = ?
         WHERE id = ?`,
      )
      .run(revokedAt, fixture.familyId);
    fixture.database
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE family_id = ?')
      .run(revokedAt, fixture.familyId);

    fixture.advance(DAY_MS - MINUTE_MS);
    expect(pruneExpiredRecords(fixture.database, fixture.now())).toEqual({
      accessTokens: 0,
      idempotencyRecords: 0,
      refreshTokens: 0,
    });
    // While the window is open a replay still answers SESSION_REVOKED, which
    // the plugin treats as terminal.
    expect(errorCode(() => rotate(fixture, current))).toBe('SESSION_REVOKED');

    fixture.advance(PRUNE_GRACE_MS + 2 * MINUTE_MS);
    const before = errorCode(() => rotate(fixture, current));
    expect(pruneExpiredRecords(fixture.database, fixture.now())).toEqual({
      accessTokens: 2,
      idempotencyRecords: 0,
      refreshTokens: 2,
    });
    expect(count(fixture.database, 'refresh_tokens')).toBe(0);
    expect(count(fixture.database, 'access_tokens')).toBe(0);
    // An expired family already answered INVALID_REFRESH before its rows
    // went, so pruning changes nothing a client can observe.
    expect(before).toBe('INVALID_REFRESH');
    expect(errorCode(() => rotate(fixture, current))).toBe('INVALID_REFRESH');
  });

  it('drops idempotency records a day past their expiry and keeps the rest', () => {
    const fixture = makeFixture();
    const now = fixture.now().getTime();
    insertIdempotencyRecord(
      fixture.database,
      'long-gone',
      new Date(now - PRUNE_GRACE_MS - MINUTE_MS).toISOString(),
    );
    insertIdempotencyRecord(
      fixture.database,
      'just-expired',
      new Date(now - MINUTE_MS).toISOString(),
    );
    insertIdempotencyRecord(
      fixture.database,
      'live',
      new Date(now + HOUR_MS).toISOString(),
    );

    expect(pruneExpiredRecords(fixture.database, fixture.now())).toEqual({
      accessTokens: 0,
      idempotencyRecords: 1,
      refreshTokens: 0,
    });
    expect(
      fixture.database
        .prepare(
          'SELECT idempotency_key AS k FROM idempotency_records ORDER BY k',
        )
        .all(),
    ).toEqual([{ k: 'just-expired' }, { k: 'live' }]);
  });
});

describe('startExpiredRecordPruning', () => {
  it('prunes at start and on every interval until stopped', () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    const info = vi.fn();
    const pruning = startExpiredRecordPruning({
      database: fixture.database,
      intervalMs: HOUR_MS,
      logger: { error: vi.fn(), info },
      now: fixture.now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOUR_MS);
    expect(info).toHaveBeenCalledTimes(2);

    pruning.stop();
    vi.advanceTimersByTime(3 * HOUR_MS);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('logs a failing run and never throws out of the server', () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    fixture.database.close();
    const error = vi.fn();

    const pruning = startExpiredRecordPruning({
      database: fixture.database,
      intervalMs: HOUR_MS,
      logger: { error, info: vi.fn() },
      now: fixture.now,
    });
    expect(() => vi.advanceTimersByTime(HOUR_MS)).not.toThrow();

    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain('Pruning');
    pruning.stop();
  });
});
