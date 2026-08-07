/**
 * @havemind/crypto — checkpoint sealed-box helpers (asymmetric at-rest crypto).
 *
 * =============================== HARD CONSTRAINTS ===========================
 * - ZERO own cryptography. Every primitive is a documented call into libsodium
 *   (`libsodium-wrappers-sumo`). We invent no cipher and no key scheme — we only
 *   compose libsodium's `crypto_box_seal` / `crypto_box_seal_open` (anonymous
 *   public-key encryption, X25519 + XSalsa20-Poly1305). plans/006 "ZERO own
 *   cryptography"; plans/001 §10 "No custom cryptographic primitive".
 * - ASYMMETRIC by design. The Havemind server holds ONLY the recipient PUBLIC
 *   key, so it can SEAL a new checkpoint but can NEVER open any existing one —
 *   only the owner's SECRET key (kept off-server in a recovery kit) decrypts
 *   (plans/006 "Key management"; T1; AC9). This is the counterpart to the
 *   symmetric vault-key crypto in `vault-crypto.ts`, which protects a different
 *   trust boundary (note contents vs. server metadata) with a different key.
 * - Pure functions: no file I/O. The caller injects a ready `Sodium` instance so
 *   tests are deterministic. The at-rest checkpoint file layout, manifest and
 *   integrity verification live in the server (`apps/server/src/checkpoint.ts`);
 *   this module is only the crypto core it composes.
 * ===========================================================================
 */

import type { Sodium } from './sodium.js';

/** X25519 recipient public-key length in bytes. */
export const CHECKPOINT_PUBLIC_KEY_BYTES = 32;

/** X25519 recipient secret-key length in bytes (held by the owner only). */
export const CHECKPOINT_SECRET_KEY_BYTES = 32;

/**
 * A checkpoint recipient keypair. The `publicKey` is stored on the server (it
 * can only encrypt new checkpoints); the `secretKey` is written to the owner's
 * recovery kit and NEVER persisted on the server, in the DB, in logs or in any
 * report (plans/006 "Key management"; plan/01 rule 6).
 */
export interface CheckpointKeypair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/**
 * Generate a fresh X25519 checkpoint recipient keypair. Losing the secret key
 * means every checkpoint sealed to the matching public key becomes permanently
 * unreadable — the honest, backdoor-free cost of the "no third party" model
 * (plans/006 T3).
 */
export function generateCheckpointKeypair(sodium: Sodium): CheckpointKeypair {
  const keypair = sodium.crypto_box_keypair();
  return { publicKey: keypair.publicKey, secretKey: keypair.privateKey };
}

/**
 * Seal (anonymously public-key encrypt) `bytes` to a recipient public key.
 * libsodium generates a fresh ephemeral sender keypair per call and appends a
 * Poly1305 tag, so the output is confidential AND tamper-evident to the holder
 * of the matching secret key. The server calls this to build a checkpoint it
 * cannot itself read back.
 */
export function sealTo(
  sodium: Sodium,
  publicKey: Uint8Array,
  bytes: Uint8Array,
): Uint8Array {
  if (publicKey.length !== CHECKPOINT_PUBLIC_KEY_BYTES) {
    throw new Error(
      `sealTo: publicKey must be ${CHECKPOINT_PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`,
    );
  }
  return sodium.crypto_box_seal(bytes, publicKey);
}

/**
 * Open a sealed box with the owner's keypair. Throws (never returns garbage) on
 * any tampering, truncation or the wrong secret key — the caller MUST treat a
 * throw as an authentication failure and abort the restore fail-closed, never
 * materialising partial state (plans/006 T2; restore steps 1–4).
 */
export function openSealed(
  sodium: Sodium,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  if (publicKey.length !== CHECKPOINT_PUBLIC_KEY_BYTES) {
    throw new Error(
      `openSealed: publicKey must be ${CHECKPOINT_PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`,
    );
  }
  if (secretKey.length !== CHECKPOINT_SECRET_KEY_BYTES) {
    throw new Error(
      `openSealed: secretKey must be ${CHECKPOINT_SECRET_KEY_BYTES} bytes, got ${secretKey.length}`,
    );
  }
  return sodium.crypto_box_seal_open(sealed, publicKey, secretKey);
}
