# Current limitations and historical pilot record

Status as of 2026-08-25. The pilot record below is retained for traceability;
it is not an instruction to use an outdated plugin build or a disposable vault.
For current installation and operation, use [self-hosting](../self-hosting.md)
and the [closed beta guide](../beta/README.md).

## Auto-formatters on two machines (AUD-03)

**Fixed (commit `37e609d`).** Content is now canonicalised before
hashing, with a 1.5-second "settling" window and a one-off rebase of
base hashes on plugin update. Differences in auto-formatter settings
(e.g. Linter with "format on save", Prettier-for-Obsidian) between machines,
line width, quote style, trailing newline, no longer generate churn or
entries in `Havemind Conflicts/`. Binary attachments are excluded from the rebase:
their base hash is computed over raw bytes, not text, so
text canonicalisation does not affect them.

**Recommendation:** none, the full fix is already in the pilot and requires no manual
synchronisation of formatter settings.

## Dot-paths and the reserved folder (AUD-07)

Verified against `apps/obsidian-plugin/src/obsidian/vault-adapter.ts`
(`classifyVaultPath` / `eligibleKind`) and `packages/protocol/src/canonicalization.ts`
(`RESERVED_ROOTS`). The producer excludes a path when any of these hold:

1. **Any path segment starts with a dot** (e.g. `Notes/.drafts/x.md`,
   `Notes/.hidden.md`, `.trash/x.md`). This also covers everything under
   `.obsidian/` that the appearance allowlist does not name.
2. **The top-level folder is the reserved `Havemind Conflicts/`.** Matched
   case-insensitively, so `havemind conflicts/` and `HAVEMIND CONFLICTS/` are
   excluded too (they are the same folder on macOS and Windows). Only the *top*
   level is reserved: `Notes/Havemind Conflicts/x.md` and a lookalike sibling
   such as `Havemind Conflicts Archive/x.md` **do** sync.
3. **The extension is not syncable.** Only `.md` and the binary allowlist
   (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `pdf`) qualify. The extension
   test is case-insensitive, so `pic.PNG` syncs.

Rule 3 is applied before rules 1 and 2, so a non-syncable extension is excluded
regardless of where it lives. The direction is safe (under-sync, never
over-sync), but excluded notes stay local **without any warning in the UI**.

**Exception (as of commit `dcd366f`):** `.obsidian/` has a separate appearance
mirror for themes, snippets, appearance, hotkeys, core-plugin and graph settings,
checked *before* the dot-path guard. It is an explicit allowlist: all third-party
plugin code and data, every `data.json`, `workspace.json` and
`community-plugins.json` stay local on each machine. Outside this exception,
`.obsidian/` is still subject to the general dot-path guard described above.

**Recommendation:** do not keep your own notes in dot-paths or in the
`Havemind Conflicts/` folder.

**Fixed alongside this note (2026-09-03):** the producer compared the reserved
root case-SENSITIVELY while the protocol folds case, so a note in
`havemind conflicts/` was classified eligible, enqueued, and then threw inside
`canonicalizeVaultPath` at envelope-build time, killing the push cycle. Both
layers now fold case; pinned by
`apps/obsidian-plugin/src/obsidian/vault-adapter.test.ts`, "excludes a case
variant of the reserved root" and "never classifies eligible a path the protocol
reserves".

## Sync scope

Besides `.md` notes, binary attachments in the allowed
formats also sync: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `pdf` (commits
`acbf46e`, `b7c663a`, `6959e90`). The hard file size limit is 25 MB,
an attachment above the limit is excluded with a notification (this is not an error)
and never blocks the scan or the sync of the rest of the vault. Any other
format, outside the allowed list and `.md`, remains unsynced and
is counted in reconciliation as an excluded attachment.

## Backup and restore (AUD-10)

**Implemented and covered by tests** (`apps/server/src/backup-scheduler.test.ts`,
`backup-cli.test.ts`, `backup-restore.test.ts`):

- the server itself writes backup artefacts on a time-based loop to the directory pointed
  to by `HAVEMIND_BACKUP_DIR` (disabled by default; `HAVEMIND_BACKUP_INTERVAL_HOURS`
  = 24 h, `HAVEMIND_BACKUP_KEEP` = 7). It does this itself because the operator account has no
  `docker` group or passwordless `sudo`, so cron cannot call `docker exec`;
- `havemind backup [--to <dir>]`, `havemind backup verify`, `havemind backup restore`
, one-off run and restore to a temporary directory;
- `deploy/compose.yaml` mounts `./backups:/backups`;
- `ops/sapserver/restic/*` targets **real data** (the host side of the bind
  mount, not staging) and sends it via **SFTP to the owner's Mac over the tailnet**
  (the old, unworkable SMB / UniFi Cloud Key target has been removed). Retention 7/4/6
  unchanged; a sleeping Mac is a logged *skip*, not an error;
- `ops/sapserver/restic/restore-drill.sh`, a full restore attempt with a single
  PASS/FAIL result, runnable entirely with user-level permissions.

**Historical activation prerequisites** (full list:
`ops/sapserver/restic/README.md`, "Activation checklist" section):

- **X.** on the Mac: enable Remote Login, create `~/havemind-restic`, add
  the sapserver's public key to `~/.ssh/authorized_keys`;
- **Y.** on sapserver: generate an SSH key and the `havemind-backup` alias in
  `~/.ssh/config`, create `~/havemind/deploy/backups` and give it to uid 1000
  (a one-off `chown`, the container has `cap_drop: [ALL]` and cannot do this itself),
  set `HAVEMIND_BACKUP_DIR` in `deploy/.env` and recreate the service
  (`docker compose up -d`, a user step, requires `sudo`);
- **Z.** seed the first artefact (`havemind backup --to /backups`), generate
  the restic repo password, run `bootstrap.sh`, add two lines to the user's
  crontab (backup + prune; neither needs docker).

**Activation completed and drill PASSED (2026-08-08).** The backup pipeline is
live:
scheduled in-server artifacts to `deploy/backups`, nightly restic push over SFTP
to the owner's Mac (user crontab: backup 03:20 daily, prune 04:40 Sundays), and
`restore-drill.sh` returned **PASS** (283 blobs byte-exact, 513 revisions,
`integrity_check: ok`, artifact `2026-08-08T12-04-22-006Z-8a239483`). The 1.0
release gate is satisfied.

**Current operational rule:** run and record a restore drill after any deployment
or backup-configuration change. Until a new deployment has a passing drill, its
recovery status is unverified.

## Server audit follow-ups (backlog AUD-10)

Four minor findings from the pre-pilot server audit (2026-07-22). None blocks
the pilot. Reviewed against the code on 2026-09-03; status below is what the
code actually does, not what the original finding assumed.

**(a) Rate limit on `POST /owner/rejoin-grants`, done.** The endpoint runs an
IP-keyed limiter in `onRequest`, before the handler, so a flood costs no session
lookup (`apps/server/src/auth/rejoin-routes.ts`, `grantRateLimit`). It gets its
OWN bucket, separate from pre-auth `/auth/rejoin`, so a flood on the shared
tunnel cannot lock the owner out of re-admitting a member. Covered by
`rejoin-routes.test.ts`, "429s once one client exceeds the owner grant
threshold".

**(b) `blobByteHash` is metadata, not a check, documented.** The binary payload
carries `blobByteHash` (SHA-256 of the raw file bytes), but **nothing verifies
it**: `decodeRevisionPayload` ignores the field, and the consumer recomputes
`hashBlob(bytes)` from the decoded bytes itself before applying. Integrity of
those bytes is closed outside the payload, the whole payload JSON (base64
included) is content-addressed and re-hashed on read in the server's blob store,
so a corrupted attachment fails there. A second hash pass over up to 25 MB per
attachment on the receive path would catch no reachable failure the outer hash
misses, so the field was left as-is and the doc comments that implied a
guarantee were corrected instead. Pinned by
`packages/sync-core/src/payload-codec.binary.test.ts`, "does not verify
blobByteHash: the field is unread metadata".

**(c) No cap on concurrent in-flight pushes, accepted and recorded.** Each
request body is capped at 40 MiB (`DEFAULT_BODY_LIMIT_BYTES`) with a 36 MiB
payload ceiling inside it (`DEFAULT_MAX_PAYLOAD_BYTES`), and the protected
surface is rate limited at 120 requests / 60 s per client key
(`DEFAULT_RATE_LIMIT`). Nothing bounds how many of those requests may be
in flight *simultaneously*, so peak transient memory is
`concurrent requests x up to 40 MiB`, roughly 100-150 MiB at the ceiling for a
handful of parallel large-attachment pushes. This is accepted, not fixed: the
deployment is a two-device tailnet with a trusted operator, where the request
concurrency a legitimate client generates is small and every caller is
authenticated. **It becomes real if the trust boundary widens**, more members, a
shared or semi-trusted tailnet, or any path that lets an unauthenticated caller
reach the push route. Revisit then; the fix is a small semaphore around the
push handler, not a redesign.

**(d) Rejoin binds to the most recently approved device, known limitation.**
`#resolveBoundDevice` (`apps/server/src/auth/rejoin-grants.ts`) selects one
device per rejoin grant with `ORDER BY (vault_id IS NULL), approved_at DESC, id
LIMIT 1`: scoped to the grant's own vault first (a device proven to be in this
vault always beats a legacy `vault_id IS NULL` row), then the most recently
approved wins. With one device per person this is unambiguous. With several
devices per person it is arbitrary from the user's point of view, a rejoin grant
may bind to a laptop the member is not currently holding, and there is no way to
choose. Deliberately unchanged for now; it must be revisited before multi-device
support ships, when the grant will need to name its target device explicitly.

## Keychain entries accumulate: SecretStorage has no delete

Obsidian's `SecretStorage` API (minimum app version 1.11.4, see
`apps/obsidian-plugin/manifest.json`) exposes exactly three operations:
`setSecret(id, secret)`, `getSecret(id)` and `listSecrets()`. There is no
delete or remove operation (`apps/obsidian-plugin/src/obsidian.d.ts`).

Havemind therefore retires a credential entry by **blanking** it rather than
removing it: `apps/obsidian-plugin/src/storage/secret-store.ts` writes `''`
over the superseded id on refresh-token rotation and on disconnect, and the
read path treats an empty value as absent. Every rotation mints a fresh id of
the form `havemind-<client_instance_id>-refresh-<randomUUID>`, checked for
collisions against `listSecrets()` before use.

The consequence: the number of Havemind ids in the OS keychain grows by one per
rotation and never shrinks over the lifetime of a device pairing. The retired
entries hold an empty string, no credential material remains in them, and
their ids are unique, so a stale entry can never be mistaken for the active
one. They do, however, remain visible to `listSecrets()` and in the operating
system's keychain UI.

**Recommendation:** none for the pilot, the accumulated entries are empty and
harmless. Should the count become inconvenient, the entries can be deleted
manually in the OS keychain; Havemind reads only the ids recorded in its own
reference state, so removing a blanked entry has no effect on an active
connection.
