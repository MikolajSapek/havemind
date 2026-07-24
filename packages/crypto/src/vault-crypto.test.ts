import { beforeAll, describe, expect, it } from 'vitest';

import { loadSodium, type Sodium } from './sodium.js';
import {
  KEY_BYTES,
  NONCE_BYTES,
  SALT_BYTES,
  decryptPayload,
  deriveVaultKey,
  encryptPayload,
  generateRecoveryKey,
  generateSalt,
  generateVaultKey,
  interactiveKdfParams,
  unwrapVaultKey,
  wrapVaultKey,
} from './vault-crypto.js';

let sodium: Sodium;

beforeAll(async () => {
  sodium = await loadSodium();
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// A fixed 16-byte salt vector so KDF output is a stable test vector run to run.
const FIXED_SALT = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f,
]);
const OTHER_SALT = new Uint8Array([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f,
]);

describe('constants', () => {
  it('match the libsodium primitive sizes', () => {
    expect(KEY_BYTES).toBe(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    expect(NONCE_BYTES).toBe(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    expect(SALT_BYTES).toBe(sodium.crypto_pwhash_SALTBYTES);
    expect(KEY_BYTES).toBe(32);
    expect(NONCE_BYTES).toBe(24);
    expect(SALT_BYTES).toBe(16);
  });
});

describe('deriveVaultKey (Argon2id KDF)', () => {
  it('is deterministic: same passphrase + salt yields the same 32-byte key', () => {
    const a = deriveVaultKey(sodium, 'correct horse battery staple', FIXED_SALT);
    const b = deriveVaultKey(sodium, 'correct horse battery staple', FIXED_SALT);
    expect(a).toHaveLength(KEY_BYTES);
    expect([...a]).toEqual([...b]);
  });

  it('produces a different key for a different salt', () => {
    const a = deriveVaultKey(sodium, 'correct horse battery staple', FIXED_SALT);
    const b = deriveVaultKey(sodium, 'correct horse battery staple', OTHER_SALT);
    expect([...a]).not.toEqual([...b]);
  });

  it('produces a different key for a different passphrase', () => {
    const a = deriveVaultKey(sodium, 'passphrase one', FIXED_SALT);
    const b = deriveVaultKey(sodium, 'passphrase two', FIXED_SALT);
    expect([...a]).not.toEqual([...b]);
  });

  it('rejects a salt of the wrong length', () => {
    expect(() =>
      deriveVaultKey(sodium, 'x', new Uint8Array(SALT_BYTES - 1)),
    ).toThrow(/salt/i);
  });

  it('exposes interactive KDF params as a lower bound', () => {
    const params = interactiveKdfParams(sodium);
    expect(params.opslimit).toBe(sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE);
    expect(params.memlimit).toBe(sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE);
  });
});

describe('generateSalt / generateVaultKey / generateRecoveryKey', () => {
  it('generates a salt of the correct length', () => {
    expect(generateSalt(sodium)).toHaveLength(SALT_BYTES);
  });

  it('generates a 32-byte vault key', () => {
    expect(generateVaultKey(sodium)).toHaveLength(KEY_BYTES);
  });

  it('generates distinct random vault keys', () => {
    expect([...generateVaultKey(sodium)]).not.toEqual([
      ...generateVaultKey(sodium),
    ]);
  });

  it('generates a 32-byte recovery key', () => {
    expect(generateRecoveryKey(sodium)).toHaveLength(KEY_BYTES);
  });
});

describe('wrapVaultKey / unwrapVaultKey', () => {
  it('round-trips a vault key through a passphrase-derived key', () => {
    const vaultKey = generateVaultKey(sodium);
    const passphraseKey = deriveVaultKey(sodium, 'my passphrase', FIXED_SALT);
    const wrapped = wrapVaultKey(sodium, vaultKey, passphraseKey);
    const unwrapped = unwrapVaultKey(sodium, wrapped, passphraseKey);
    expect([...unwrapped]).toEqual([...vaultKey]);
  });

  it('fails to unwrap with the wrong wrapping key', () => {
    const vaultKey = generateVaultKey(sodium);
    const good = deriveVaultKey(sodium, 'right', FIXED_SALT);
    const bad = deriveVaultKey(sodium, 'wrong', FIXED_SALT);
    const wrapped = wrapVaultKey(sodium, vaultKey, good);
    expect(() => unwrapVaultKey(sodium, wrapped, bad)).toThrow();
  });

  it('lets the passphrase change without re-encrypting content (re-wrap)', () => {
    const vaultKey = generateVaultKey(sodium);
    const oldKey = deriveVaultKey(sodium, 'old pass', FIXED_SALT);
    const newKey = deriveVaultKey(sodium, 'new pass', OTHER_SALT);
    const wrappedOld = wrapVaultKey(sodium, vaultKey, oldKey);
    const recovered = unwrapVaultKey(sodium, wrappedOld, oldKey);
    const wrappedNew = wrapVaultKey(sodium, recovered, newKey);
    expect([...unwrapVaultKey(sodium, wrappedNew, newKey)]).toEqual([
      ...vaultKey,
    ]);
  });
});

describe('recovery key path', () => {
  it('wraps the same vault key under an independent recovery key', () => {
    const vaultKey = generateVaultKey(sodium);
    const passphraseKey = deriveVaultKey(sodium, 'pass', FIXED_SALT);
    const recoveryKey = generateRecoveryKey(sodium);

    const wrappedByPass = wrapVaultKey(sodium, vaultKey, passphraseKey);
    const wrappedByRecovery = wrapVaultKey(sodium, vaultKey, recoveryKey);

    // Simulate lost passphrase: recover the vault key from the recovery kit.
    const recovered = unwrapVaultKey(sodium, wrappedByRecovery, recoveryKey);
    expect([...recovered]).toEqual([...vaultKey]);

    // The passphrase-wrapped copy still works independently.
    expect([...unwrapVaultKey(sodium, wrappedByPass, passphraseKey)]).toEqual([
      ...vaultKey,
    ]);
  });

  it('cannot recover with neither passphrase nor recovery key', () => {
    const vaultKey = generateVaultKey(sodium);
    const recoveryKey = generateRecoveryKey(sodium);
    const wrapped = wrapVaultKey(sodium, vaultKey, recoveryKey);
    const lostKey = generateRecoveryKey(sodium); // an unrelated key
    expect(() => unwrapVaultKey(sodium, wrapped, lostKey)).toThrow();
  });
});

describe('encryptPayload / decryptPayload', () => {
  it('round-trips a Markdown snapshot', () => {
    const vaultKey = generateVaultKey(sodium);
    const plaintext = utf8('# Note\n\nHello, opaque server.\n');
    const ciphertext = encryptPayload(sodium, plaintext, vaultKey);
    expect([...decryptPayload(sodium, ciphertext, vaultKey)]).toEqual([
      ...plaintext,
    ]);
  });

  it('prepends the nonce and expands beyond the plaintext length', () => {
    const vaultKey = generateVaultKey(sodium);
    const plaintext = utf8('abc');
    const ciphertext = encryptPayload(sodium, plaintext, vaultKey);
    // nonce (24) + ciphertext + poly1305 tag (16) > plaintext length.
    expect(ciphertext.length).toBeGreaterThan(plaintext.length + NONCE_BYTES);
  });

  it('produces a distinct ciphertext each call (random nonce)', () => {
    const vaultKey = generateVaultKey(sodium);
    const plaintext = utf8('same input');
    const a = encryptPayload(sodium, plaintext, vaultKey);
    const b = encryptPayload(sodium, plaintext, vaultKey);
    expect([...a]).not.toEqual([...b]);
  });

  it('throws (does not return garbage) when a ciphertext byte is tampered', () => {
    const vaultKey = generateVaultKey(sodium);
    const ciphertext = encryptPayload(sodium, utf8('secret'), vaultKey);
    const tampered = Uint8Array.from(ciphertext);
    const last = tampered.length - 1;
    tampered[last] = tampered[last] ^ 0x01;
    expect(() => decryptPayload(sodium, tampered, vaultKey)).toThrow();
  });

  it('throws when the nonce region is tampered', () => {
    const vaultKey = generateVaultKey(sodium);
    const ciphertext = encryptPayload(sodium, utf8('secret'), vaultKey);
    const tampered = Uint8Array.from(ciphertext);
    tampered[0] = tampered[0] ^ 0x01;
    expect(() => decryptPayload(sodium, tampered, vaultKey)).toThrow();
  });

  it('throws when decrypting with the wrong key', () => {
    const ciphertext = encryptPayload(
      sodium,
      utf8('secret'),
      generateVaultKey(sodium),
    );
    expect(() =>
      decryptPayload(sodium, ciphertext, generateVaultKey(sodium)),
    ).toThrow();
  });

  it('rejects a ciphertext shorter than a nonce', () => {
    expect(() =>
      decryptPayload(sodium, new Uint8Array(NONCE_BYTES - 1), generateVaultKey(sodium)),
    ).toThrow(/ciphertext/i);
  });

  it('round-trips a >1 MB payload (size/perf sanity)', () => {
    const vaultKey = generateVaultKey(sodium);
    const big = sodium.randombytes_buf(1_500_000);
    const ciphertext = encryptPayload(sodium, big, vaultKey);
    const decrypted = decryptPayload(sodium, ciphertext, vaultKey);
    expect(decrypted.length).toBe(big.length);
    expect([...decrypted.subarray(0, 64)]).toEqual([...big.subarray(0, 64)]);
    expect([...decrypted.subarray(big.length - 64)]).toEqual([
      ...big.subarray(big.length - 64),
    ]);
  });

  it('round-trips an empty payload', () => {
    const vaultKey = generateVaultKey(sodium);
    const ciphertext = encryptPayload(sodium, new Uint8Array(0), vaultKey);
    expect(decryptPayload(sodium, ciphertext, vaultKey)).toHaveLength(0);
  });
});
