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

  // --- Anonymous public-key encryption (sealed box, X25519) ----------------
  // Used by the encrypted-checkpoint layer (plans/006): the server holds ONLY
  // the recipient public key, so it can SEAL a new checkpoint but can never
  // OPEN any — only the owner's secret key (kept off-server in a recovery kit)
  // decrypts. `crypto_box_seal` uses a fresh ephemeral sender keypair per call
  // and appends a Poly1305 tag, so it provides confidentiality + integrity to
  // the secret-key holder (a tampered sealed box makes `crypto_box_seal_open`
  // throw). It is anonymous: it does NOT authenticate the sender.
  readonly crypto_box_PUBLICKEYBYTES: number;
  readonly crypto_box_SECRETKEYBYTES: number;
  crypto_box_keypair(): {
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
    readonly keyType: string;
  };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array,
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
