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

export class Invitations {
  public pendingInvitation: CreatedInvitation | null = null;
  public pendingApprovals: PendingApprovalEntry[] = [];
  /** True while the composer is open; it then takes over the pane. */
  public connectionActive = false;
  public connectionNotice: string | undefined;
  /** Visual treatment for `connectionNotice`; see CreateConnectionViewModel. */
  public connectionNoticeKind: 'info' | 'success' | undefined;

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
      pending: this.pendingApprovals,
      invitationExpired: this.isInvitationExpired(),
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
      report(
        `Could not approve: ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  /** Hydrates owner approvals after restart; failure never disrupts sync. */
  public async restorePendingApprovals(): Promise<void> {
    try {
      const pending = await listPendingApprovalsForOwner(this.plugin);
      if (pending === null || this.plugin.unloaded) return;
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
  ): Promise<void> {
    try {
      const invitation = await createInvitationForOwner(this.plugin, {
        intendedRole: role,
        ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
      });
      if (invitation === null) {
        report('Connect as the vault owner before creating an invitation.');
        return;
      }
      // Minting an invite always belongs to the composer and must reveal the
      // invite section, never leave it hidden behind another surface.
      this.connectionActive = true;
      this.pendingInvitation = invitation;
      this.pendingApprovals = [
        ...this.pendingApprovals.filter(
          (entry) => entry.invitationId !== invitation.invitationId,
        ),
        {
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
          intendedRole: role,
          ...(name.length === 0 ? {} : { intendedMemberDisplayName: name }),
        },
      ];
      this.connectionNotice =
        'Invitation created. Copy it and send it to the other device.';
      this.connectionNoticeKind = undefined;
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      report(
        `Could not create invitation: ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
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
    this.connectionActive = false;
    this.connectionNotice = undefined;
    this.connectionNoticeKind = undefined;
    this.plugin.views.refreshOnboardingNow();
  }
}
