-- Per-device pull acknowledgement used to compact superseded history.
-- last_ack_sequence is the highest `after` cursor this device has presented,
-- i.e. the prefix of the vault log it has already materialised. NULL means
-- the device has not pulled since this column existed and must not allow
-- compaction (fail closed). last_ack_at is diagnostics only.
ALTER TABLE devices ADD COLUMN last_ack_sequence INTEGER;
ALTER TABLE devices ADD COLUMN last_ack_at TEXT;
