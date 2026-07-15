CREATE TABLE instance_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE CHECK (length(instance_id) > 0),
  server_epoch TEXT NOT NULL CHECK (length(server_epoch) > 0),
  restore_epoch INTEGER NOT NULL DEFAULT 0 CHECK (restore_epoch >= 0),
  initialized_at TEXT NOT NULL CHECK (length(initialized_at) > 0)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  is_instance_owner INTEGER NOT NULL DEFAULT 0
    CHECK (is_instance_owner IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  revoked_at TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_instance_owner
ON users (is_instance_owner)
WHERE is_instance_owner = 1 AND status = 'active';

CREATE TABLE devices (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  public_key BLOB NOT NULL CHECK (length(public_key) > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  approved_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE INDEX devices_by_user ON devices (user_id, status);

CREATE TABLE vaults (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  write_epoch INTEGER NOT NULL DEFAULT 0 CHECK (write_epoch >= 0),
  next_server_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (next_server_sequence > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  deleted_at TEXT
) STRICT;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  revoked_at TEXT,
  UNIQUE (vault_id, user_id)
) STRICT;

CREATE INDEX memberships_by_user ON memberships (user_id, status);

CREATE TABLE owner_pairings (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND
    token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  consumed_at TEXT,
  consumed_by_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (
    (consumed_at IS NULL AND consumed_by_device_id IS NULL) OR
    (consumed_at IS NOT NULL AND consumed_by_device_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX owner_pairings_by_expiry
ON owner_pairings (expires_at, consumed_at);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  created_by_membership_id TEXT NOT NULL
    REFERENCES memberships(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  intended_role TEXT NOT NULL DEFAULT 'editor'
    CHECK (intended_role IN ('owner', 'editor')),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  consumed_at TEXT,
  consumed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX invitations_by_vault
ON invitations (vault_id, expires_at, consumed_at);

CREATE TABLE refresh_token_families (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'reuse-detected')),
  current_generation INTEGER NOT NULL DEFAULT 0
    CHECK (current_generation >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  revoked_at TEXT,
  UNIQUE (id, device_id)
) STRICT;

CREATE INDEX refresh_token_families_by_device
ON refresh_token_families (device_id, status);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  family_id TEXT NOT NULL
    REFERENCES refresh_token_families(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  consumed_at TEXT,
  rotation_id TEXT,
  successor_token_hash TEXT CHECK (
    successor_token_hash IS NULL OR (
      length(successor_token_hash) = 64 AND
      successor_token_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  CHECK (
    (consumed_at IS NULL AND rotation_id IS NULL AND
      successor_token_hash IS NULL) OR
    (consumed_at IS NOT NULL AND length(rotation_id) > 0 AND
      successor_token_hash IS NOT NULL)
  ),
  UNIQUE (family_id, generation)
) STRICT;

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  family_id TEXT NOT NULL
    REFERENCES refresh_token_families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND
    token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  revoked_at TEXT
) STRICT;

CREATE INDEX access_tokens_by_family
ON access_tokens (family_id, expires_at, revoked_at);

CREATE INDEX access_tokens_by_device
ON access_tokens (device_id, expires_at, revoked_at);

CREATE TABLE files (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT;

CREATE INDEX files_by_vault ON files (vault_id, id);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  server_sequence INTEGER NOT NULL CHECK (server_sequence > 0),
  write_epoch INTEGER NOT NULL CHECK (write_epoch >= 0),
  protected_header BLOB NOT NULL CHECK (length(protected_header) > 0),
  protected_header_hash TEXT NOT NULL UNIQUE
    CHECK (length(protected_header_hash) = 64),
  blob_hash TEXT NOT NULL CHECK (length(blob_hash) = 64),
  blob_size INTEGER NOT NULL CHECK (blob_size >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) > 0),
  UNIQUE (vault_id, server_sequence)
) STRICT;

CREATE INDEX revisions_by_file_sequence
ON revisions (file_id, server_sequence);

CREATE INDEX revisions_by_blob_hash ON revisions (blob_hash);

CREATE TABLE revision_parents (
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  parent_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  parent_order INTEGER NOT NULL CHECK (parent_order >= 0),
  PRIMARY KEY (revision_id, parent_revision_id),
  UNIQUE (revision_id, parent_order),
  CHECK (revision_id <> parent_revision_id)
) STRICT;

CREATE INDEX revision_parents_by_parent
ON revision_parents (parent_revision_id, revision_id);

CREATE TABLE file_heads (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, revision_id)
) STRICT;

CREATE TABLE vault_events (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  server_sequence INTEGER NOT NULL CHECK (server_sequence > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  revision_id TEXT REFERENCES revisions(id) ON DELETE CASCADE,
  event_payload TEXT NOT NULL CHECK (json_valid(event_payload)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (vault_id, server_sequence)
) STRICT;

CREATE TABLE idempotency_records (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_status INTEGER NOT NULL CHECK (
    response_status >= 100 AND response_status <= 599
  ),
  response_body TEXT NOT NULL CHECK (json_valid(response_body)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  PRIMARY KEY (device_id, idempotency_key)
) STRICT;

CREATE INDEX idempotency_records_by_expiry
ON idempotency_records (expires_at);
