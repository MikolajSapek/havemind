/** The vault's member roster (P3), and the owner's Rejoin (F9) and Remove on it. */

import { Notice } from 'obsidian';

import type HavemindPlugin from '../main';
import { LegacyRosterServerError } from '../runtime/member-roster';
import {
  fetchMemberRosterForVault,
  requestRejoinGrantForOwner,
  revokeMembershipForOwner,
  type ConnectionHandle,
} from '../runtime/obsidian-adapters';
import {
  createSerializedDataPort,
  getPluginDataMutex,
} from '../runtime/plugin-data-mutex';
import { RosterStore, type RosterMember } from '../runtime/roster';

export class People {
  /**
   * Persistent presence roster: the members connected to this vault. Sourced
   * from approve-time records + the local self membership and persisted in
   * data.json (endpoint-free). Never derived from sync activity.
   */
  public rosterMembers: RosterMember[] = [];
  /** Membership ids the owner has issued a rejoin grant for (awaiting reconnect). */
  public rejoinWaiting = new Set<string>();

  public constructor(private readonly plugin: HavemindPlugin) {}

  /** Records the local member into the roster once the connection knows it. */
  public adoptSelfMembership(handle: ConnectionHandle | null): void {
    const self = handle?.selfMembership;
    if (self === undefined) return;
    void this.recordRosterMember({
      membershipId: self.membershipId,
      displayName: 'You',
      role: self.role,
      self: true,
    }).catch(() => {
      new Notice('Havemind: could not save this device in the member roster.');
      this.plugin.views.refreshOnboarding();
    });
  }

  /** The durable roster store over the shared plugin-data blob. */
  private rosterStore(): RosterStore {
    // Route the roster's read-modify-save through the shared per-plugin mutex so
    // a concurrent write to another data.json key (sync state, producer,
    // onboarding) is never clobbered (MAJOR).
    return new RosterStore({
      persist: createSerializedDataPort(getPluginDataMutex(this.plugin)),
    });
  }

  public async loadRoster(): Promise<void> {
    this.rosterMembers = await this.rosterStore().readMembers();
    this.plugin.views.refreshOnboarding();
  }

  /**
   * P3: replaces the People list with the vault's server-authoritative roster
   * (`GET /members`). The roster used to be assembled from what each device
   * happened to witness, so a guest saw a list of one while the owner saw
   * everyone. The server holds the truth and every member reads the same list.
   *
   * Failure is deliberately silent and NON-DESTRUCTIVE: an unreachable server,
   * a refused session or a malformed payload leaves `rosterMembers` exactly as
   * it was, so an offline device keeps showing what it last knew instead of
   * blanking the People pane. The next connect or reconnect retries.
   */
  public async refreshRoster(): Promise<void> {
    const self = this.rosterMembers.find((member) => member.self);
    const selfMembershipId =
      self?.membershipId ?? this.plugin.connection?.selfMembership?.membershipId ?? null;
    try {
      const members = await this.readRoster(selfMembershipId);
      // `null` means this device is not connected to a vault, there is nothing
      // authoritative to render, so the existing list stands.
      if (members === null || this.plugin.unloaded) return;
      this.rosterMembers = await this.rosterStore().replaceMembers(members);
      this.plugin.views.refreshOnboarding();
    } catch {
      // Keep the previous list rendered. Never an empty People pane.
    }
  }

  /**
   * B4: the live connection reads the roster with its own access token. The
   * refresh-token route raced that connection's rotation (401 at every start)
   * and is kept only for a server that does not send membership ids yet.
   */
  private async readRoster(
    selfMembershipId: string | null,
  ): Promise<RosterMember[] | null> {
    const readRoster = this.plugin.connection?.readRoster;
    if (readRoster !== undefined) {
      try {
        return await readRoster(selfMembershipId);
      } catch (error) {
        if (!(error instanceof LegacyRosterServerError)) throw error;
      }
    }
    return fetchMemberRosterForVault(this.plugin, { selfMembershipId });
  }

  /** Upserts a member, persists the roster, and refreshes the live surfaces. */
  public async recordRosterMember(member: RosterMember): Promise<void> {
    this.rosterMembers = await this.rosterStore().recordMember(member);
    this.plugin.views.refreshOnboarding();
  }

  /**
   * Owner action: issue a rejoin grant for a known-dead contact via the existing
   * authenticated transport, then show "waiting for <name> to reconnect" until
   * the roster refreshes. Nothing secret is sent or shown.
   */
  public async requestRejoin(membershipId: string): Promise<void> {
    try {
      const waiting = await requestRejoinGrantForOwner(this.plugin, { membershipId });
      if (waiting === null) {
        new Notice('Havemind: connect as the vault owner before rejoining a member.');
        return;
      }
      this.rejoinWaiting = new Set([...this.rejoinWaiting, membershipId]);
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      new Notice(
        `Havemind: could not request rejoin, ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }

  /**
   * Owner action: permanently remove a member from the vault. Revokes the
   * membership server-side (append-only, the member's past revisions and
   * attribution survive; their sessions are burned and they are terminally
   * locked out), then drops the member from the local roster and clears any
   * dead/waiting markers so no stale Rejoin affordance lingers. This is a
   * control-plane action and records nothing in the Activity feed. On success a
   * confirmation Notice names the removed member.
   */
  public async removeMember(membershipId: string): Promise<void> {
    const member = this.rosterMembers.find(
      (entry) => entry.membershipId === membershipId,
    );
    const displayName = member?.displayName ?? 'member';
    try {
      const removed = await revokeMembershipForOwner(this.plugin, { membershipId });
      if (removed === null) {
        new Notice(
          'Havemind: connect as the vault owner before removing a member.',
        );
        return;
      }
      this.rosterMembers = await this.rosterStore().removeMember(membershipId);
      this.rejoinWaiting = new Set(
        [...this.rejoinWaiting].filter((id) => id !== membershipId),
      );
      new Notice(`Removed ${displayName} from the vault.`);
      this.plugin.views.refreshOnboardingNow();
    } catch (error) {
      new Notice(
        `Havemind: could not remove member, ${
          error instanceof Error ? error.message : 'unexpected error'
        }`,
      );
    }
  }
}
