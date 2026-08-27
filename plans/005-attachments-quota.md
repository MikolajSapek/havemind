# Havemind, plan: attachment storage quota per-vault

- Status: **Draft pending approval**
- Date: 2026-07-24
- Implements: `specs/003-open-source-release.md` (the gate "Stage 3, general beta": "Attachment synchronization, quotas and retention behavior are implemented"), extends `plans/001-technical-plan.md` §8 ("enforces explicit limits for bodies, batches, parent counts, note size and vault quota") and §11 Phase 8 (c) "attachments/quota".
- Dependencies: binary attachments are already implemented end-to-end (F9). This plan adds ONLY the aggregate storage limit; it does not change the payload format or the opaque-server boundary.

## Context, what already exists (do not re-plan this)

Implemented and working:

- `DEFAULT_MAX_PAYLOAD_BYTES = 36 * 1024 * 1024` (36 MiB) in `apps/server/src/sync/sync-routes.ts`, the upper bound of a single revision payload after base64 decoding.
- `DEFAULT_BODY_LIMIT_BYTES = 40 * 1024 * 1024` (40 MiB) in `apps/server/src/config.ts`; `MAX_BODY_LIMIT_BYTES = 64 * 1024 * 1024`, `MIN_BODY_LIMIT_BYTES = 1024`.
- `DEFAULT_MAX_BATCH_SIZE = 64` revisions per push request.
- Plugin allowlist: `png`/`jpg`/`pdf` up to 25 MB raw file (≈33.4 MB after base64, hence the 36 MiB payload).
- Content-addressed blob store (`apps/server/src/blob-store.ts`): `put` computes SHA-256, publishes atomically (temp → `fsync` → `rename` → parent-directory `fsync`), deduplicates globally by hash.
- Column `revisions.blob_size INTEGER NOT NULL CHECK (blob_size >= 0)` and index `revisions_by_blob_hash` (`apps/server/src/migrations/001-initial.sql`).
- `sweepOrphanedBlobs` (`apps/server/src/blob-gc.ts`), sweeps orphaned blobs ONLY at server startup, when no push is committing concurrently.
- Push path: `blobStore.put(payload)` **before** `commitRevision(...)` in a single loop over the batch; a rejected revision leaves the blob on disk until the startup sweep.

What is **missing** and what this plan designs:

1. An aggregate storage-byte limit per-vault (quota), a total cap on the vault.
2. Per-file and per-vault enforcement on the push path.
3. A new, stable opaque-server error code for exceeding the quota + client UX.
4. Interaction between the quota and the append-only history + `blob-gc` (old revisions retain blobs, accounting must account for that).
5. Protection against disk pressure on `sapserver` (a single ITX box, rule 7 from `plan/01-zasady-i-slownik.md`: 16 GB RAM, ~96 GB free disk).
6. A way for the owner/admin to view and set the quota.

## Spec

### S1. Accounting model (accounting for append-only + dedup)

The server remains opaque: it never computes a diff/provenance/merge (rule 3). The quota is a purely byte-based accounting over `blob_size`, which the server already knows from the receipt, it requires no inspection of payload content.

Definition of **`vault_storage_bytes`** for vault `V`:

```
vault_storage_bytes(V) = SUM(blob_size) over the SET OF DISTINCT blob_hash
                         referenced by any revision in V
```

Rationale for this definition:

- **The append-only history counts in full.** Every `blob_hash` that ever had a revision in `V`, including a revision that is no longer a head, is counted, until `blob-gc` removes it. This is deliberate: the pilot and the first real vault store full history (`plans/001` §7 "bootstraps a new device from complete retained history"), so the quota MUST reflect the real disk cost of history, not just the current heads. Quota must not be designed on heads alone, that would give the client the illusion that overwriting a large file frees space, when physically it does not.
- **DISTINCT blob_hash, not SUM over every revision.** Two revisions with identical content (the same `blob_hash`) share a single blob file (content-addressed store), so they count once. This matches the physical disk usage within the vault and does not penalize a client for an idempotent retry (the same `revision_id` + the same bytes).
- **Accounting is per-vault, even though the blob store is global.** The same blob shared between two vaults counts toward each vault's quota (an over-count relative to physical disk). This is an acceptable, safe direction of error: the quota is a vault's logical budget, not physical-disk bookkeeping. Physical disk is protected by a separate mechanism, S6 (free-disk guard).

Accounting query (parameterized, uses `revisions_by_blob_hash`):

```sql
SELECT COALESCE(SUM(blob_size), 0) AS used
FROM (
  SELECT blob_hash, MAX(blob_size) AS blob_size
  FROM revisions
  WHERE vault_id = ?
  GROUP BY blob_hash
);
```

For performance (to avoid a scan on every push on a large vault), a **materialized sum** is
maintained, see S3 (`vaults.storage_bytes` column), and the query above is the canonical source
of truth for validation/reconstruction of the counter (rebuild after restore, consistency test).

### S2. Limits and their default values

- **`vault_quota_bytes`**, the aggregate storage limit per-vault. Default: `2 * 1024 * 1024 * 1024` (2 GiB) per vault. Rationale: two disposable pilot vaults + a margin for history fit comfortably within `sapserver`'s ~96 GB free disk, while the limit is low enough that a single client cannot fill up the ITX box (S6/threat model). Configurable per-vault (S5).
- **`MAX_VAULT_QUOTA_BYTES`**, a hard configuration ceiling, `64 * 1024 * 1024 * 1024` (64 GiB). The admin cannot set the quota above this ceiling without a code change; this protects against an accidental `999999` that would invalidate S6.
- **The per-file limit remains `DEFAULT_MAX_PAYLOAD_BYTES` (36 MiB)**, unchanged. This plan does not raise the single-payload limit; per-file quota enforcement is the existing 36 MiB control, and the new part is aggregate per-vault enforcement.
- All default limits are defined as exported constants alongside the existing ones (`DEFAULT_MAX_PAYLOAD_BYTES`), with an env override (`HAVEMIND_VAULT_QUOTA_BYTES`) validated by the same `parseBoundedInteger` as `HAVEMIND_BODY_LIMIT_BYTES` (min 0, max `MAX_VAULT_QUOTA_BYTES`).

### S3. Enforcement on the push path (opaque, atomic)

A new error code in the `SyncErrorCode` union (`sync-routes.ts`): **`QUOTA_EXCEEDED`**, mapped to
HTTP **`413 Payload Too Large`** (semantically: content rejected because it exceeds the storage
budget; `413` is more fitting than `507`, since it concerns the vault's logical budget, not a
server disk failure, `507` is reserved for S6). The code carries no secrets, kept separate from
the human-readable text (rule: "Stable machine error codes are separate from human text").

Enforcement is **two-stage**, to close the accounting race and shut the "orphaned blobs on disk"
vector (see threat model):

1. **Pre-check before `blobStore.put`** (a cheap defense against writing to disk): for each
   revision in the batch, before the payload reaches `put`, the server reads the current
   `vaults.storage_bytes` and adds the `blob_size` bytes already accepted within THIS batch plus
   the size of the current payload, provided its `blob_hash` does not yet occur in the vault or in
   the already-accepted prefix of the batch. If the sum > `vault_quota_bytes` → the revision is
   rejected with `QUOTA_EXCEEDED` **without calling `put`** (no byte lands on disk). The pre-check
   is optimistic (outside the transaction), so it is not authoritative, it only serves to cut off
   writing large payloads that wouldn't fit anyway.
2. **Authoritative check inside `BEGIN IMMEDIATE`** in `commitRevision`: in the same transaction
   that inserts the revision/parents/heads/event/cursor (`plans/001` §8 "one `BEGIN IMMEDIATE`
   transaction"), after determining that the `blob_hash` is new to the vault, the server computes
   `storage_bytes + blob_size` and if it exceeds `vault_quota_bytes` → abort the transaction,
   return `QUOTA_EXCEEDED`. Since better-sqlite3 has a single writer and `BEGIN IMMEDIATE` takes
   the write lock, the check and the counter increment are atomic, there is no TOCTOU between
   reading `used` and writing the revision.
3. **Increment the counter in the same transaction:** upon accepting a revision with a
   `blob_hash` new to the vault, `UPDATE vaults SET storage_bytes = storage_bytes + ? WHERE id = ?`.
   An idempotent retry (the same `revision_id`/`idempotency_key`) does NOT increment again, it
   hits the existing idempotency path and returns the original receipt, since the `blob_hash`
   already belongs to the vault. A revision whose `blob_hash` is already present in the vault
   (dedup) does NOT increment the counter.

`storage_bytes` is a new column: `ALTER TABLE vaults ADD COLUMN storage_bytes INTEGER NOT NULL
DEFAULT 0 CHECK (storage_bytes >= 0)` (migration `002-*`, forward-only, idempotently recorded,
`plans/001` §8/§CI). The migration backfills `storage_bytes` using the canonical query from S1
for every existing vault, within the same migration transaction.

The opaque boundary is preserved: the server uses only `blob_size` (which it already computes
from the received bytes) and `blob_hash`. It does not decode, diff, or interpret the payload.

### S4. Interaction with `blob-gc` (freeing space)

Today `sweepOrphanedBlobs` removes blobs that no revision (in any vault) references, only at
startup. In the pilot's append-only model no revision ever disappears, so no blob becomes
orphaned during normal operation, the quota grows monotonically up to the cap. This is
deliberate and honest (`plan/01` "Honesty as a feature"): the client learns that history costs
space before the vault fills up.

Counter-consistency rule regarding GC: **`blob-gc` MUST decrement `storage_bytes` for every
affected vault.** Since the sweep is global (an orphaned blob = no reference in ANY vault), after
determining the list of hashes to remove, the sweep, in a single transaction with the record
removal, recomputes `storage_bytes` for every vault using the canonical S1 query (a rebuild, not
an incremental decrement, simpler and resistant to drift). In the current pilot the sweep only
ever runs at startup on idle traffic anyway, so a full rebuild of all `vaults.storage_bytes` at
startup is cheap and simultaneously self-healing for the counter after every restart.
**Decision: rebuilding `storage_bytes` for all vaults is part of the startup sequence right after
`sweepOrphanedBlobs`, before accepting connections.**

History compaction (removing old revisions to free up quota) is OUT of scope for this plan, it
belongs to a separate "encrypted checkpoints/retention" plan (`plans/001` §11 Phase 8 (d)). This
plan deliberately does NOT remove history to free space; on a full vault the client gets
`QUOTA_EXCEEDED` and must wait for the retention plan, or the owner raises the quota (S5) within
the bounds of `MAX_VAULT_QUOTA_BYTES` and free disk.

### S5. Admin/owner surface (viewing and setting)

Per `plans/001` §8 "local administrator diagnostics", no new public API, no React:

- **Read (vault member):** extend the existing membership/vault listing response with
  `storageBytes` and `quotaBytes` fields (only for the active member of that vault; deny-by-default
  like the rest of the protected routes). The client shows "X MB / Y GB used" on the connection
  card.
- **Set (local owner/admin):** a server CLI command (alongside `havemind doctor`/`backup`,
  `plans/001` §8), e.g. `havemind vault-quota <vaultId> --set <bytes>` and
  `havemind vault-quota <vaultId>` (read). The CLI validates `0 < bytes <= MAX_VAULT_QUOTA_BYTES`,
  writes to a new `vaults.quota_bytes` column (migration `002-*`: `ADD COLUMN quota_bytes INTEGER
  NOT NULL DEFAULT <default> CHECK (quota_bytes >= 0 AND quota_bytes <= <MAX>)`), and runs locally
  on the machine (no remote API mutating the quota). Setting the quota BELOW the current
  `storage_bytes` is allowed (it blocks new writes, does not delete history) and prints a warning.
- Enforcement in S3 reads `vaults.quota_bytes` (per-vault), with a fallback to
  `HAVEMIND_VAULT_QUOTA_BYTES`/the default constant only for vaults created before the migration
  (the migration's backfill assigns everyone a value, so the fallback is only a safety net).

### S6. Protection against `sapserver` disk pressure (free-disk guard)

The per-vault quota protects the logical budget, but does not protect the ITX box's physical disk
against the sum of all vaults + WAL + backups. Hence an independent **free-disk guard**:

- Before accepting a write (on entry to the push route, before `put`), the server checks free
  space on the data-root filesystem via `statfs`/`fs.statfs`. If free space < **`MIN_FREE_DISK_BYTES`**
  (default `2 * 1024 * 1024 * 1024`, 2 GiB, configurable via `HAVEMIND_MIN_FREE_DISK_BYTES`) →
  the entire push is rejected with a new code **`STORAGE_UNAVAILABLE`** → HTTP
  **`507 Insufficient Storage`**. Fail-closed (`plans/001` §8 "fails closed"): on a `statfs` error
  the server also rejects the write.
- The guard is per-request and cheap (one `statfs`), checked once per push (not per revision).
  Reads (`GET events`/`GET blobs`) are NOT blocked, reading does not increase disk pressure.
- This is the last line of defense shared across all vaults, independent of the quota; it also
  protects the WAL and the backup directory on the shared data-root.

## Threat model

Gate quote: the server's network surface becomes more broadly reachable only from **"Stage 2,
public technical alpha"** (`specs/003-open-source-release.md`, "## Release stages and gates"),
when the repository becomes public and a "one-command server quick start" appears, other
self-hosters start running this code on their own machines. Therefore the DoS/disk-pressure
protections in this plan (S3 pre-check, S6 free-disk guard) MUST be ready and tested **before**
"Stage 2, public technical alpha", even though the quota feature itself formally fulfils the
Stage 3 gate ("Attachment synchronization, quotas and retention behavior are implemented").
Skipping these protections would mean shipping code that a cheap disk-filling DoS can bring to
its knees, unacceptable for the public alpha quick start.

### T1. Device fills up the disk (DoS)

- **Vector A, one huge file:** bounded by the existing `DEFAULT_MAX_PAYLOAD_BYTES` (36 MiB) and
  `DEFAULT_BODY_LIMIT_BYTES` (40 MiB). Unchanged.
- **Vector B, many files / history:** a client pushes hundreds of distinct 25 MB files, or
  repeatedly modifies one file with new bytes (append-only → every new `blob_hash` counted).
  Defense: the per-vault quota (S3) stops the vault at `vault_quota_bytes`; once exceeded, every
  new blob → `QUOTA_EXCEEDED`.
- **Vector C, orphaned blobs from rejected revisions (critical, specific to this path):** today
  `put` writes the payload to disk BEFORE `commitRevision`; if the quota were checked only inside
  the transaction, a client could push payloads that get rejected for quota, and each of them
  could still write up to 36 MiB to disk (×64 per batch × many requests), and orphaned blobs are
  swept only at server startup, i.e. never during the attack. **Defense: the S3 pre-check before
  `put`**, a payload that certainly won't fit within the quota is never written at all.
  Additionally, S6's free-disk guard cuts off the entire push once free space drops below the
  threshold, regardless of quota state. **The startup sweep must not be relied upon as a
  real-time DoS defense**, it exists to clean up after failures, not to repel an attack.

### T2. Quota-accounting races

- **TOCTOU check-then-write:** two concurrent pushes to the same vault could both pass the
  pre-check with `used` just under the cap and both commit, exceeding the quota. **Defense:** the
  authoritative check in S3 is INSIDE `BEGIN IMMEDIATE`, and better-sqlite3 has a single writer
  with a write lock, the second commit already sees the first commit's incremented
  `storage_bytes` and is rejected. The pre-check outside the transaction is only an optimization,
  never the sole barrier.
- **Double-counting on retry:** an idempotent retry (the same `revision_id`) must not increment
  the counter twice. **Defense:** the increment happens only for a `blob_hash` not yet present in
  the vault; a retry hits the existing idempotency path (`plans/001` §7 "identical revision ID
  and identical blob digest returns the original result") and does not change the counter.
- **Counter vs. reality drift:** the materialized `storage_bytes` could drift from the canonical
  S1 query after a crash/restore. **Defense:** rebuild all `vaults.storage_bytes` from S1 at
  startup (S4), after a restore (a new `server_epoch`), and as a consistency test. The canonical
  source of truth is always the S1 query, never the counter alone.
- **Race with blob-gc:** the sweep and the quota increment on the push path must not interleave.
  **Defense:** the sweep (and its accompanying counter rebuild) runs only at startup, when no push
  is committing (`blob-gc.ts`, an existing guarantee); this plan does not break that guarantee.

### T3. Interaction with the rate-limit-exempt blob GET

`GET /vaults/:vaultId/blobs/:blobHash` reads a blob without recomputing the hash (`blob-store.ts`
`read`/`#readExisting`), deliberately cheap on the hot path. The route is protected (vault
membership, `blobBelongsToVault`, cross-vault probing learns nothing). Threats and their status:

- **Read amplification:** a member can repeatedly fetch large blobs. The quota does NOT limit
  reads (it's a storage budget, not a transfer budget). This is out of scope for this plan, it
  belongs to the rate-limiting layer (`plans/001` §8 "Rate limits apply before authentication and
  per authenticated member/device"). This plan does NOT weaken this and does NOT fix it; noted
  explicitly as a known boundary.
- **GET does not increase disk pressure:** hence S6's free-disk guard deliberately does NOT block
  reads, blocking GET under low disk would only hinder clients from fetching and freeing state,
  without helping the disk.
- **Quota creates no new leak channel via GET:** exposing `storageBytes`/`quotaBytes` (S5) is
  limited to the active member of that vault; it reveals no data from other vaults or content. No
  new IDOR: the same membership checks as the existing routes.

## Acceptance tests

All tests are functional, RED-first (rule 2), against real temporary SQLite + a blob directory
(`plans/001` §12 "Integration"). Labeled AT-n.

- **AT-1 (append-only accounting):** create a vault with `quota_bytes = 100`. Push a revision with
  a 60 B blob (new file) → accepted, `storage_bytes = 60`. Push a second revision of the same file
  with a 60 B blob (a different `blob_hash`, a modification) → **`QUOTA_EXCEEDED` (413)**, since
  60+60 > 100 even though it's an "overwrite". `storage_bytes` remains 60. Proves history counts
  in full.
- **AT-2 (dedup does not double-count):** `quota_bytes = 100`. Push a 60 B blob to file A →
  accepted. Push identical bytes (the same `blob_hash`) to file B → accepted, `storage_bytes`
  still 60. Proves counting by DISTINCT `blob_hash`.
- **AT-3 (idempotent retry does not increment):** push a 60 B revision → accepted,
  `storage_bytes = 60`. Repeat the identical push (same `revision_id`/`idempotencyKey`) → the
  same receipt, `storage_bytes` still 60.
- **AT-4 (exact boundary):** `quota_bytes = 120`, a 60 B blob → OK (used 60), a second different
  60 B blob → OK (used 120, exactly at the boundary), a third 1 B blob → `QUOTA_EXCEEDED`. Proves
  `<=` the cap is allowed, `>` is rejected.
- **AT-5 (pre-check does not write to disk, defends T1/C):** `quota_bytes = 10`. Push a batch
  with a 25 MB payload (a new `blob_hash`) → `QUOTA_EXCEEDED`, and the blob directory does NOT
  contain a file for that hash (`listHashes` doesn't return it). Proves a quota-rejected payload
  never lands on disk.
- **AT-6 (authoritativeness inside the transaction, race T2):** two concurrent pushes of
  different 60 B blobs to a vault with `quota_bytes = 100`, each passing the pre-check at
  `used = 0`. Exactly one is accepted, the other → `QUOTA_EXCEEDED`; final `storage_bytes = 60`,
  never 120. (Simulated by injecting an interleaving point between the pre-check and the commit,
  consistent with the existing crash-point tests.)
- **AT-7 (stable error code and status, no secrets):** a quota-rejected push returns exactly
  `{ error: { code: "QUOTA_EXCEEDED" } }` with HTTP 413 and `cache-control: no-store`; the body
  contains no paths, no other vaults' sizes, and no human-readable text.
- **AT-8 (counter rebuild = canonical query):** after a series of acceptances, manually corrupt
  `vaults.storage_bytes` (set it to 0), restart the server → after startup `storage_bytes` equals
  the result of the canonical S1 query. Proves the counter self-heals.
- **AT-9 (blob-gc decrements):** (a preparatory test for retention) after a sweep removes a blob
  with no remaining revision, `storage_bytes` for the affected vaults matches the canonical S1
  query. In the current append-only pilot the sweep removes nothing, the test creates an
  artificial orphaned blob (a revision rejected before commit) and verifies that after startup the
  counter still matches S1.
- **AT-10 (free-disk guard, S6/T1):** with `statfs` mocked to return free space <
  `MIN_FREE_DISK_BYTES`, a push returns `STORAGE_UNAVAILABLE` (507) and does NOT call `put`;
  `GET events` and `GET blobs` in the same state work normally (200). On a `statfs` error, a push
  also → 507 (fail-closed).
- **AT-11 (admin CLI sets and reads the quota):** `havemind vault-quota <id> --set N` writes
  `quota_bytes = N`; setting `N > MAX_VAULT_QUOTA_BYTES` → validation error, no write; setting
  `N < storage_bytes` → write + warning, subsequent pushes rejected with `QUOTA_EXCEEDED`,
  history untouched.
- **AT-12 (exposure only to members):** listing the vault returns `storageBytes`/`quotaBytes` to
  the active member; a non-member (a foreign `session`) → the existing `FORBIDDEN (403)`, no
  leaked numbers.
- **AT-13 (migration backfill):** on a database with existing revisions predating migration
  `002-*`, after migration each vault's `vaults.storage_bytes` == the canonical S1 query, and
  `quota_bytes` == the default value; the migration is idempotently recorded, a repeat start does
  not change the values.

## Rollout/rollback

### Deployment order (forward-only, one PR per coherent step)

1. **Migration `002-quota.sql`** (`apps/server/src/migrations/`): `ALTER TABLE vaults ADD COLUMN
   storage_bytes ...`, `ADD COLUMN quota_bytes ...`, backfill both columns with the canonical S1
   query within the migration transaction. Ordered, transactional, idempotently recorded, tested
   from the current schema as origin (`plans/001` §CI "SQLite migrations are ordered,
   transactional ..., idempotently recorded and tested from every supported upgrade origin").
   Test: AT-13.
2. **Constants and config:** `DEFAULT_VAULT_QUOTA_BYTES`, `MAX_VAULT_QUOTA_BYTES`,
   `MIN_FREE_DISK_BYTES` + parsing of `HAVEMIND_VAULT_QUOTA_BYTES`/`HAVEMIND_MIN_FREE_DISK_BYTES`
   via the existing `parseBoundedInteger`.
3. **Enforcement in repository/sync-routes:** the `QUOTA_EXCEEDED` code + status/sync-code
   mappings; pre-check + authoritative check + increment in `commitRevision`; the
   `STORAGE_UNAVAILABLE` free-disk guard. Tests AT-1..AT-10.
4. **Counter rebuild at startup** right after `sweepOrphanedBlobs` + after restore. Tests AT-8,
   AT-9.
5. **CLI + read exposure** in vault listing. Tests AT-11, AT-12.
6. Local gate (order is critical): `npm run build` → `npm run typecheck` → eslint on affected
   files → `npm test` → `npm run test:integration`. Rebuild changed workspace packages before
   downstream tests if they consume `dist/`.

### Deploy to `sapserver`

Per the established operational boundary: the agent performs only unprivileged operations
(rsync of sources); **the Docker rebuild and restart are done by the user** (operations requiring
`docker`/`sudo`, rule 9 from `plan/01-zasady-i-slownik.md`). The redeploy sequence is unchanged
from the current one (rebuild container → reload both plugins → smoke-test with an attachment
sync), extended with a smoke test for exceeding the quota on one disposable vault. The restart
runs migration `002-*` and rebuilds the counter automatically.

### Rollback

- **Code:** this plan does not change the payload format, the revision envelope, or the opaque
  boundary, a previous container image reads the same database. Rollback = restoring the
  previous image; the new `vaults.storage_bytes`/`quota_bytes` columns are ignored by the older
  code (SQLite tolerates extra columns). No downgrade migration (`specs/003` "Database downgrade
  migrations are not promised", `plans/001` §8 "Rollback uses the matching prior image and
  backup, never an in-place schema downgrade").
- **Emergency disabling of enforcement without a code rollback:** set
  `HAVEMIND_VAULT_QUOTA_BYTES` (or the per-vault `quota_bytes` via CLI) to `MAX_VAULT_QUOTA_BYTES`
  and `HAVEMIND_MIN_FREE_DISK_BYTES=0` → the quota and the free-disk guard become practically
  inactive, with no code change. Useful if enforcement were to falsely block the pilot.
- **Backup before migration:** a verified backup is required before the first irreversible
  migration (`specs/003`, `plans/001` §8). Irreversible operations on the backup
  (`restic forget --prune`, `docker compose down --volumes`), always a question to the user
  (rule 9).
- **Security gate:** the DoS/disk-pressure protections (S3 pre-check, S6) must be green in CI
  **before** "Stage 2, public technical alpha"; the quota feature itself formally closes the
  "Stage 3, general beta" gate. Publishing the repo/Release/Obsidian plugin, always a question
  to the user (rule 9, `plans/001` §14 "Ask first").
