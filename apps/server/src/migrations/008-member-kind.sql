-- Member kind (plan 014): a person or an AI agent.
--
-- An agent joins a vault like a person, through an owner's invitation and the
-- six-digit approval, and has exactly an editor's permissions: every owner
-- action (invite, approve, remove, rejoin grant) already refuses a non-owner.
-- The kind only says what the member is, so the plugin can show agents apart
-- (yellow) from people (violet).
--
-- The owner decides the kind when inviting (`invitations.intended_kind`); the
-- joining client never supplies it (rule 3: no trust in client-asserted
-- identity). Approval copies it to the membership. Every existing row is a
-- person, which is what the DEFAULT backfills.
ALTER TABLE memberships
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'
    CHECK (kind IN ('person', 'agent'));

ALTER TABLE invitations
  ADD COLUMN intended_kind TEXT NOT NULL DEFAULT 'person'
    CHECK (intended_kind IN ('person', 'agent'));
