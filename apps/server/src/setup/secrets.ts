import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Every operator-facing Havemind secret (database key, pairing token) carries at
 * least this much entropy. Anchored to `plan/03-systemy-przekrojowe.md`, where
 * both the access/refresh tokens and the onboarding pairing token are specified
 * at 256 bits.
 */
export const SECRET_MIN_ENTROPY_BITS = 256;

const SECRET_BYTE_LENGTH = SECRET_MIN_ENTROPY_BITS / 8;
const FINGERPRINT_HEX_LENGTH = 12;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** A deliberately secret-free error safe to log or serialize. */
export class SecretError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export interface GeneratedSecret {
  /**
   * Raw secret material (lowercase hex). The operator writes this to a
   * restricted file under `/srv/secrets`; it is NEVER persisted server-side.
   */
  readonly value: string;
  /** SHA-256 hex of {@link value}. Safe to persist and compare. */
  readonly hash: string;
  /** Guaranteed to be at least {@link SECRET_MIN_ENTROPY_BITS}. */
  readonly entropyBits: number;
  /** Short, non-reversible label safe to show in diagnostics. */
  readonly fingerprint: string;
}

/** Hashes a raw secret to a stable, non-reversible SHA-256 hex digest. */
export function hashSecret(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretError('Cannot hash an empty secret.');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Returns a short, non-reversible label for a secret, safe to print in
 * diagnostics. Never returns any part of the raw secret.
 */
export function secretFingerprint(value: string): string {
  return `sha256:${hashSecret(value).slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

/**
 * Generates a fresh database key with at least {@link SECRET_MIN_ENTROPY_BITS}
 * of entropy. Only the raw value is returned to the caller (to be written to
 * `/srv/secrets`); the accompanying hash/fingerprint are what may be persisted
 * or logged.
 */
export function generateDatabaseKey(
  randomSource: (size: number) => Buffer = randomBytes,
): GeneratedSecret {
  const bytes = randomSource(SECRET_BYTE_LENGTH);
  if (!Buffer.isBuffer(bytes) || bytes.length < SECRET_BYTE_LENGTH) {
    throw new SecretError(
      'Secret random source produced insufficient entropy.',
    );
  }
  const value = bytes.subarray(0, SECRET_BYTE_LENGTH).toString('hex');
  return Object.freeze({
    entropyBits: SECRET_BYTE_LENGTH * 8,
    fingerprint: secretFingerprint(value),
    hash: hashSecret(value),
    value,
  });
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function secretHashesEqual(left: string, right: string): boolean {
  if (!SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
