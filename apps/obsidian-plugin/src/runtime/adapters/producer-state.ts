/**
 * Parsing the untrusted persisted PRODUCER blob (the path↔fileId↔content mapping
 * set) under the GAP-3 fail-closed policy. Pure and never-throwing: it runs
 * during connect-time producer setup, so it must always return a verdict —
 * absent, ok (with any malformed entry quarantined rather than dropped), or
 * structurally corrupt — because a silently lost mapping would let a later local
 * edit mint a fresh duplicate fileId instead of updating in place.
 */

import type { LocalFileMapping } from '../../obsidian/vault-adapter';
import type { ProducerState } from '../../sync/outbox-repository';

import { isRecord } from './shared';

/**
 * Outcome of parsing the untrusted persisted PRODUCER blob (GAP-3, the producer
 * analogue of `sync-state.ts`'s `ParseResult`).
 *
 *  - `absent`: null/undefined blob — a normal first run (clean, writable, no
 *    signal).
 *  - `ok`: parsed successfully. A single unparseable mapping entry is QUARANTINED
 *    (kept in `quarantinedMappings`) rather than silently dropped, and its valid
 *    siblings are preserved. `quarantinedMappings.length > 0` is the recoverable
 *    signal the caller preserves to a sidecar.
 *  - `corrupt`: present but the container itself is structurally broken (not a
 *    record, or `mappings`/`heads` the wrong shape) — fail closed. The caller
 *    preserves the raw blob to a sidecar so a previously-populated mapping set is
 *    never silently replaced by an empty one.
 */
export interface ProducerParseResult {
  readonly status: 'absent' | 'ok' | 'corrupt';
  /** Empty for `absent`/`corrupt`; the parsed value (valid entries) for `ok`. */
  readonly state: ProducerState;
  /**
   * Raw malformed mapping entries kept for recovery on the `ok` path (GAP-3): the
   * quarantined bad entries whose valid siblings survived. Empty otherwise. A
   * non-empty list is the recoverable signal; the caller preserves it to a
   * sidecar instead of silently dropping it.
   */
  readonly quarantinedMappings: readonly unknown[];
}

const EMPTY_PRODUCER_STATE: ProducerState = { mappings: [], heads: {} };

/** True when `entry` is a well-formed persisted mapping (all required strings). */
function isValidProducerMapping(
  entry: unknown,
): entry is Record<string, unknown> {
  return (
    isRecord(entry) &&
    typeof entry.collisionKey === 'string' &&
    typeof entry.content === 'string' &&
    typeof entry.contentHash === 'string' &&
    typeof entry.fileId === 'string' &&
    typeof entry.path === 'string'
  );
}

/** Builds a `LocalFileMapping` from an already-validated entry. */
function buildProducerMapping(entry: Record<string, unknown>): LocalFileMapping {
  return {
    collisionKey: entry.collisionKey as string,
    content: entry.content as string,
    contentHash: entry.contentHash as string,
    // Preserve the binary/markdown discriminator across every load→save
    // cycle. Dropping it here silently converts a persisted binary mapping
    // to markdown, so the startup rebase then canonicalises its base64 over
    // the markdown path and corrupts the raw-byte hash → a false conflict on
    // the next binary sync (BLOCKER). Validate as an optional
    // 'markdown'|'binary'; anything else (absent/legacy) defaults to
    // markdown by omission, keeping legacy mappings unchanged.
    ...(entry.contentKind === 'binary' || entry.contentKind === 'markdown'
      ? { contentKind: entry.contentKind }
      : {}),
    fileId: entry.fileId as string,
    path: entry.path as string,
  };
}

/**
 * Parse the untrusted persisted producer blob under the GAP-3 fail-closed policy.
 * Pure and NEVER-THROWS (it runs on the connect path during producer setup, so it
 * must degrade defensively rather than abort a connect). See
 * {@link ProducerParseResult} for the absent/ok/corrupt distinction.
 */
export function parseProducerStateResult(raw: unknown): ProducerParseResult {
  // ABSENT: a genuinely missing blob is a normal first run — clean, writable,
  // and carries no signal. Distinguished from present-but-corrupt below.
  if (raw === null || raw === undefined) {
    return {
      status: 'absent',
      state: EMPTY_PRODUCER_STATE,
      quarantinedMappings: [],
    };
  }
  // CORRUPT: present but the container is structurally broken. Fail closed so the
  // caller preserves the raw bytes; never silently empty a populated mapping set.
  if (!isRecord(raw) || !Array.isArray(raw.mappings) || !isRecord(raw.heads)) {
    console.warn(
      'Havemind: producer state was present but structurally corrupt; its raw bytes were preserved to a sidecar and an empty state was used for this session.',
    );
    return {
      status: 'corrupt',
      state: EMPTY_PRODUCER_STATE,
      quarantinedMappings: [],
    };
  }

  // OK: keep every valid mapping and QUARANTINE (never drop) each malformed one so
  // a lost path↔fileId↔content entry can't later mint a duplicate fileId silently.
  const mappings: LocalFileMapping[] = [];
  const quarantinedMappings: unknown[] = [];
  for (const entry of raw.mappings) {
    if (isValidProducerMapping(entry)) {
      mappings.push(buildProducerMapping(entry));
    } else {
      quarantinedMappings.push(entry);
    }
  }
  if (quarantinedMappings.length > 0) {
    console.warn(
      `Havemind: ${quarantinedMappings.length} malformed producer mapping(s) were preserved for recovery; the rest of the mapping set was kept.`,
    );
  }
  const heads: Record<string, string> = {};
  for (const [fileId, revisionId] of Object.entries(raw.heads)) {
    if (typeof revisionId === 'string') heads[fileId] = revisionId;
  }
  return { status: 'ok', state: { mappings, heads }, quarantinedMappings };
}

/**
 * Backward-compatible thin wrapper returning only the parsed {@link ProducerState}
 * (valid mappings + heads). Callers that need the absent/ok/corrupt distinction
 * or the quarantined entries use {@link parseProducerStateResult} directly.
 */
export function parseProducerState(raw: unknown): ProducerState {
  return parseProducerStateResult(raw).state;
}
