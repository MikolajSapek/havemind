/**
 * Every top-level key and sidecar prefix the plugin writes inside its single
 * `data.json` blob, plus the guard that recognises a corrupt-* sidecar. They live
 * together in one leaf module because they form ONE namespace: the atomic-save
 * trio, the per-subsystem state keys, and the timestamped forensic sidecars a
 * reset must never destroy are only correct relative to each other, and a
 * collision between any two of them would silently overwrite live state.
 */

export const PERSIST_KEY = 'syncState';
/**
 * Single previous-good backup of {@link PERSIST_KEY} (GAP-1). Every save demotes
 * the prior primary here before installing the new one, so a primary that later
 * parses as corrupt can be recovered from the last durable snapshot.
 */
export const PERSIST_BAK_KEY = 'syncState.bak';
/**
 * Staging slot for the atomic save (GAP-1). The new blob is written here first,
 * then a second write promotes it to the primary and demotes the old primary to
 * `.bak`. A torn write during the promote therefore cannot destroy the primary:
 * on failure the disk still holds the prior primary plus the staged copy.
 */
export const PERSIST_STAGING_KEY = 'syncState.staging';
/**
 * Prefix for a timestamped sidecar preserving a present-but-corrupt primary blob
 * (GAP-1). The bytes are kept for forensics/manual recovery rather than
 * discarded; a pre-existing sidecar at the same key is never clobbered.
 */
export const PERSIST_CORRUPT_PREFIX = 'syncStateCorrupt.';
/**
 * Prefix for a timestamped sidecar preserving a present-but-corrupt PRODUCER blob
 * (GAP-3), the producer analogue of {@link PERSIST_CORRUPT_PREFIX}. When the
 * producer state (path↔fileId↔content mappings) is present but unparseable, its
 * raw bytes are kept here for recovery rather than silently dropped — losing a
 * mapping would let a later local edit mint a FRESH fileId (a duplicate) instead
 * of updating in place. A pre-existing sidecar at the same key is never clobbered.
 */
export const PERSIST_PRODUCER_CORRUPT_PREFIX = 'pushProducerCorrupt.';

/** Top-level plugin-data key recording the AUD-03 rebase version applied. */
export const CANONICALIZATION_REBASE_MARKER_KEY =
  'canonicalizationRebaseVersion';

export const CLIENT_INSTANCE_KEY = 'clientInstanceId';

export const PUSH_PRODUCER_KEY = 'pushProducer';

export const OWNER_CONNECTION_KEY = 'ownerConnection';

/**
 * Timestamped sidecar prefix for a corrupt or half-paired `ownerConnection`
 * record (P1 #5), mirroring {@link PERSIST_CORRUPT_PREFIX}: the raw bytes are
 * kept under a timestamped key so a reset never destroys the only evidence of
 * what the pairing used to be.
 */
export const OWNER_CONNECTION_CORRUPT_PREFIX = 'ownerConnectionCorrupt.';

/** Every sidecar prefix a reset must leave untouched. */
const CORRUPT_SIDECAR_PREFIXES: readonly string[] = [
  PERSIST_CORRUPT_PREFIX,
  PERSIST_PRODUCER_CORRUPT_PREFIX,
  OWNER_CONNECTION_CORRUPT_PREFIX,
];

export function isCorruptSidecarKey(key: string): boolean {
  return CORRUPT_SIDECAR_PREFIXES.some((prefix) => key.startsWith(prefix));
}
