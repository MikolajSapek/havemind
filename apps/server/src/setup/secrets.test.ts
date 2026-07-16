import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SECRET_MIN_ENTROPY_BITS,
  SecretError,
  generateDatabaseKey,
  hashSecret,
  secretFingerprint,
  secretHashesEqual,
} from './secrets.js';

describe('generateDatabaseKey', () => {
  it('produces at least 256 bits of entropy', () => {
    const secret = generateDatabaseKey();
    expect(secret.entropyBits).toBeGreaterThanOrEqual(SECRET_MIN_ENTROPY_BITS);
    // 256-bit hex value is 64 lowercase hex characters (32 bytes).
    expect(secret.value).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('returns the hash of the raw value, never the value itself', () => {
    const secret = generateDatabaseKey();
    expect(secret.hash).toBe(
      createHash('sha256').update(secret.value, 'utf8').digest('hex'),
    );
    expect(secret.hash).not.toBe(secret.value);
    expect(secret.fingerprint).not.toContain(secret.value);
  });

  it('produces distinct values across calls', () => {
    const first = generateDatabaseKey();
    const second = generateDatabaseKey();
    expect(first.value).not.toBe(second.value);
  });

  it('accepts an injected random source', () => {
    const secret = generateDatabaseKey(() => Buffer.alloc(32, 0xab));
    expect(secret.value).toBe('ab'.repeat(32));
  });

  it('rejects a random source that under-delivers entropy', () => {
    expect(() => generateDatabaseKey(() => Buffer.alloc(8, 0x01))).toThrow(
      SecretError,
    );
  });
});

describe('hashSecret', () => {
  it('rejects an empty secret', () => {
    expect(() => hashSecret('')).toThrow(SecretError);
  });

  it('is stable for the same input', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
  });
});

describe('secretFingerprint', () => {
  it('is short and prefixed, never revealing the raw secret', () => {
    const fingerprint = secretFingerprint('a-very-secret-value');
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/u);
    expect(fingerprint).not.toContain('a-very-secret-value');
  });
});

describe('secretHashesEqual', () => {
  it('returns true for identical digests', () => {
    const digest = hashSecret('same');
    expect(secretHashesEqual(digest, digest)).toBe(true);
  });

  it('returns false for different digests', () => {
    expect(secretHashesEqual(hashSecret('a'), hashSecret('b'))).toBe(false);
  });

  it('returns false for malformed digests', () => {
    expect(secretHashesEqual('not-a-hash', hashSecret('a'))).toBe(false);
    expect(secretHashesEqual(hashSecret('a'), 'still-not')).toBe(false);
  });
});
