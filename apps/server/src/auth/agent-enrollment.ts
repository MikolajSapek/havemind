/**
 * One-click agents (plan 015): the owner enrolls an agent by name, the agents
 * service claims it.
 *
 * Claiming runs the server's own steps in-process, in one transaction: create
 * an agent invitation as the enrolling owner, redeem it with the refresh token
 * the service generated, approve it with the code the redemption returned. No
 * new way into a vault: every check those steps make still applies (the owner
 * must still be an active owner with that device), and the six digits are
 * skipped only because no channel carries them; the owner's own session
 * enrolled the agent. A retried claim with the same redemption id returns the
 * same agent.
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { InvitationError, type InvitationService } from './invitations.js';

export class AgentNameTakenError extends Error {
  override readonly name = 'AgentNameTakenError';
}

export interface ClaimedAgent {
  readonly vaultId: string;
  readonly vaultName: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly name: string;
}

interface EnrollmentRow {
  readonly id: string;
  readonly vaultId: string;
  readonly createdByMembershipId: string;
  readonly inviterDeviceId: string;
  readonly displayName: string;
}

export class AgentEnrollmentService {
  readonly #database: Database.Database;
  readonly #invitations: InvitationService;
  readonly #now: () => Date;

  constructor(database: Database.Database, invitations: InvitationService, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#invitations = invitations;
    this.#now = now;
  }

  /** Records an agent to add; the caller has checked the owner. Throws when the name is taken. */
  enroll(input: { vaultId: string; ownerMembershipId: string; ownerDeviceId: string; name: string }): string {
    const name = input.name.trim();
    return this.#database.transaction((): string => {
      const taken = this.#database
        .prepare(
          `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.vault_id = ? AND m.status = 'active' AND lower(u.display_name) = lower(?)
           UNION ALL
           SELECT 1 FROM agent_enrollments
           WHERE vault_id = ? AND claimed_at IS NULL AND dropped_at IS NULL AND lower(display_name) = lower(?)
           LIMIT 1`,
        )
        .get(input.vaultId, name, input.vaultId, name);
      if (taken !== undefined) throw new AgentNameTakenError(name);
      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO agent_enrollments (id, vault_id, created_by_membership_id, inviter_device_id, display_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.vaultId, input.ownerMembershipId, input.ownerDeviceId, name, this.#now().toISOString());
      return id;
    })();
  }

  /** The next waiting agent, completed for the service; null when none waits. */
  claim(input: { initialRefreshToken: string; redemptionId: string }): ClaimedAgent | null {
    return this.#database.transaction((): ClaimedAgent | null => {
      const done = this.#database
        .prepare(
          `SELECT e.vault_id AS vaultId, v.display_name AS vaultName, e.membership_id AS membershipId,
                  e.device_id AS deviceId, e.display_name AS name
           FROM agent_enrollments e JOIN vaults v ON v.id = e.vault_id
           WHERE e.redemption_id = ?`,
        )
        .get(input.redemptionId) as ClaimedAgent | undefined;
      if (done !== undefined) return done;

      for (;;) {
        const next = this.#database
          .prepare(
            `SELECT id, vault_id AS vaultId, created_by_membership_id AS createdByMembershipId,
                    inviter_device_id AS inviterDeviceId, display_name AS displayName
             FROM agent_enrollments
             WHERE claimed_at IS NULL AND dropped_at IS NULL
             ORDER BY created_at, id LIMIT 1`,
          )
          .get() as EnrollmentRow | undefined;
        if (next === undefined) return null;
        const claimed = this.#complete(next, input);
        if (claimed !== null) return claimed;
      }
    })();
  }

  #complete(row: EnrollmentRow, input: { initialRefreshToken: string; redemptionId: string }): ClaimedAgent | null {
    const now = this.#now().toISOString();
    let result: { membershipId: string; deviceId: string };
    try {
      const invitation = this.#invitations.createInvitation({
        vaultId: row.vaultId,
        createdByMembershipId: row.createdByMembershipId,
        inviterDeviceId: row.inviterDeviceId,
        intendedKind: 'agent',
        intendedMemberDisplayName: row.displayName,
      });
      const redeemed = this.#invitations.redeemInvitationForOnboarding({
        invitationToken: invitation.invitationToken,
        deviceLabel: `${row.displayName} (agent)`,
        initialRefreshToken: input.initialRefreshToken,
        redemptionId: input.redemptionId,
      });
      result = this.#invitations.approveRedeemedDevice({
        invitationId: invitation.invitationId,
        approverMembershipId: row.createdByMembershipId,
        verificationPhrase: redeemed.verificationPhrase,
      });
    } catch (error) {
      // The token the service sent is malformed: its fault, not the enrollment's.
      if (error instanceof InvitationError && error.code === 'INVALID_INPUT') throw error;
      // The owner who enrolled it is no longer an owner with that device: this
      // enrollment can never complete. Drop it, with the reason, and move on.
      this.#database
        .prepare('UPDATE agent_enrollments SET dropped_at = ?, dropped_reason = ? WHERE id = ?')
        .run(now, error instanceof InvitationError ? error.code : 'FAILED', row.id);
      return null;
    }
    this.#database
      .prepare(
        `UPDATE agent_enrollments SET claimed_at = ?, redemption_id = ?, membership_id = ?, device_id = ?
         WHERE id = ?`,
      )
      .run(now, input.redemptionId, result.membershipId, result.deviceId, row.id);
    const vault = this.#database.prepare('SELECT display_name AS name FROM vaults WHERE id = ?').get(row.vaultId) as {
      name: string;
    };
    return {
      vaultId: row.vaultId,
      vaultName: vault.name,
      membershipId: result.membershipId,
      deviceId: result.deviceId,
      name: row.displayName,
    };
  }
}
