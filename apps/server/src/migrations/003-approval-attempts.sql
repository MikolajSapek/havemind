-- Approval retry cap (directional verification hardening): the joining device
-- shows a code that the owner types in. A server-authoritative counter bounds
-- code guessing to three attempts before the pending device is locked out and a
-- fresh invitation is required. Client-supplied counters are never trusted, so
-- the count lives on the invitation row the owner-approval path reads and writes
-- inside its transaction.

ALTER TABLE invitations
  ADD COLUMN approval_attempts INTEGER NOT NULL DEFAULT 0;
