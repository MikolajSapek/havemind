# Backup and restore

Havemind keeps everything that matters in one place: a SQLite database plus a
content-addressed blob store under the server's data directory. This page covers
how copies of that state are made, where they go, and how a restore is proven,
not assumed.

Status: the production backup pipeline is active and the initial restore drill
passed on 2026-08-08. Run a new restore drill after every deployment or backup
configuration change; until it passes, recovery for that deployment is
unverified. See `docs/pilot/known-limitations.md` (AUD-10) for the historical
activation record.

## The three layers

| Layer | What it produces | Who runs it |
|---|---|---|
| Artifact | A verifiable snapshot directory: `havemind.db` + every blob + `manifest.json` pinning each blob's SHA-256 and size | The server's in-process timer, or `havemind backup` |
| Off-box copy | An encrypted restic repository on the owner's Mac, reached over the tailnet by SFTP, retention 7/4/6 | A user cron job on sapserver (`ops/sapserver/restic/backup.sh`) |
| Proof | A restore drill: pull the latest snapshot back, verify every blob, rebuild a scratch data directory, run `integrity_check` | `ops/sapserver/restic/restore-drill.sh` |

Each layer is independently checkable, and none of them needs root, the `docker`
group, or physical access to the machine.

## Why the server writes its own artifacts

The pilot operator account is deliberately unprivileged: no `docker` group, no
non-interactive `sudo`. That rules out the obvious design, a cron job calling
`docker exec havemind backup`. So the server itself runs the timer and writes
into a host bind mount, and the cron job only ever reads finished files.

Two properties fall out of that choice:

- **Consistency.** An artifact is taken through SQLite's online backup API, never
  as a file copy of a live WAL-mode database.
- **Atomic publication.** Each run stages into a dot-prefixed temporary directory
  and publishes it with a single `rename`. A crash mid-write leaves a directory
  that retention, listing and restore all ignore, so a half-written artifact can
  never be mistaken for a complete one.

## Configuration

All four settings are optional; with `HAVEMIND_BACKUP_DIR` unset the timer never
starts and the server behaves exactly as before.

| Variable | Default | Meaning |
|---|---|---|
| `HAVEMIND_BACKUP_DIR` | unset (off) | Directory inside the container that artifacts are written to. `deploy/compose.yaml` bind mounts `./backups` there. |
| `HAVEMIND_BACKUP_INTERVAL_HOURS` | `24` | Whole hours between runs, 1–720. |
| `HAVEMIND_BACKUP_KEEP` | `7` | Newest artifacts kept on the host after each run, 1–365. |
| `HAVEMIND_DATA_DIR` | required | The live data directory that gets snapshotted. |

The first run happens one interval after startup, never at boot, so a restart
loop cannot fill the disk. Seed the first artifact by hand instead (see below).

### One-time host directory ownership

The container runs as uid `1000` with `cap_drop: [ALL]`, so it cannot `chown`
anything from the inside. Docker creates a missing bind-mount source **root
owned**, and every backup would then fail with `EACCES`, logged each cycle,
never fatal. Create the directory and hand it to uid 1000 once, before `up -d`:

```bash
mkdir -p deploy/backups && chmod 700 deploy/backups
docker run --rm -v "$PWD/deploy/backups:/backups" alpine chown -R 1000:1000 /backups
```

This is the same one-off fix the named data volume needs, see
`docs/self-hosting.md`, "One-time volume ownership fix".

## Operator commands

Run inside the container (`docker compose -f deploy/compose.yaml exec
havemind-server ...`):

```bash
# Write one artifact now and apply keep-N retention.
havemind backup --to /backups

# Verify an artifact without restoring it: manifest, database snapshot,
# and every blob byte-for-byte.
havemind backup verify --from /backups/<artifact-id>

# Rebuild a data directory from an artifact into an EMPTY target.
havemind backup restore --from /backups/<artifact-id> --to /tmp/scratch-data
```

`backup restore` is fail-closed and, on success, deliberately disruptive: it
verifies the manifest and runs `PRAGMA integrity_check` **before** the instance
is considered started, then mints a fresh `server_epoch` and increments
`restore_epoch`. Any client still holding a cursor from the old epoch is answered
`409 CURSOR_INVALID` and must reconcile, which is what stops a restored server
from silently diverging from devices that were ahead of it.

## Retention semantics

Host-side retention keeps the newest N artifacts, but it never deletes anything
until the newest **retained** artifact has passed verification. If the latest
artifact is corrupt, the prune step fails and the older good copies stay. The
off-box restic repository applies its own 7 daily / 4 weekly / 6 monthly policy,
and `prune.sh` refuses to run `forget --prune` without a passing `restic check`
first.

## The restore drill (1.0 release gate)

A backup that has never been restored is a hypothesis. `restore-drill.sh` turns
it into a fact, using user-level permissions only and touching nothing live:

1. the Mac is reachable and `restic check` passes;
2. the latest snapshot restores back onto sapserver into a temporary directory;
3. the newest artifact inside it is byte-exact against its manifest;
4. that artifact rebuilds a scratch data directory that passes
   `PRAGMA integrity_check` and contains an `instance_state` row;
5. the rebuilt directory contains `havemind.db`, the exact filename the server
   opens.

It prints one verdict, `RESTORE DRILL: PASS` or `FAIL`, and exits non-zero on
failure. Two verification modes:

- **cli**, runs `havemind backup verify` and `havemind backup restore`, i.e. the
  shipped restore code path. Requires a Havemind CLI reachable outside the
  container; point `HAVEMIND_CLI` at it.
- **offline**, the same checks (SHA-256 per blob, size, `integrity_check`,
  `instance_state` present) re-implemented with `python3` stdlib only, so the
  drill runs on a bare host with no node, no build and no container.

Run it after activation, and again after any change to the deployment:

```bash
bash ~/havemind-ops/restore-drill.sh
```

Record the date of the last passing run in `docs/pilot/known-limitations.md`.

## What is protected, and what is not

- **Protected:** notes, attachments, revision history, memberships, devices and
  invitations, everything in the database and blob store.
- **Not protected by this pipeline:** `/srv/secrets/havemind_db_key`, the restic
  repository password and the SSH key. Those live in the owner recovery kit; a
  repository whose password is lost is unrecoverable, by design.
- **Not encrypted at rest on the host:** an artifact is a byte-for-byte copy of
  data the live volume already stores unencrypted, so treat the bind mount
  exactly like the data directory (0700, uid 1000, tailnet-only host). If
  host-side encryption at rest is required, use `havemind checkpoint create`
  instead, it seals every part to an off-server public key, and every restore
  (including every drill) then needs the owner's secret key.

## Related

- `ops/sapserver/restic/README.md`, the activation checklist and cron lines.
- `docs/self-hosting.md`, first deployment, volume ownership.
- `docs/pilot/known-limitations.md`, AUD-10 status.
