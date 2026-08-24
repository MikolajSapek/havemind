/**
 * The two user-visible ways a device reaches a running sync loop: resuming what
 * is already persisted on layout-ready, and connecting from a freshly pasted
 * owner pairing token or invitation envelope. Both end in `startSyncLoop`, and
 * both are held to the same rules — a broken stored pairing is reported as a
 * distinct actionable state rather than looped as "offline", an auth rejection is
 * a terminal in-flow answer rather than a connection loss, and no secret (pairing
 * token, envelope, verification phrase) is ever logged.
 */

import type { Plugin } from 'obsidian';

import { driveToConnected } from '../connect-driver';
import { classifyConnectInput, pairOwnerDevice } from '../connect-input';
import { isConnectedOnboardingState } from '../connection';
import type { StatusListener } from '../controller';
import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { ensureClientInstanceId } from '../../storage/client-store';

import { buildOnboardingController } from './onboarding-wiring';
import {
  evaluateOwnerConnection,
  preserveCorruptOwnerConnection,
  writeOwnerConnection,
  type StoredConnection,
} from './owner-connection';
import { createClientInstanceRepo } from './plugin-data-ports';
import { createRequestUrlFn } from './request-url';
import type { RuntimeHooks } from './runtime-hooks';
import {
  HAVEMIND_STATUS_DISCONNECTED,
  HAVEMIND_STATUS_RESET_REQUIRED,
} from './status-constants';
import {
  NOOP_HANDLE,
  startSyncLoop,
  type ConnectionHandle,
} from './sync-loop';
import { generateRefreshTokenValue, sha256Hex } from './tokens';

const APPROVAL_POLL_INTERVAL_MS = 5000;
const MAX_CONNECT_STEPS = 720; // ~1h of 5s polls before giving up

const OWNER_DEVICE_LABEL = 'Havemind owner device';
const INVITEE_DEVICE_LABEL = 'Havemind device';

/**
 * Resumes any stored onboarding to `connected` and, once connected, builds and
 * starts the sync controller. Called on layout-ready; if there is no in-flight
 * connection it reports `disconnected` and starts nothing (passive shell).
 */
export async function startHavemindConnection(
  plugin: Plugin,
  onStatus: StatusListener,
  hooks?: RuntimeHooks,
): Promise<ConnectionHandle> {
  // An owner paired via /owner/pair persists a connection record and takes
  // precedence; otherwise resume any in-flight invitee onboarding.
  //
  // P1 #5: a BROKEN record (half-written, or valid-but-missing its refresh
  // secret) used to read as "no record" and fall through to the onboarding
  // resume, which reported disconnected and then looped on offline retries
  // forever — the second-computer incident whose only fix was deleting
  // data.json by hand. Report it as a distinct, actionable state instead.
  const gate = await evaluateOwnerConnection(plugin);
  if (gate.kind === 'reset-required') {
    // Preserve the raw bytes FIRST: the surfaced reset clears this key, and the
    // sidecar is the only record of what the pairing used to be.
    try {
      await preserveCorruptOwnerConnection(plugin, gate.raw, Date.now());
    } catch {
      console.warn(
        'Havemind: failed to preserve the damaged connection record to a sidecar.',
      );
    }
    console.warn(
      `Havemind: the stored connection is unusable (${gate.reason}); reset it and pair this device again.`,
    );
    onStatus('reset-required', HAVEMIND_STATUS_RESET_REQUIRED);
    return NOOP_HANDLE;
  }
  if (gate.kind === 'connect') {
    return startSyncLoop(plugin, gate.connection, onStatus, {
      role: 'owner',
      ...(hooks === undefined ? {} : { hooks }),
    });
  }

  const { controller: onboarding } = await buildOnboardingController(plugin);
  const connectedState = await driveToConnected({
    controller: onboarding,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    maxSteps: MAX_CONNECT_STEPS,
  });

  if (!isConnectedOnboardingState(connectedState)) {
    onStatus('disconnected', HAVEMIND_STATUS_DISCONNECTED);
    return NOOP_HANDLE;
  }

  const connected = connectedState as unknown as StoredConnection;
  return startSyncLoop(plugin, connected, onStatus, { role: 'editor', ...(hooks === undefined ? {} : { hooks }) });
}

export interface ConnectFromInputOptions {
  readonly report: (message: string) => void;
  readonly onStatus: StatusListener;
  /**
   * Called once the invitee is redeemed and waiting for owner approval, carrying
   * the verification phrase this device must read aloud. Lets the caller hold the
   * waiting state durably so a pane reopen resumes it (never re-redeeming a
   * single-use invitation). The phrase is a second-channel secret — never logged.
   */
  readonly onPendingApproval?: (verificationPhrase: string) => void;
  /**
   * Called when the server reports the invitation is no longer valid — the owner
   * rejected this device or the 3-attempt cap was reached. Lets the caller move
   * the guest to a clear "ask for a new invite" state instead of leaving it stuck
   * on the waiting screen (an auth rejection is never a connection loss).
   */
  readonly onInvitationRejected?: () => void;
  /** Live UI hooks (activity feed) threaded into the started sync loop. */
  readonly hooks?: RuntimeHooks;
}

/**
 * Runs the Connect flow for a pasted input: an owner pairing token (`hm_pt_…`)
 * redeems at `POST /owner/pair`; an invitation envelope (`v1.…`) runs the invitee
 * review → redeem → approval → bootstrap flow. Returns a started sync handle on
 * success, or null (with a reported message) otherwise. Secrets are never logged.
 */
export async function connectFromInput(
  plugin: Plugin,
  input: string,
  serverUrl: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const kind = classifyConnectInput(input);
  try {
    if (kind === 'pairing') {
      return await connectAsOwner(plugin, input.trim(), serverUrl, options);
    }
    if (kind === 'envelope') {
      return await connectAsInvitee(plugin, input.trim(), options);
    }
    options.report(
      'Unrecognised input. Paste a v1.… invitation or an hm_pt_… pairing token.',
    );
    return null;
  } catch (error) {
    options.report(`Could not connect: ${describeError(error)}`);
    return null;
  }
}

async function connectAsOwner(
  plugin: Plugin,
  pairingToken: string,
  serverUrl: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const apiBaseUrl = normalizeServerOrigin(serverUrl);
  if (apiBaseUrl === null) {
    options.report('Enter the server URL (https://…) to pair the owner device.');
    return null;
  }
  options.report('Pairing owner device…');
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  // Persist the exact client half before consuming the one-time code.  If the
  // app dies after the server commits but before data.json is updated, a retry
  // replays the same hash and the server returns the original pairing.
  const existing = await secrets.getPendingOwnerPairing();
  const refreshToken =
    existing !== null &&
    existing.apiBaseUrl === apiBaseUrl &&
    existing.pairingToken === pairingToken
      ? existing.refreshToken
      : generateRefreshTokenValue();
  if (existing === null || existing.refreshToken !== refreshToken) {
    await secrets.savePendingOwnerPairing({
      apiBaseUrl,
      pairingToken,
      refreshToken,
    });
  }
  // The raw refresh token never crosses the wire to /owner/pair — only its hash
  // does. The server binds the family to the hash; the client keeps the secret.
  const pairing = await pairOwnerDevice({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl,
    deviceLabel: OWNER_DEVICE_LABEL,
    initialRefreshTokenHash: await sha256Hex(refreshToken),
    pairingToken,
  });

  await secrets.saveRefreshToken(refreshToken);
  const connection: StoredConnection = {
    apiBaseUrl,
    vaultId: pairing.vaultId,
    deviceId: pairing.deviceId,
    ...(pairing.memberId === undefined ? {} : { memberId: pairing.memberId }),
  };
  await writeOwnerConnection(plugin, connection);
  await secrets.clearPendingOwnerPairing();

  options.report('Connected. Syncing…');
  return startSyncLoop(plugin, connection, options.onStatus, {
    role: 'owner',
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

async function connectAsInvitee(
  plugin: Plugin,
  envelope: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const { controller: onboarding } = await buildOnboardingController(plugin);
  options.report('Reviewing invitation…');
  onboarding.beginFromPastedEnvelope(envelope);
  await onboarding.loadInvitationReview();
  options.report('Redeeming invitation…');
  const pending = await onboarding.confirmInvitation(INVITEE_DEVICE_LABEL);
  if (pending.phase === 'pending-approval') {
    options.report(
      `Ask the owner to approve this phrase: ${pending.verificationPhrase}. Waiting…`,
    );
    // Surface the phrase durably so a pane reopen resumes the waiting screen.
    options.onPendingApproval?.(pending.verificationPhrase);
  }

  const state = await driveToConnected({
    controller: onboarding,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    maxSteps: MAX_CONNECT_STEPS,
  });
  if (state.phase === 'rejected') {
    // An auth rejection is an expected in-flow response, not a connection loss:
    // never flip to offline. Hand the caller a distinct terminal signal so it
    // shows "invitation no longer valid — ask for a new one" instead of a wait.
    options.report(
      'This invitation is no longer valid — ask the owner for a new one.',
    );
    options.onInvitationRejected?.();
    return null;
  }
  if (!isConnectedOnboardingState(state)) {
    options.report('Timed out waiting for approval. Try Connect again.');
    return null;
  }

  const connected = state as unknown as StoredConnection;
  options.report('Connected. Syncing…');
  return startSyncLoop(plugin, connected, options.onStatus, {
    role: 'editor',
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

function normalizeServerOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
