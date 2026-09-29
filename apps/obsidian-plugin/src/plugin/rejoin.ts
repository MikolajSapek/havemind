/** F9 Rejoin, invitee side: after a terminal auth failure, poll for the owner's grant and restart. */

import { Notice } from 'obsidian';

import type HavemindPlugin from '../main';
import { buildRejoinControllerForInvitee } from '../runtime/obsidian-adapters';
import {
  REJOIN_POLL_INTERVAL_MS,
  type RejoinController,
  type RejoinResumed,
  type RejoinState,
} from '../runtime/rejoin';
import { formatStatusBar } from '../runtime/status';

export class InviteeRejoin {
  /**
   * The live controller driving terminal-auth → syncing while this device
   * polls for the owner's grant, plus the interval id so unload tears the poll
   * down. Null when no rejoin is armed.
   */
  private rejoinController: RejoinController | null = null;
  private rejoinPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** Guards the post-rejoin restart so it fires exactly once (no double-start). */
  private rejoinRestarted = false;
  /** `connectGeneration` captured when the rejoin poll armed; null when disarmed. */
  private rejoinArmedGeneration: number | null = null;

  public constructor(private readonly plugin: HavemindPlugin) {}

  /**
   * Invitee side: arm the rejoin poll after a terminal auth failure. Idempotent
   *, a second terminal status while a poll is already armed is a no-op, so the
   * poll is never doubled. Builds the controller from this device's persisted
   * (membershipId, deviceId); if none is stored there is nothing to rejoin with.
   */
  public async armRejoin(): Promise<void> {
    if (this.rejoinController !== null) return;
    let controller: RejoinController | null;
    try {
      controller = await buildRejoinControllerForInvitee(this.plugin);
    } catch {
      if (!this.plugin.unloaded) {
        this.plugin.connectionError = 'Havemind could not prepare reconnection. Pair again if this persists.';
        this.plugin.views.refreshOnboardingNow();
      }
      return;
    }
    // The build awaits plugin data; guard against unload racing it and against a
    // second arm having won while we awaited.
    if (controller === null || this.plugin.unloaded || this.rejoinController !== null) {
      return;
    }
    this.rejoinController = controller;
    this.rejoinRestarted = false;
    // Snapshot the connect generation so a poll tick can tell whether the
    // connection has been rebuilt since (FINDING 1b).
    this.rejoinArmedGeneration = this.plugin.connectGeneration;
    // registerInterval so unload tears the poll down; the panel polls redemption
    // every REJOIN_POLL_INTERVAL_MS until the owner's grant lands.
    const timer = globalThis.setInterval(() => {
      void this.pollRejoinOnce();
    }, REJOIN_POLL_INTERVAL_MS);
    // `registerInterval` clears the timer on unload; the Obsidian runtime hands
    // a numeric id while Node's types surface a Timeout object, cast the id at
    // this single boundary rather than reshaping the platform declaration.
    this.plugin.registerInterval(timer as unknown as number);
    this.rejoinPollTimer = timer;
  }

  /**
   * One rejoin poll tick. Presents the persisted binding; on the first
   * 'syncing' result it disarms and restarts the connection exactly once (the
   * `rejoinRestarted` guard plus the controller's own idempotency prevent a
   * double-start). If unload raced the in-flight attempt, it cancels cleanly.
   */
  private async pollRejoinOnce(): Promise<void> {
    const controller = this.rejoinController;
    if (controller === null || this.rejoinRestarted || this.plugin.unloaded) return;
    // FINDING 1b: if the connection was re-established since this poll armed
    // (Retry now, a fresh user connect, a rejoin restart, anything that assigns
    // a new handle bumps `connectGeneration`), this poll is stale. Presenting the
    // binding now would drive a 'syncing' result that stops + restarts the
    // healthy connection. Disarm and bail instead of thrashing it.
    if (
      this.rejoinArmedGeneration !== null &&
      this.plugin.connectGeneration !== this.rejoinArmedGeneration
    ) {
      this.disarmRejoin();
      return;
    }
    let result: RejoinState | RejoinResumed;
    try {
      result = await controller.attempt();
    } catch {
      // FIX C1: attempt() can reject if the post-200 refresh-token save throws
      // (SecretStorage/keychain write). The controller normally converts that to
      // 'rejoin-failed', but a raw throw must never escape here as an unhandled
      // rejection that leaves the 30 s poll spinning against a burned grant in
      // silence. Route it to the same surfaced terminal path.
      if (this.plugin.unloaded || this.rejoinRestarted) return;
      this.surfaceRejoinFailed();
      return;
    }
    if (this.plugin.unloaded || this.rejoinRestarted) return;
    if (typeof result === 'object' && result.status === 'syncing') {
      this.rejoinRestarted = true;
      this.disarmRejoin();
      await this.restartConnectionAfterRejoin();
      return;
    }
    // FIX 4: 'rejoin-failed' is terminal and unrecoverable by polling (the
    // server returned a 200 the controller could not use, or the post-200 save
    // failed). Leaving the 30 s poll armed spins forever in silence, so disarm
    // it and surface the failure to the user. The manual retry path: a later
    // terminal-auth status (the user reconnecting) re-arms the poll from
    // scratch, since disarmRejoin cleared `rejoinController`.
    if (result === 'rejoin-failed') {
      this.surfaceRejoinFailed();
    }
  }

  /**
   * Disarm the doomed poll and surface a terminal rejoin failure to the user
   * (status + Notice), leaving a manual reconnect as the only retry path. Shared
   * by the 'rejoin-failed' controller result and a raw throw from attempt().
   */
  private surfaceRejoinFailed(): void {
    this.disarmRejoin();
    this.plugin.connectionError =
      'Rejoin failed, the server rejected the automatic rejoin. Reconnect manually to resume syncing.';
    this.plugin.statusBar.setStatus(formatStatusBar({ status: 'reconnect-required' }));
    new Notice(
      'Havemind: rejoin failed. Reconnect manually to resume syncing.',
    );
    this.plugin.views.refreshOnboarding();
  }

  /** Tears the invitee rejoin poll down (idempotent). */
  public disarmRejoin(): void {
    if (this.rejoinPollTimer !== null) {
      globalThis.clearInterval(this.rejoinPollTimer);
      this.rejoinPollTimer = null;
    }
    this.rejoinController = null;
    this.rejoinArmedGeneration = null;
  }

  /**
   * Restarts the connection after a successful rejoin. The fresh refresh token
   * is already persisted, so startConnection resumes sync under the SAME
   * membership. Follows the established invariant: stop-previous → await →
   * guard-against-unload → assign (the guard lives inside startConnection).
   */
  private async restartConnectionAfterRejoin(): Promise<void> {
    this.plugin.connection?.stop();
    this.plugin.connection = null;
    await this.plugin.startConnection();
  }
}
