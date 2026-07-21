-- Rejoin grants (F9 Rejoin): once a pairing is established it is persistent
-- until explicitly broken. If the invitee's connection dies terminally (refresh
-- family burned by reuse detection, 401 terminal, quarantine), the OWNER
-- re-admits that EXACT known contact without re-running the full pairing flow
-- (no new PIN, nothing to read aloud). A grant is bound server-side to the
-- (membership_id, device_id) pair recorded at the original approval; redemption
-- proves possession of that binding (the invitee's data.json) and never trusts
-- an actor identity from the request body. Grants are single-use (consumed_at
-- guard) and short-lived (15 minutes), mirroring the invitation contract.

CREATE TABLE rejoin_grants (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_by_membership_id TEXT NOT NULL
    REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  consumed_at TEXT
) STRICT;

CREATE INDEX rejoin_grants_by_binding
ON rejoin_grants (membership_id, device_id, expires_at, consumed_at);
