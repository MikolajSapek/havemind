import { beforeAll, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_PUBLIC_KEY_BYTES,
  CHECKPOINT_SECRET_KEY_BYTES,
  generateCheckpointKeypair,
  openSealed,
  sealTo,
} from './checkpoint-crypto.js';
import { loadSodium, type Sodium } from './sodium.js';

let sodium: Sodium;

beforeAll(async () => {
  sodium = await loadSodium();
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('checkpoint keypair', () => {
  it('generates a 32-byte X25519 public/secret keypair', () => {
    const keypair = generateCheckpointKeypair(sodium);
    expect(keypair.publicKey).toHaveLength(CHECKPOINT_PUBLIC_KEY_BYTES);
    expect(keypair.secretKey).toHaveLength(CHECKPOINT_SECRET_KEY_BYTES);
    expect(CHECKPOINT_PUBLIC_KEY_BYTES).toBe(32);
    expect(CHECKPOINT_SECRET_KEY_BYTES).toBe(32);
  });

  it('produces a fresh keypair each call', () => {
    const a = generateCheckpointKeypair(sodium);
    const b = generateCheckpointKeypair(sodium);
    expect([...a.publicKey]).not.toEqual([...b.publicKey]);
    expect([...a.secretKey]).not.toEqual([...b.secretKey]);
  });
});

describe('sealTo / openSealed (anonymous public-key encryption)', () => {
  it('round-trips arbitrary bytes with the owner secret key', () => {
    const keypair = generateCheckpointKeypair(sodium);
    const plaintext = utf8('metadata snapshot bytes');
    const sealed = sealTo(sodium, keypair.publicKey, plaintext);
    const opened = openSealed(
      sodium,
      keypair.publicKey,
      keypair.secretKey,
      sealed,
    );
    expect([...opened]).toEqual([...plaintext]);
  });

  it('never reveals plaintext in the sealed ciphertext (confidentiality)', () => {
    const keypair = generateCheckpointKeypair(sodium);
    const marker = utf8('TOP-SECRET-NOTE-BODY');
    const sealed = sealTo(sodium, keypair.publicKey, marker);
    // The raw sealed bytes must not contain the plaintext marker anywhere.
    const haystack = Buffer.from(sealed).toString('latin1');
    expect(haystack).not.toContain('TOP-SECRET-NOTE-BODY');
    expect(sealed.byteLength).toBeGreaterThan(marker.byteLength);
  });

  it('produces different ciphertext for the same message (ephemeral sender)', () => {
    const keypair = generateCheckpointKeypair(sodium);
    const plaintext = utf8('same message');
    const a = sealTo(sodium, keypair.publicKey, plaintext);
    const b = sealTo(sodium, keypair.publicKey, plaintext);
    expect([...a]).not.toEqual([...b]);
  });

  it('throws when a sealed byte is tampered (integrity)', () => {
    const keypair = generateCheckpointKeypair(sodium);
    const sealed = sealTo(sodium, keypair.publicKey, utf8('payload'));
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() =>
      openSealed(sodium, keypair.publicKey, keypair.secretKey, tampered),
    ).toThrow();
  });

  it('cannot be opened by the public key alone (no secret key)', () => {
    const keypair = generateCheckpointKeypair(sodium);
    const other = generateCheckpointKeypair(sodium);
    const sealed = sealTo(sodium, keypair.publicKey, utf8('server-created'));
    // A holder of only the recipient public key (the server) plus the WRONG
    // secret key cannot decrypt: this models "the server cannot read its own
    // checkpoints" (plans/006 AC9).
    expect(() =>
      openSealed(sodium, keypair.publicKey, other.secretKey, sealed),
    ).toThrow();
  });
});
