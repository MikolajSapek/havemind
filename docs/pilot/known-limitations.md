# Known limitations (pilot)

Status as of 2026-08-07. Source: bug-hunt loop audits (`plan/11-BACKLOG.md`, AUDIT-FINDINGS section).

## Auto-formatters on two machines (AUD-03)

**Fixed (commit `37e609d`).** Content is now canonicalised before
hashing, with a 1.5-second "settling" window and a one-off rebase of
base hashes on plugin update. Differences in auto-formatter settings
(e.g. Linter with "format on save", Prettier-for-Obsidian) between machines —
line width, quote style, trailing newline — no longer generate churn or
entries in `Havemind Conflicts/`. Binary attachments are excluded from the rebase:
their base hash is computed over raw bytes, not text, so
text canonicalisation does not affect them.

**Recommendation:** none — the full fix is already in the pilot and requires no manual
synchronisation of formatter settings.

## Dot-paths and the reserved folder (AUD-07)

Notes where any path segment starts with a dot (e.g.
`Notes/.drafts/x.md`), and notes in a folder named `Havemind Conflicts/`,
**do not sync** — this is a deliberate safety guard. The direction is
safe (under-sync, never over-sync), but such notes stay local
without any warning.

**Exception (as of commit `dcd366f`):** `.obsidian/` now has its own, separate
config-mirroring mechanism (theme, colours, hotkeys, snippets, third-party
plugin code) via adapter polling, independent of the dot-path guard
above. This mechanism has its own hard denylist that stays local on
each machine: every `data.json`, `workspace.json`, `community-plugins.json`,
and the `havemind-sync` folder. Outside this exception, `.obsidian/` is still subject
to the general dot-path guard described above.

**Recommendation:** do not keep your own notes in dot-paths or in the
`Havemind Conflicts/` folder.

## Sync scope

Besides `.md` notes, binary attachments in the allowed
formats also sync: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `pdf` (commits
`acbf46e`, `b7c663a`, `6959e90`). The hard file size limit is 25 MB —
an attachment above the limit is excluded with a notification (this is not an error)
and never blocks the scan or the sync of the rest of the vault. Any other
format — outside the allowed list and `.md` — remains unsynced and
is counted in reconciliation as an excluded attachment.

## Backup: pipeline ready, activation on the user's side (AUD-10)

**Implemented and covered by tests** (`apps/server/src/backup-scheduler.test.ts`,
`backup-cli.test.ts`, `backup-restore.test.ts`):

- the server itself writes backup artefacts on a time-based loop to the directory pointed
  to by `HAVEMIND_BACKUP_DIR` (disabled by default; `HAVEMIND_BACKUP_INTERVAL_HOURS`
  = 24 h, `HAVEMIND_BACKUP_KEEP` = 7). It does this itself because the operator account has no
  `docker` group or passwordless `sudo`, so cron cannot call `docker exec`;
- `havemind backup [--to <dir>]`, `havemind backup verify`, `havemind backup restore`
  — one-off run and restore to a temporary directory;
- `deploy/compose.yaml` mounts `./backups:/backups`;
- `ops/sapserver/restic/*` targets **real data** (the host side of the bind
  mount, not staging) and sends it via **SFTP to the owner's Mac over the tailnet**
  (the old, unworkable SMB / UniFi Cloud Key target has been removed). Retention 7/4/6
  unchanged; a sleeping Mac is a logged *skip*, not an error;
- `ops/sapserver/restic/restore-drill.sh` — a full restore attempt with a single
  PASS/FAIL result, runnable entirely with user-level permissions.

**Activation requires steps that cannot be automated** (full list:
`ops/sapserver/restic/README.md`, "Activation checklist" section):

- **X.** on the Mac: enable Remote Login, create `~/havemind-restic`, add
  the sapserver's public key to `~/.ssh/authorized_keys`;
- **Y.** on sapserver: generate an SSH key and the `havemind-backup` alias in
  `~/.ssh/config`, create `~/havemind/deploy/backups` and give it to uid 1000
  (a one-off `chown` — the container has `cap_drop: [ALL]` and cannot do this itself),
  set `HAVEMIND_BACKUP_DIR` in `deploy/.env` and recreate the service
  (`docker compose up -d` — a user step, requires `sudo`);
- **Z.** seed the first artefact (`havemind backup --to /backups`), generate
  the restic repo password, run `bootstrap.sh`, add two lines to the user's
  crontab (backup + prune; neither needs docker).

**Effect until X/Y/Z are done:** the server volume is the only copy of the data.
A disk failure means data loss.

**Gate before 1.0:** `restore-drill.sh` must finish with `RESTORE DRILL: PASS`
on sapserver. Date of the last successful run: _(not yet run)_.
