/** The owner's Create connection composer: mint an invitation, then approve or reject the device. */

import type HavemindPlugin from '../main';
import { ApproveDeviceError } from '../runtime/approve-device';
import type { CreatedInvitation } from '../runtime/create-invitation';
import {
  approvePendingDeviceForOwner,
  createInvitationForOwner,
  listPendingApprovalsForOwner,
  rejectPendingDeviceForOwner,
} from '../runtime/obsidian-adapters';
import type {
  ConnectReporter,
  CreateConnectionViewModel,
  InvitationRole,
  PendingApprovalEntry,
} from '../ui/onboarding-view';

import type { AppWithVault } from '../runtime/adapters/shared';
import { AGENT_JOIN_COMMAND, presetById, taskNoteFor, taskNotePath } from '../runtime/agent-presets';

import { agentNameProblem } from './agent-name';
import { errorMessage } from './error-message';

/** Writes an agent's task note from its preset, never over one already there. */
export async function writeTaskNote(plugin: HavemindPlugin, name: string, presetId: string | undefined): Promise<string> {
  const { vault } = plugin.app as unknown as AppWithVault;
  const path = taskNotePath(name);
  for (const folder of ['Havemind', 'Havemind/Agents']) {
    if (vault.getAbstractFileByPath(folder) === null) await vault.createFolder(folder);
  }
  if (vault.getAbstractFileByPath(path) === null) {
    await vault.create(path, taskNoteFor(presetById(presetId ?? 'custom')));
  }
  return path;
}

export class Invitations {
  public pendingInvitation: CreatedInvitation | null = null;
  public pendingApprovals: PendingApprovalEntry[] = [];
  /** True while the composer is open; it then takes over the pane. */
  public connectionActive = false;
  public connectionNotice: string | undefined;
  /** Visual treatment for `connectionNotice`; see CreateConnectionViewModel. */
  public connectionNoticeKind: 'info' | 'success' | undefined;
  /** The shown invitation is for an AI agent (plan 014): show how it joins. */
  private pendingInvitationIsAgent = false;

  public constructor(private readonly plugin: HavemindPlugin) {}

  /**
   * Owner action: open the unified "Create connection" panel where the invite
   * is minted and the joining device is approved in one living surface.
   */
  public openCreateConnectionView(): Promise<void> {
    this.connectionActive = true;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.plugin.views.refreshOnboardingNow();
    return this.plugin.openPane();
  }

  /** Returns from the owner composer without discarding an already-minted invite. */
  public closeCreateConnectionView(): void {
    this.connectionActive = false;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.plugin.views.refreshOnboardingNow();
  }

  /** Snapshot of the owner composer state for the unified panel. */
  public composerModel(): CreateConnectionViewModel {
    return {
      role: 'editor',
      name: '',
      invitation: this.pendingInvitation,
      pending: this.activePendingApprovals(),
      invitationExpired: this.isInvitationExpired(),
      ...(this.pendingInvitationIsAgent ? { agentJoinCommand: AGENT_JOIN_COMMAND } : {}),
      ...(this.connectionNotice === undefined
        ? {}
        : { notice: this.connectionNotice }),
      ...(this.connectionNoticeKind === undefined
        ? {}
        : { noticeKind: this.connectionNoticeKind }),
    };
  }

  /** True once the minted invitation is past its ISO-8601 expiry. */
  private isInvitationExpired(): boolean {
    if (this.pendingInvitation === null) return false;
    const expiry = Date.parse(this.pendingInvitation.expiresAt);
    return Number.isFinite(expiry) && Date.now() >= expiry;
  }

  /** Owner action: refuse the device waiting on `invitationId` and drop its row. */
  public async rejectPendingDevice(
    invitationId: string,
    report: ConnectReporter,
  ): Promise<void> {
    try {
      const rejected = await rejectPendingDeviceForOwner(this.plugin, { invitationId });
      if (rejected === null) {
        report('Connect as the vault owner before rejecting a device.');
        return;
      }
      this.pendingApprovals = this.pendingApprovals.filter(
        (entry) => entry.invitationId !== invitationId,
      );
      this.connectionNotice = 'Device rejected. Its invitation no longer works.';
      this.connectionNoticeKind = undefined;
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      report(error instanceof Error ? error.message : 'Could not reject the device.');
    }
  }

  /**
   * Owner action: approve the joining device that read out `verificationPhrase`
   * against `POST …/invitations/:invitationId/approve`. The phrase is a
   * second-channel secret and is never logged; failures are reported to the view.
   */
  public async approvePendingDevice(
    invitationId: string,
    verificationPhrase: string,
    report: ConnectReporter,
  ): Promise<void> {
    try {
      const approved = await approvePendingDeviceForOwner(this.plugin, {
        invitationId,
        verificationPhrase,
      });
      if (approved === null) {
        report('Connect as the vault owner before approving a device.');
        return;
      }
      // The device's display name is only known while its waiting row still
      // exists, so read it before filtering the row out.
      const approvedEntry = this.pendingApprovals.find(
        (entry) => entry.invitationId === invitationId,
      );
      const approvedName = approvedEntry?.intendedMemberDisplayName;
      const connectedMessage = `${approvedName ?? 'Device'} connected.`;
      // Record the approved device as a PERSISTENT roster member (green until an
      // explicit teardown). The owner's client already knows the display name,
      // role and server membershipId at approval time, endpoint-free.
      try {
        await this.plugin.people.recordRosterMember({
          membershipId: approved.membershipId,
          displayName: approvedName ?? 'Member',
          role: approvedEntry?.intendedRole ?? 'editor',
          self: false,
        });
      } catch {
        // The server has already approved the device. Do not falsely report a
        // rejected approval, but make the local durability failure actionable.
        report(
          'Device approved, but its local roster entry could not be saved. Reconnect to retry the local save.',
        );
        return;
      }
      this.pendingApprovals = this.pendingApprovals.filter(
        (entry) => entry.invitationId !== invitationId,
      );
      this.connectionNotice = connectedMessage;
      this.connectionNoticeKind = 'success';
      report(connectedMessage);
      // Re-render to drop the approved row while keeping the create section
      // (invitation + role/name) fully alive.
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      if (error instanceof ApproveDeviceError && error.locked) {
        // The invitation is spent after too many wrong codes: drop its waiting
        // row and point the owner back to Create invitation.
        this.pendingApprovals = this.pendingApprovals.filter(
          (entry) => entry.invitationId !== invitationId,
        );
        this.connectionNotice =
          'This invitation is now invalid. Create a new one above to try again.';
        this.connectionNoticeKind = undefined;
        report(error.message);
        this.plugin.views.refreshOnboardingNow();
        return;
      }
      if (error instanceof ApproveDeviceError) {
        // A wrong code (or other approval error): keep the row so the owner can
        // retry in place, and surface the "N attempts left" message inline.
        report(error.message);
        return;
      }
      report(`Could not approve: ${errorMessage(error)}`);
    }
  }

  /** The waiting devices whose invitation has not expired: all a screen may show. */
  public activePendingApprovals(now: number = Date.now()): PendingApprovalEntry[] {
    return this.pendingApprovals.filter((entry) => Date.parse(entry.expiresAt) > now);
  }

  /** Forgets everything the owner composer held: the next connection may be another vault. */
  public clearOwnerState(): void {
    this.pendingInvitation = null;
    this.pendingApprovals = [];
    this.connectionActive = false;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
  }

  private lastPendingRefresh = 0;

  /**
   * Re-reads the waiting devices from the server, at most every 30 s: called on
   * every synced transition so a request made on another device, or one that
   * expired, shows up without a restart. The role is read from the server
   * roster too, because an invited owner is recorded as an editor on the
   * connection; asking as a non-owner is a 403 and a wasted token rotation.
   */
  public async refreshPendingApprovalsSoon(): Promise<void> {
    const ownerOnRoster = this.plugin.people.rosterMembers.some((member) => member.self && member.role === 'owner');
    if (!ownerOnRoster && this.plugin.connection?.selfMembership?.role !== 'owner') return;
    const now = Date.now();
    if (now - this.lastPendingRefresh < 30_000) return;
    this.lastPendingRefresh = now;
    await this.restorePendingApprovals();
  }

  /** Hydrates owner approvals after restart; failure never disrupts sync. */
  public async restorePendingApprovals(): Promise<void> {
    try {
      const pending = await listPendingApprovalsForOwner(this.plugin);
      if (pending === null || this.plugin.unloaded) return;
      // An unchanged list must not repaint: the owner may be typing a code.
      if (JSON.stringify(pending) === JSON.stringify(this.pendingApprovals)) return;
      this.pendingApprovals = [...pending];
      this.plugin.views.refreshOnboarding();
    } catch {
      // A non-owner or temporarily unavailable server must not make a healthy
      // connection appear broken. The composer will retry when reopened.
    }
  }

  /**
   * Owner action: mint an invitation for the connected vault, reveal the
   * copyable envelope, and register the joining device in the waiting list so
   * the owner can approve it by clicking a row (never by typing a UUID). The
   * envelope (a secret) is rendered only for the owner to copy, never logged.
   */
  public async createInvitation(
    role: InvitationRole,
    name: string,
    report: ConnectReporter,
    agentPresetId?: string,
  ): Promise<void> {
    const agent = role === 'agent';
    // The name becomes the task note's file name, so check it before any request.
    const problem = agent && name.length > 0 ? agentNameProblem(name) : null;
    if (problem !== null) {
      report(problem);
      return;
    }
    const memberRole = role === 'owner' ? 'owner' : 'editor';
    try {
      const invitation = await createInvitationForOwner(this.plugin, {
        intendedRole: memberRole,
        ...(agent ? { intendedKind: 'agent' as const } : {}),
        ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
      });
      if (invitation === null) {
        report('Connect as the vault owner before creating an invitation.');
        return;
      }
      // Only once the server took the agent invitation: an older server
      // refuses it, and a task note for an agent that cannot exist would sync
      // to everyone for nothing.
      const taskNote = agent ? await writeTaskNote(this.plugin, name, agentPresetId) : null;
      // Minting an invite always belongs to the composer and must reveal the
      // invite section, never leave it hidden behind another surface.
      this.connectionActive = true;
      this.pendingInvitation = invitation;
      this.pendingInvitationIsAgent = agent;
      this.pendingApprovals = [
        ...this.pendingApprovals.filter(
          (entry) => entry.invitationId !== invitation.invitationId,
        ),
        {
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
          intendedRole: memberRole,
          ...(agent ? { intendedKind: 'agent' as const } : {}),
          ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
        },
      ];
      this.connectionNotice = taskNote === null
        ? 'Invitation created. Copy it and send it to the other device.'
        : `Task note written: ${taskNote}. Edit it any time; the agent reads it before every run.`;
      this.connectionNoticeKind = undefined;
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      // A server older than plan 014 refuses the agent kind outright.
      report(
        agent && /400|INVALID/u.test(errorMessage(error))
          ? 'This server cannot add AI agents yet. Update it (run the installer again), then try again.'
          : `Could not create invitation: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Clears the minted-invitation display without touching the waiting list, and
   * closes the owner composer to return to the connection panel. Clearing
   * `connectionActive` is what makes Done a real exit: `render()` gives the
   * composer priority and returns before drawing the status indicator, so
   * leaving the composer open would hide "Connected, synced" indefinitely and
   * read as if the vault had disconnected.
   */
  public dismissInvitation(): void {
    this.pendingInvitation = null;
    this.closeCreateConnectionView();
  }
}
