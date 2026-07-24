/**
 * Structural contract for the subset of libsodium (sumo build) used by this
 * package, plus a deterministic loader.
 *
 * Every function in `@havemind/crypto` accepts a `Sodium` instance by dependency
 * injection so unit tests are fully deterministic (they load and await the real
 * WASM module once, then pass it in). We depend on the STRUCTURAL surface below
 * rather than the whole `@types/libsodium-wrappers-sumo` namespace so the DI
 * contract is explicit and small — the real libsodium object satisfies it.
 *
 * The sumo build is required because Argon2id (`crypto_pwhash`) is NOT present
 * in the standard `libsodium-wrappers` build; only the sumo build carries it.
 */

/** Minimal libsodium surface consumed by this package. */
export interface Sodium {
  readonly ready: Promise<void>;

  // --- Argon2id KDF (sumo only) -------------------------------------------
  readonly crypto_pwhash_SALTBYTES: number;
  readonly crypto_pwhash_ALG_ARGON2ID13: number;
  readonly crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  readonly crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  readonly crypto_pwhash_OPSLIMIT_MODERATE: number;
  readonly crypto_pwhash_MEMLIMIT_MODERATE: number;
  crypto_pwhash(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;

  // --- XChaCha20-Poly1305-IETF AEAD ---------------------------------------
  readonly crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  readonly crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additionalData: string | Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: string | Uint8Array,
    additionalData: string | Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  // --- CSPRNG --------------------------------------------------------------
  randombytes_buf(length: number): Uint8Array;
}

/**
 * Load and initialise the real libsodium (sumo) module, awaiting its WASM
 * `ready` promise. Callers pass the resolved instance into the pure functions
 * of this package. This is the only impure/async entry point.
 */
export async function loadSodium(): Promise<Sodium> {
  const imported = (await import('libsodium-wrappers-sumo')) as unknown as {
    default?: Sodium;
  } & Sodium;
  const sodium: Sodium = imported.default ?? imported;
  await sodium.ready;
  return sodium;
}
