-- F9 attachments/quota (plans/005): per-vault storage quota.
--
-- `quota_bytes` is the per-vault cap on the sum of DISTINCT stored blob bytes.
-- It is NULLABLE on purpose: NULL means "inherit the server-wide default"
-- (HAVEMIND_VAULT_QUOTA_BYTES / DEFAULT_VAULT_QUOTA_BYTES), so the owner can
-- set the effective quota purely via config/env, while an explicit per-vault
-- override remains possible by writing a non-NULL value. Existing vaults keep
-- NULL (inherit) after this forward-only migration — no backfill required.
--
-- The CHECK ceiling (64 GiB = 68719476736) mirrors MAX_VAULT_QUOTA_BYTES so a
-- mis-set per-vault value can never invalidate the free-disk guard.
--
-- Accounting stays opaque: the charged size is derived from `revisions.blob_size`
-- over the DISTINCT `blob_hash` set (see revisions_by_blob_hash), never from
-- payload contents, so no materialised counter column is introduced here.
ALTER TABLE vaults
  ADD COLUMN quota_bytes INTEGER
    CHECK (quota_bytes IS NULL OR (quota_bytes >= 0 AND quota_bytes <= 68719476736));
