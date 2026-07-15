import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_PAYLOAD_LENGTH = 43;
const SHA256_HEX_LENGTH = 64;
const TOKEN_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export const ACCESS_TOKEN_MIN_TTL_SECONDS = 10 * 60;
export const ACCESS_TOKEN_MAX_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

declare const accessTokenBrand: unique symbol;
declare const refreshTokenBrand: unique symbol;
declare const pairingTokenBrand: unique symbol;
declare const invitationTokenBrand: unique symbol;
declare const refreshRotationIdBrand: unique symbol;
declare const tokenHashBrand: unique symbol;
declare const accessTokenTtlBrand: unique symbol;
declare const refreshTokenTtlBrand: unique symbol;

export type AccessToken = string & {
  readonly [accessTokenBrand]: 'AccessToken';
};
export type RefreshToken = string & {
  readonly [refreshTokenBrand]: 'RefreshToken';
};
export type PairingToken = string & {
  readonly [pairingTokenBrand]: 'PairingToken';
};
export type InvitationToken = string & {
  readonly [invitationTokenBrand]: 'InvitationToken';
};
export type RefreshRotationId = string & {
  readonly [refreshRotationIdBrand]: 'RefreshRotationId';
};
export type TokenHash = string & {
  readonly [tokenHashBrand]: 'TokenHash';
};
export type AccessTokenTtlSeconds = number & {
  readonly [accessTokenTtlBrand]: 'AccessTokenTtlSeconds';
};
export type RefreshTokenTtlSeconds = number & {
  readonly [refreshTokenTtlBrand]: 'RefreshTokenTtlSeconds';
};

export type TokenPrimitiveErrorCode =
  | 'INVALID_TOKEN'
  | 'INVALID_TOKEN_HASH'
  | 'INVALID_TOKEN_TTL';

const ERROR_MESSAGES: Readonly<Record<TokenPrimitiveErrorCode, string>> = {
  INVALID_TOKEN: 'Invalid token.',
  INVALID_TOKEN_HASH: 'Invalid token hash.',
  INVALID_TOKEN_TTL: 'Invalid token lifetime.',
};

/** A deliberately secret-free error safe to log or serialize. */
export class TokenPrimitiveError extends Error {
  public readonly code: TokenPrimitiveErrorCode;

  public constructor(code: TokenPrimitiveErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TokenPrimitiveError';
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: string;
    code: TokenPrimitiveErrorCode;
    message: string;
  }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

interface TokenDomain<T extends string> {
  readonly prefix: string;
  readonly brand: (value: string) => T;
}

const ACCESS_TOKEN_DOMAIN: TokenDomain<AccessToken> = {
  prefix: 'hm_at_',
  brand: (value) => value as AccessToken,
};
const REFRESH_TOKEN_DOMAIN: TokenDomain<RefreshToken> = {
  prefix: 'hm_rt_',
  brand: (value) => value as RefreshToken,
};
const PAIRING_TOKEN_DOMAIN: TokenDomain<PairingToken> = {
  prefix: 'hm_pt_',
  brand: (value) => value as PairingToken,
};
const INVITATION_TOKEN_DOMAIN: TokenDomain<InvitationToken> = {
  prefix: 'hm_it_',
  brand: (value) => value as InvitationToken,
};
const REFRESH_ROTATION_ID_DOMAIN: TokenDomain<RefreshRotationId> = {
  prefix: 'hm_ri_',
  brand: (value) => value as RefreshRotationId,
};

function generateToken<T extends string>(domain: TokenDomain<T>): T {
  const payload = randomBytes(TOKEN_BYTE_LENGTH).toString('base64url');
  return domain.brand(`${domain.prefix}${payload}`);
}

function parseToken<T extends string>(
  value: string,
  domain: TokenDomain<T>,
): T {
  if (
    typeof value !== 'string' ||
    value.length !== domain.prefix.length + TOKEN_PAYLOAD_LENGTH ||
    !value.startsWith(domain.prefix)
  ) {
    throw new TokenPrimitiveError('INVALID_TOKEN');
  }

  const payload = value.slice(domain.prefix.length);
  if (!TOKEN_PAYLOAD_PATTERN.test(payload)) {
    throw new TokenPrimitiveError('INVALID_TOKEN');
  }

  const decoded = Buffer.from(payload, 'base64url');
  if (
    decoded.length !== TOKEN_BYTE_LENGTH ||
    decoded.toString('base64url') !== payload
  ) {
    throw new TokenPrimitiveError('INVALID_TOKEN');
  }

  return domain.brand(value);
}

function hashToken(value: string): TokenHash {
  return createHash('sha256').update(value, 'utf8').digest('hex') as TokenHash;
}

function parseTokenHash(value: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length !== SHA256_HEX_LENGTH ||
    !SHA256_HEX_PATTERN.test(value)
  ) {
    throw new TokenPrimitiveError('INVALID_TOKEN_HASH');
  }

  return Buffer.from(value, 'hex');
}

function validateIntegerTtl(
  seconds: number,
  minimum: number,
  maximum: number,
): void {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < minimum ||
    seconds > maximum
  ) {
    throw new TokenPrimitiveError('INVALID_TOKEN_TTL');
  }
}

export function generateAccessToken(): AccessToken {
  return generateToken(ACCESS_TOKEN_DOMAIN);
}

export function generateRefreshToken(): RefreshToken {
  return generateToken(REFRESH_TOKEN_DOMAIN);
}

export function generatePairingToken(): PairingToken {
  return generateToken(PAIRING_TOKEN_DOMAIN);
}

export function generateInvitationToken(): InvitationToken {
  return generateToken(INVITATION_TOKEN_DOMAIN);
}

function generateRefreshRotationId(): RefreshRotationId {
  return generateToken(REFRESH_ROTATION_ID_DOMAIN);
}

export function parseAccessToken(value: string): AccessToken {
  return parseToken(value, ACCESS_TOKEN_DOMAIN);
}

export function parseRefreshToken(value: string): RefreshToken {
  return parseToken(value, REFRESH_TOKEN_DOMAIN);
}

export function parsePairingToken(value: string): PairingToken {
  return parseToken(value, PAIRING_TOKEN_DOMAIN);
}

export function parseInvitationToken(value: string): InvitationToken {
  return parseToken(value, INVITATION_TOKEN_DOMAIN);
}

export function parseRefreshRotationId(value: string): RefreshRotationId {
  return parseToken(value, REFRESH_ROTATION_ID_DOMAIN);
}

export function hashAccessToken(token: AccessToken): TokenHash {
  return hashToken(parseAccessToken(token));
}

export function hashRefreshToken(token: RefreshToken): TokenHash {
  return hashToken(parseRefreshToken(token));
}

export function hashPairingToken(token: PairingToken): TokenHash {
  return hashToken(parsePairingToken(token));
}

export function hashInvitationToken(token: InvitationToken): TokenHash {
  return hashToken(parseInvitationToken(token));
}

export function tokenHashesEqual(left: string, right: string): boolean {
  const leftBytes = parseTokenHash(left);
  const rightBytes = parseTokenHash(right);
  return timingSafeEqual(leftBytes, rightBytes);
}

export function validateAccessTokenTtl(
  seconds: number,
): AccessTokenTtlSeconds {
  validateIntegerTtl(
    seconds,
    ACCESS_TOKEN_MIN_TTL_SECONDS,
    ACCESS_TOKEN_MAX_TTL_SECONDS,
  );
  return seconds as AccessTokenTtlSeconds;
}

export function validateRefreshTokenTtl(
  seconds: number,
): RefreshTokenTtlSeconds {
  validateIntegerTtl(seconds, 1, REFRESH_TOKEN_MAX_TTL_SECONDS);
  return seconds as RefreshTokenTtlSeconds;
}

export interface RefreshSuccessor {
  readonly refreshToken: RefreshToken;
  readonly rotationId: RefreshRotationId;
}

export function createRefreshSuccessor(): RefreshSuccessor {
  return {
    refreshToken: generateRefreshToken(),
    rotationId: generateRefreshRotationId(),
  };
}
