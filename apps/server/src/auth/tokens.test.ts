import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ACCESS_TOKEN_MAX_TTL_SECONDS,
  ACCESS_TOKEN_MIN_TTL_SECONDS,
  REFRESH_TOKEN_MAX_TTL_SECONDS,
  TokenPrimitiveError,
  createRefreshSuccessor,
  generateAccessToken,
  generateInvitationToken,
  generatePairingToken,
  generateRefreshToken,
  generateRejoinSecret,
  hashRejoinSecret,
  parseRejoinSecret,
  rejoinSecretMatchesHash,
  hashAccessToken,
  hashInvitationToken,
  hashPairingToken,
  hashRefreshToken,
  parseAccessToken,
  parseInvitationToken,
  parsePairingToken,
  parseRefreshRotationId,
  parseRefreshToken,
  tokenHashesEqual,
  validateAccessTokenTtl,
  validateRefreshTokenTtl,
  type AccessToken,
  type InvitationToken,
  type PairingToken,
  type RefreshRotationId,
  type RefreshToken,
} from './tokens.js';

const ZERO_PAYLOAD = 'A'.repeat(43);
const FIXED_ACCESS_TOKEN = `hm_at_${ZERO_PAYLOAD}`;
const FIXED_REFRESH_TOKEN = `hm_rt_${ZERO_PAYLOAD}`;
const FIXED_PAIRING_TOKEN = `hm_pt_${ZERO_PAYLOAD}`;
const FIXED_INVITATION_TOKEN = `hm_it_${ZERO_PAYLOAD}`;

function payloadBytes(token: string, prefix: string): Buffer {
  return Buffer.from(token.slice(prefix.length), 'base64url');
}

function captureError(action: () => unknown): Error {
  try {
    action();
    throw new Error('Expected token primitive to throw.');
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error;
  }
}

describe('token primitives', () => {
  it('generates unique canonical 256-bit tokens in every domain', () => {
    const cases = [
      ['hm_at_', generateAccessToken],
      ['hm_rt_', generateRefreshToken],
      ['hm_pt_', generatePairingToken],
      ['hm_it_', generateInvitationToken],
    ] as const;

    for (const [prefix, generate] of cases) {
      const generated = Array.from({ length: 128 }, () => generate());
      expect(new Set(generated).size).toBe(generated.length);

      for (const token of generated) {
        expect(token).toMatch(
          new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`, 'u'),
        );
        expect(token).not.toContain('=');
        expect(payloadBytes(token, prefix)).toHaveLength(32);
      }
    }
  });

  it('parses only exact canonical base64url encodings without normalization', () => {
    expect(parseAccessToken(FIXED_ACCESS_TOKEN)).toBe(FIXED_ACCESS_TOKEN);

    const invalid = [
      ` ${FIXED_ACCESS_TOKEN}`,
      `${FIXED_ACCESS_TOKEN} `,
      `${FIXED_ACCESS_TOKEN}=`,
      'HM_AT_' + ZERO_PAYLOAD,
      'hm_at_' + 'A'.repeat(42),
      'hm_at_' + 'A'.repeat(44),
      'hm_at_' + 'A'.repeat(42) + '+',
      'hm_at_' + 'A'.repeat(42) + '/',
      'hm_at_' + 'A'.repeat(42) + 'B',
      'hm_at_' + 'ą'.repeat(43),
    ];

    for (const token of invalid) {
      expect(() => parseAccessToken(token)).toThrow(TokenPrimitiveError);
    }
  });

  it('enforces runtime domain separation', () => {
    expect(() => parseAccessToken(FIXED_REFRESH_TOKEN)).toThrow(
      TokenPrimitiveError,
    );
    expect(() => parseRefreshToken(FIXED_PAIRING_TOKEN)).toThrow(
      TokenPrimitiveError,
    );
    expect(() => parsePairingToken(FIXED_INVITATION_TOKEN)).toThrow(
      TokenPrimitiveError,
    );
    expect(() => parseInvitationToken(FIXED_ACCESS_TOKEN)).toThrow(
      TokenPrimitiveError,
    );
  });

  it('exposes distinct compile-time brands for every secret domain', () => {
    expectTypeOf(parseAccessToken(FIXED_ACCESS_TOKEN)).toEqualTypeOf<AccessToken>();
    expectTypeOf(parseRefreshToken(FIXED_REFRESH_TOKEN)).toEqualTypeOf<RefreshToken>();
    expectTypeOf(parsePairingToken(FIXED_PAIRING_TOKEN)).toEqualTypeOf<PairingToken>();
    expectTypeOf(
      parseInvitationToken(FIXED_INVITATION_TOKEN),
    ).toEqualTypeOf<InvitationToken>();

    expectTypeOf<AccessToken>().not.toEqualTypeOf<RefreshToken>();
    expectTypeOf<RefreshToken>().not.toEqualTypeOf<PairingToken>();
    expectTypeOf<PairingToken>().not.toEqualTypeOf<InvitationToken>();
  });

  it('matches a stable SHA-256 vector and separates hashes by token domain', () => {
    const accessHash = hashAccessToken(parseAccessToken(FIXED_ACCESS_TOKEN));
    const refreshHash = hashRefreshToken(
      parseRefreshToken(FIXED_REFRESH_TOKEN),
    );

    expect(accessHash).toBe(
      '3119e45d93f49ba0eee60f9a911b32c604117cd9231d10c6211f1dd51f15ef07',
    );
    expect(accessHash).not.toBe(refreshHash);
    expect(hashPairingToken(parsePairingToken(FIXED_PAIRING_TOKEN))).not.toBe(
      accessHash,
    );
    expect(
      hashInvitationToken(parseInvitationToken(FIXED_INVITATION_TOKEN)),
    ).not.toBe(accessHash);
  });

  it('refuses to hash a malformed value even if its TypeScript brand is forged', () => {
    expect(() =>
      hashRefreshToken('hm_rt_not-canonical' as RefreshToken),
    ).toThrow(TokenPrimitiveError);
  });

  it('compares only fixed-length lowercase SHA-256 hashes', () => {
    const accessHash = hashAccessToken(parseAccessToken(FIXED_ACCESS_TOKEN));
    const same = hashAccessToken(parseAccessToken(FIXED_ACCESS_TOKEN));
    const different = hashRefreshToken(
      parseRefreshToken(FIXED_REFRESH_TOKEN),
    );

    expect(tokenHashesEqual(accessHash, same)).toBe(true);
    expect(tokenHashesEqual(accessHash, different)).toBe(false);
    expect(() => tokenHashesEqual(accessHash, 'a'.repeat(63))).toThrow(
      TokenPrimitiveError,
    );
    expect(() => tokenHashesEqual(accessHash, 'A'.repeat(64))).toThrow(
      TokenPrimitiveError,
    );
  });

  it('validates access TTL between 10 and 15 minutes inclusively', () => {
    expect(validateAccessTokenTtl(ACCESS_TOKEN_MIN_TTL_SECONDS)).toBe(600);
    expect(validateAccessTokenTtl(ACCESS_TOKEN_MAX_TTL_SECONDS)).toBe(900);

    for (const invalid of [599, 901, 600.5, Number.NaN]) {
      expect(() => validateAccessTokenTtl(invalid)).toThrow(
        TokenPrimitiveError,
      );
    }
  });

  it('validates positive refresh TTL up to 30 days inclusively', () => {
    expect(validateRefreshTokenTtl(1)).toBe(1);
    expect(validateRefreshTokenTtl(REFRESH_TOKEN_MAX_TTL_SECONDS)).toBe(
      30 * 24 * 60 * 60,
    );

    for (const invalid of [0, -1, REFRESH_TOKEN_MAX_TTL_SECONDS + 1, 1.5]) {
      expect(() => validateRefreshTokenTtl(invalid)).toThrow(
        TokenPrimitiveError,
      );
    }
  });

  it('creates an independent client-side refresh successor and rotation ID', () => {
    const first = createRefreshSuccessor();
    const second = createRefreshSuccessor();

    expect(parseRefreshToken(first.refreshToken)).toBe(first.refreshToken);
    expect(parseRefreshRotationId(first.rotationId)).toBe(first.rotationId);
    expect(payloadBytes(first.refreshToken, 'hm_rt_')).toHaveLength(32);
    expect(payloadBytes(first.rotationId, 'hm_ri_')).toHaveLength(32);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(first.rotationId).not.toBe(second.rotationId);
    expectTypeOf(first.rotationId).toEqualTypeOf<RefreshRotationId>();
  });

  it('never includes a rejected secret in message, stack or JSON serialization', () => {
    const secret = 'hm_rt_SECRET_SHOULD_NOT_APPEAR';
    const error = captureError(() => parseRefreshToken(secret));
    const rendered = [error.message, error.stack, JSON.stringify(error)].join(
      '\n',
    );

    expect(error).toBeInstanceOf(TokenPrimitiveError);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('SECRET_SHOULD_NOT_APPEAR');
  });
});

describe('rejoin secret primitives', () => {
  it('generates, parses and hashes a branded rejoin secret', () => {
    const secret = generateRejoinSecret();
    expect(secret.startsWith('hm_rj_')).toBe(true);
    expect(parseRejoinSecret(secret)).toBe(secret);
    expect(hashRejoinSecret(secret)).toMatch(/^[0-9a-f]{64}$/u);
    expect(generateRejoinSecret()).not.toBe(secret);
  });

  it('rejects a malformed rejoin secret', () => {
    expect(() => parseRejoinSecret('hm_rj_short')).toThrow(TokenPrimitiveError);
    expect(() => parseRejoinSecret('hm_rt_' + 'A'.repeat(43))).toThrow();
  });

  it('matches a raw secret against its stored hash in constant time', () => {
    const secret = generateRejoinSecret();
    const storedHash = hashRejoinSecret(secret);
    expect(rejoinSecretMatchesHash(secret, storedHash)).toBe(true);
    expect(rejoinSecretMatchesHash(generateRejoinSecret(), storedHash)).toBe(
      false,
    );
  });

  it('is fail-closed for a null stored hash or a malformed presented secret', () => {
    const secret = generateRejoinSecret();
    // Legacy device: no provisioned hash.
    expect(rejoinSecretMatchesHash(secret, null)).toBe(false);
    // Malformed presented secret never throws, returns false.
    expect(rejoinSecretMatchesHash('not-a-secret', hashRejoinSecret(secret))).toBe(
      false,
    );
  });
});
