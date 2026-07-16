-- Onboarding HTTP surface (F8-02c): the two-device invitation flow needs the
-- invitee's intended identity known at review time and the invitee's own
-- credentials (pending-poll credential + deferred initial refresh token) bound
-- to the invitation between redemption and owner approval. Only hashes of the
-- pending credential and the deferred refresh token are ever stored, matching
-- the server's hash-only secret rule.

ALTER TABLE invitations
  ADD COLUMN intended_member_display_name TEXT;

ALTER TABLE invitations
  ADD COLUMN intended_member_id TEXT;

ALTER TABLE invitations
  ADD COLUMN pending_credential_hash TEXT;

ALTER TABLE invitations
  ADD COLUMN pending_refresh_token_hash TEXT;

CREATE INDEX invitations_by_pending_credential
ON invitations (pending_credential_hash);
