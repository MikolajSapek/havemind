-- Per-device rejoin secret (F9 Rejoin hardening, audit finding #1).
--
-- The original rejoin redemption gated ONLY on the non-secret
-- (membership_id, device_id) binding plus a caller-chosen refresh-token hash.
-- Both ids are exposed to every vault member through event/receipt metadata
-- (memberId, deviceId), so any active collaborator who learned a victim's ids
-- could redeem a live rejoin grant with their OWN refresh hash and inherit the
-- victim's session and attribution. The binding is not a secret, so it cannot
-- be the credential.
--
-- This column adds a per-device capability: a 256-bit secret provisioned to the
-- legitimate device when it onboards (invitee redeem). Only the SHA-256 HASH is
-- stored here; the device keeps the plaintext and presents it at redemption,
-- where the server hashes and constant-time compares. An attacker never received
-- the secret, so knowing the ids alone no longer suffices.
--
-- NULLABLE on purpose (forward-only, no backfill): a device onboarded before
-- this migration has no secret hash. Redemption treats a NULL hash as
-- fail-closed — such a device cannot rejoin and must re-onboard. New invitee
-- devices provision a hash at redeem time, so they can rejoin.
ALTER TABLE devices
  ADD COLUMN rejoin_secret_hash TEXT
    CHECK (
      rejoin_secret_hash IS NULL OR
      (length(rejoin_secret_hash) = 64 AND rejoin_secret_hash NOT GLOB '*[^0-9a-f]*')
    );
