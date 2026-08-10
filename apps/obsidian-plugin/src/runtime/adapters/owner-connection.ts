/**
 * Reading, gating, preserving and clearing the persisted owner pairing record.
 * The whole module exists because of one field incident (P1 #5): the old
 * `StoredConnection | null` shape conflated an ABSENT record with a CORRUPT or
 * half-paired one, so a broken pairing silently became "nothing paired" and every
 * connect fell through to an endless offline retry. Parsing and gating are pure
 * and never throw, the gate fails OPEN on a SecretStorage probe failure, and the
 * reset preserves the raw bytes to a sidecar before clearing anything.
 */

import type { Plugin } from 'obsidian';

import { ensureClientInstanceId } from '../../storage/client-store';
import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { getPluginDataMutex } from '../plugin-data-mutex';

import {
  OWNER_CONNECTION_CORRUPT_PREFIX,
  OWNER_CONNECTION_KEY,
  isCorruptSidecarKey,
} from './plugin-data-keys';
import { createClientInstanceRepo } from './plugin-data-ports';
import { isRecord } from './shared';

export interface StoredConnection {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  /** Server membership id for this user; required to build push headers. */
  readonly memberId?: string;
  /** Server-issued device id bound to the session; required to push. */
  readonly deviceId?: string;
}

/**
 * The persisted owner pairing, as a three-way result (P1 #5). The old
 * `StoredConnection | null` shape conflated ABSENT (a clean first run — resume
 * invitee onboarding) with CORRUPT (a half-written record), so a broken record
 * silently became "nothing paired" and every connect fell through to the offline
 * retry loop. Mirrors {@link parseProducerStateResult}'s absent/ok/corrupt shape.
 */
export type OwnerConnectionReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'corrupt'; readonly raw: unknown }
  | {
      readonly status: 'connection';
      readonly connection: StoredConnection;
      readonly raw: unknown;
    };

/**
 * Classifies a raw `ownerConnection` blob. Never throws — connect-safety: a
 * garbage record must produce a verdict, not an exception.
 */
export function parseOwnerConnection(raw: unknown): OwnerConnectionReadResult {
  // ABSENT: no record at all is a normal, clean state (a fresh vault, or an
  // invitee whose pairing lives in the onboarding state instead).
  if (raw === null || raw === undefined) {
    return { status: 'absent' };
  }
  // CORRUPT: present but missing a required field (or not a record at all). The
  // two required fields are exactly what every request needs; without them no
  // retry, backoff or rejoin can ever succeed.
  if (
    !isRecord(raw) ||
    typeof raw.apiBaseUrl !== 'string' ||
    typeof raw.vaultId !== 'string'
  ) {
    return { status: 'corrupt', raw };
  }
  return {
    status: 'connection',
    raw,
    connection: {
      apiBaseUrl: raw.apiBaseUrl,
      vaultId: raw.vaultId,
      ...(typeof raw.memberId === 'string' ? { memberId: raw.memberId } : {}),
      ...(typeof raw.deviceId === 'string' ? { deviceId: raw.deviceId } : {}),
    },
  };
}

async function readOwnerConnectionResult(
  plugin: Plugin,
): Promise<OwnerConnectionReadResult> {
  const data = await plugin.loadData();
  return parseOwnerConnection(isRecord(data) ? data[OWNER_CONNECTION_KEY] : null);
}

/**
 * Backward-compatible thin wrapper returning only a usable connection (absent
 * and corrupt both read as null). Callers that must TELL a broken record from a
 * missing one use {@link evaluateOwnerConnection}.
 */
export async function readOwnerConnection(
  plugin: Plugin,
): Promise<StoredConnection | null> {
  const result = await readOwnerConnectionResult(plugin);
  return result.status === 'connection' ? result.connection : null;
}

/**
 * The connect-start verdict for the persisted owner pairing (P1 #5).
 * `reset-required` is terminal-and-unretryable: the record cannot produce a
 * working session, so the user is offered a reset instead of an offline loop.
 */
export type OwnerConnectionGate =
  | { readonly kind: 'absent' }
  | { readonly kind: 'connect'; readonly connection: StoredConnection }
  | {
      readonly kind: 'reset-required';
      readonly reason: 'corrupt-record' | 'missing-secret';
      readonly raw: unknown;
    };

/**
 * Pure gate: a corrupt record, or a structurally valid one whose refresh secret
 * is gone, both mean "reset required". A half-paired device (record on disk,
 * secret missing — the exact second-computer failure) can never authenticate, so
 * treating it as connectable only produces the offline loop this fixes.
 */
export function gateOwnerConnection(
  result: OwnerConnectionReadResult,
  refreshTokenPresent: boolean,
): OwnerConnectionGate {
  if (result.status === 'absent') return { kind: 'absent' };
  if (result.status === 'corrupt') {
    return { kind: 'reset-required', reason: 'corrupt-record', raw: result.raw };
  }
  if (!refreshTokenPresent) {
    return { kind: 'reset-required', reason: 'missing-secret', raw: result.raw };
  }
  return { kind: 'connect', connection: result.connection };
}

/** Reads back this device's refresh token; true when one is actually stored. */
async function hasStoredRefreshToken(plugin: Plugin): Promise<boolean> {
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  return (await secrets.getRefreshToken()) !== null;
}

/**
 * Evaluates the persisted owner pairing at connect start: absent, connectable,
 * or broken beyond retrying.
 *
 * FAILS OPEN on a probe failure. A SecretStorage outage (or any throw while
 * reading it) must never be reported as a broken pairing: `reset-required`
 * invites the user to clear their local state, so a false positive there is a
 * data-safety problem. Only a token that positively reads back as absent counts.
 */
export async function evaluateOwnerConnection(
  plugin: Plugin,
): Promise<OwnerConnectionGate> {
  const result = await readOwnerConnectionResult(plugin);
  if (result.status !== 'connection') {
    return gateOwnerConnection(result, false);
  }
  let refreshTokenPresent: boolean;
  try {
    refreshTokenPresent = await hasStoredRefreshToken(plugin);
  } catch (error) {
    console.warn(
      'Havemind: could not read the stored refresh token; assuming the pairing is intact.',
      error,
    );
    refreshTokenPresent = true;
  }
  return gateOwnerConnection(result, refreshTokenPresent);
}

/**
 * Preserve a corrupt/half-paired `ownerConnection` record under a timestamped
 * sidecar, mirroring {@link preserveCorruptProducerState}: never clobbers a
 * pre-existing sidecar at the same key, and writes through the shared plugin-data
 * mutex so it cannot race a concurrent write to another top-level key.
 */
export async function preserveCorruptOwnerConnection(
  plugin: Plugin,
  raw: unknown,
  timestamp: number,
): Promise<void> {
  await getPluginDataMutex(plugin).update((base) => {
    const key = `${OWNER_CONNECTION_CORRUPT_PREFIX}${timestamp}`;
    if (key in base) return base;
    return { ...base, [key]: raw };
  });
}

/**
 * Clears this device's Havemind state so a broken pairing can be replaced by a
 * fresh one (P1 #5) — the supported form of the manual "delete data.json" the
 * field incident required.
 *
 * Order matters:
 *   1. Preserve the current `ownerConnection` bytes to a timestamped sidecar, so
 *      nothing is destroyed before anything is cleared.
 *   2. Clear the secrets, while the `clientInstanceId` that namespaces them is
 *      still on disk (best-effort — a SecretStorage failure must not abort the
 *      reset, or the user is stuck in the broken state they asked to leave).
 *   3. Drop every top-level plugin-data key EXCEPT the corrupt-* sidecars.
 *
 * No vault content is touched: notes and attachments on disk are the source of
 * truth and are re-reconciled after re-pairing.
 */
export async function resetHavemindConnectionState(
  plugin: Plugin,
  now: () => number = () => Date.now(),
): Promise<void> {
  const result = await readOwnerConnectionResult(plugin);
  if (result.status !== 'absent') {
    await preserveCorruptOwnerConnection(plugin, result.raw, now());
  }

  try {
    const clientInstanceId = await ensureClientInstanceId(
      createClientInstanceRepo(plugin),
    );
    const secrets = new ObsidianOnboardingSecrets({
      clientInstanceId,
      secretStorage: plugin.app.secretStorage,
    });
    // The secrets port models "clear" as an empty write (see
    // `clearInvitationEnvelope`); an empty value reads back as null.
    await secrets.saveRefreshToken('');
    await secrets.saveRejoinSecret('');
    await secrets.clearInvitationEnvelope();
    await secrets.clearPendingCredential();
    await secrets.clearPendingRotation();
  } catch (error) {
    console.warn(
      'Havemind: could not clear the stored connection secrets during reset.',
      error,
    );
  }

  await getPluginDataMutex(plugin).update((base) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      if (isCorruptSidecarKey(key)) next[key] = value;
    }
    return next;
  });
}

export async function writeOwnerConnection(
  plugin: Plugin,
  connection: StoredConnection,
): Promise<void> {
  await getPluginDataMutex(plugin).update((base) => ({
    ...base,
    [OWNER_CONNECTION_KEY]: connection,
  }));
}
