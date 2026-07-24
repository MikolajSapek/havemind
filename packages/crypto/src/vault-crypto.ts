/**
 * @havemind/crypto — vault-key derivation, key wrapping and payload AEAD.
 *
 * =============================== HARD CONSTRAINTS ===========================
 * - ZERO own cryptography. Every primitive here is a documented call into
 *   libsodium (the `libsodium-wrappers-sumo` WASM build), a vetted, audited
 *   library. We invent no cipher, no KDF, no key-wrap scheme — we only compose
 *   libsodium's Argon2id (`crypto_pwhash`) and XChaCha20-Poly1305-IETF AEAD
 *   (`crypto_aead_xchacha20poly1305_ietf_*`). This satisfies plans/004
 *   "ZERO własnej kryptografii" and plans/001 §10 "No custom cryptographic
 *   primitive will be invented."
 * - The SUMO build is required: Argon2id `crypto_pwhash` is absent from the
 *   standard `libsodium-wrappers` build and present only in the sumo build.
 *   The sumo build is a self-contained WASM module (no Node builtins), so it is
 *   browser-safe and bundleable by esbuild — but this module is NOT imported
 *   into the Obsidian plugin bundle (it is a de-risking spike per plans/004
 *   Rollout step 1), so the plugin bundle is unchanged.
 * - This module NEVER runs on the server. The Havemind server stays opaque and
 *   never possesses the vault key (plans/004 Threat model §1; plans/001 §2.6:
 *   "The server cannot recover or decrypt vault contents.").
 * - Pure functions: no file I/O, no DurableSyncState, no plugin imports. The
 *   caller injects a ready `Sodium` instance so tests are deterministic.
 *
 * This is a self-contained crypto slice only. It is NOT wired into the
 * sync/producer/apply path, does not change the wire format, and does not touch
 * any protocol schema. Wiring into `opaque_payload` is a separate, owner-gated,
 * post-pilot step (plans/004 Rollout).
 * ===========================================================================
 */

import type { Sodium } from './sodium.js';

/** Vault-key / wrapping-key length in bytes (XChaCha20-Poly1305 key size). */
export const KEY_BYTES = 32;

/** AEAD nonce length in bytes (XChaCha20-Poly1305-IETF public nonce). */
export const NONCE_BYTES = 24;

/** Argon2id salt length in bytes. */
export const SALT_BYTES = 16;

/** Argon2id cost parameters (documented; the concrete tier is a spike decision). */
export interface KdfParams {
  /** Number of passes (opslimit). Higher = slower brute force. */
  readonly opslimit: number;
  /** Memory in bytes (memlimit). Higher = harder to parallelise attacks. */
  readonly memlimit: number;
}

/**
 * Interactive-tier Argon2id parameters. plans/004 documents INTERACTIVE as the
 * lower bound (recommendation: MODERATE) with the final tier fixed by the
 * dedicated spike against target hardware. This module defaults to the lower
 * bound so its own unit tests stay fast; callers may pass MODERATE explicitly.
 */
export function interactiveKdfParams(sodium: Sodium): KdfParams {
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
}

/** Moderate-tier Argon2id parameters (plans/004 recommendation). */
export function moderateKdfParams(sodium: Sodium): KdfParams {
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
  };
}

/**
 * Derive a 32-byte passphrase key (KEK) from a passphrase and a public salt
 * using Argon2id. The passphrase never leaves the device; the salt is public
 * and stored alongside the wrapped vault key (never on the server as plaintext
 * of the vault key — the wrapped key is opaque). plans/004 "Wyprowadzenie
 * klucza vaultu (KDF)".
 */
export function deriveVaultKey(
  sodium: Sodium,
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = interactiveKdfParams(sodium),
): Uint8Array {
  if (salt.length !== SALT_BYTES) {
    throw new Error(
      `deriveVaultKey: salt must be ${SALT_BYTES} bytes, got ${salt.length}`,
    );
  }
  return sodium.crypto_pwhash(
    KEY_BYTES,
    passphrase,
    salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Generate a random 16-byte Argon2id salt (public, stored with the wrap). */
export function generateSalt(sodium: Sodium): Uint8Array {
  return sodium.randombytes_buf(SALT_BYTES);
}

/**
 * Generate a random 32-byte vault key from the library CSPRNG. The vault key is
 * NOT derived from the passphrase, so the passphrase can change without
 * re-encrypting content (plans/004: "a random vault key is created on the
 * owner's trusted device").
 */
export function generateVaultKey(sodium: Sodium): Uint8Array {
  return sodium.randombytes_buf(KEY_BYTES);
}

/**
 * Generate a random 32-byte recovery key. This wraps a second, independent copy
 * of the vault key (the recovery kit). HONEST LIMITATION: losing the passphrase
 * AND the recovery key means the vault is unrecoverable — the opaque server
 * cannot help (plans/004 "Odzyskiwanie"; §4 threat model). The human-readable
 * encoding of this key (BIP39 words / base32-with-checksum) is a spike decision
 * and intentionally out of scope for this module — it returns raw key bytes.
 */
export function generateRecoveryKey(sodium: Sodium): Uint8Array {
  return sodium.randombytes_buf(KEY_BYTES);
}

/**
 * AEAD encrypt with XChaCha20-Poly1305-IETF: fresh random 24-byte nonce per
 * message, nonce prepended to the ciphertext+tag. No associated data is bound
 * here — binding the protected header as AAD happens at the (not-yet-built)
 * wire layer, deliberately kept out of this spike module.
 */
function aeadEncrypt(
  sodium: Sodium,
  plaintext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const boxed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + boxed.length);
  out.set(nonce, 0);
  out.set(boxed, nonce.length);
  return out;
}

/**
 * AEAD decrypt the [nonce || ciphertext+tag] layout produced by aeadEncrypt.
 * Throws (never returns garbage) if the tag fails to authenticate — a tampered
 * byte, a truncated nonce or the wrong key all raise. Callers treat a throw as
 * "quarantine, never overwrite the local file" (plans/004 §3 acceptance).
 */
function aeadDecrypt(
  sodium: Sodium,
  boxed: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (boxed.length < NONCE_BYTES) {
    throw new Error(
      `decrypt: ciphertext shorter than a ${NONCE_BYTES}-byte nonce`,
    );
  }
  const nonce = boxed.subarray(0, NONCE_BYTES);
  const ciphertext = boxed.subarray(NONCE_BYTES);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    key,
  );
}

/**
 * Wrap (encrypt) the vault key under a wrapping key (a passphrase-derived key
 * or a recovery key). The result may sit in local device config next to the
 * salt and KDF params. plans/004 "wrapped_vault_key".
 */
export function wrapVaultKey(
  sodium: Sodium,
  vaultKey: Uint8Array,
  wrappingKey: Uint8Array,
): Uint8Array {
  return aeadEncrypt(sodium, vaultKey, wrappingKey);
}

/** Unwrap (decrypt) a wrapped vault key. Throws on the wrong wrapping key. */
export function unwrapVaultKey(
  sodium: Sodium,
  wrapped: Uint8Array,
  wrappingKey: Uint8Array,
): Uint8Array {
  return aeadDecrypt(sodium, wrapped, wrappingKey);
}

/**
 * Encrypt a plaintext payload (a normalised Markdown snapshot or attachment
 * bytes) under the vault key. plans/004 "encrypt/decrypt round trip".
 */
export function encryptPayload(
  sodium: Sodium,
  plaintext: Uint8Array,
  vaultKey: Uint8Array,
): Uint8Array {
  return aeadEncrypt(sodium, plaintext, vaultKey);
}

/**
 * Decrypt a payload produced by encryptPayload. Throws on any tampering or the
 * wrong key — the caller must treat a throw as an authentication failure and
 * quarantine, never materialise garbage.
 */
export function decryptPayload(
  sodium: Sodium,
  ciphertext: Uint8Array,
  vaultKey: Uint8Array,
): Uint8Array {
  return aeadDecrypt(sodium, ciphertext, vaultKey);
}
