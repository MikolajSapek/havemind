-- Vault scope for devices (AUD2-04: cross-vault device revocation).
--
-- Revoking a membership burns every device the member owns plus every refresh
-- family and access token bound to those devices. The device row carried no
-- vault, so the burn was selected with `WHERE user_id = ?` alone: a member who
-- belongs to two vaults and loses access to one was locked out of BOTH. That is
-- a silent, unrecoverable over-reach — the member's other vault is intact, its
-- membership still active, yet the device can no longer authenticate.
--
-- This column records the vault a device was onboarded into, so revocation can
-- scope its burn to that vault. Every path that creates a device knows its vault
-- (owner pairing carries `owner_pairings.vault_id`; invitee redemption carries
-- `invitations.vault_id`), so newly onboarded devices are always scoped.
--
-- NULLABLE on purpose. Two reasons:
--   1. SQLite requires an added column with a REFERENCES clause to default to
--      NULL while `PRAGMA foreign_keys = ON`.
--   2. A device onboarded before this migration whose vault cannot be proven
--      stays NULL, and revocation treats NULL as "unknown scope" — it keeps
--      burning such a device, i.e. fails closed exactly as it did before. NULL
--      never widens access; it only preserves the old, stricter behaviour.
-- No ON DELETE action on purpose: nothing in the server hard-deletes a vault
-- (deletion is the soft `vaults.deleted_at` flag), and NO ACTION refuses to
-- silently blank a device's scope, which would quietly widen the revocation
-- burn back to every vault.
ALTER TABLE devices
  ADD COLUMN vault_id TEXT REFERENCES vaults(id);

-- Conservative backfill: only a user with exactly ONE membership row has an
-- unambiguous vault, so only those devices are scoped. A user with zero or
-- several memberships stays NULL rather than being guessed at — an incorrect
-- guess would either miss a burn (too permissive) or burn the wrong vault's
-- device (the very bug being fixed). Membership status is deliberately ignored:
-- the question is which vault the device belongs to, not whether access is live.
UPDATE devices
SET vault_id = (
  SELECT memberships.vault_id
  FROM memberships
  WHERE memberships.user_id = devices.user_id
)
WHERE (
  SELECT COUNT(*) FROM memberships WHERE memberships.user_id = devices.user_id
) = 1;

CREATE INDEX devices_by_vault ON devices (vault_id, status);
