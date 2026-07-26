# SRV-03 — Restic backup to NAS via rclone SMB (sapserver runbook)

> ⚠️ **NOT ACTIVE — do not rely on this for backup (audit #10).** This runbook is
> **not wired to real data and is not verified**:
> - `HAVEMIND_APPDATA` defaults to a **staging directory** (`~/havemind-ops/staging`),
>   **not** the live Docker named volume `havemind_havemind-data`. As configured it
>   would back up an empty/wrong path — it does **not** protect the vault.
> - The SMB target `192.168.254.10` is a **UniFi Cloud Key, not a NAS** — SMB backup
>   to it is not possible; a real backup destination must be provisioned first.
> - Backup is **deliberately deferred for the pilot** (explicit user decision: zero
>   off-host backup, data only on the user's own hardware). See
>   `docs/pilot/known-limitations.md`.
>
> **Release gate:** no 1.0 release until a backup targets the real volume AND a
> restore drill onto a clean instance is confirmed. Until then, treat the server's
> data volume as the only copy.

Encrypted Restic repository on the local-network NAS (SMB share `backup` at
`192.168.254.10`), retention 7 daily / 4 weekly / 6 monthly.

Restic has no native SMB backend, so it uses its `rclone:` backend and rclone
speaks SMB **in userspace** — no CIFS kernel mount, no `apt`, no `sudo`. The
encrypted repo lives on the NAS share, off the server system disk (satisfies
the SRV-03 "repo poza dyskiem systemowym" criterion). This replaces the earlier
CIFS-mount design, which required root.

## Static binaries (no sudo)

Installed on sapserver under `~/bin` (already on `PATH` via `~/.profile`;
scripts also prepend it for non-login shells):

| Tool | Version | Source | SHA256 verified |
|---|---|---|---|
| restic | 0.19.1 | GitHub release `restic_0.19.1_linux_amd64.bz2` | ✓ against release `SHA256SUMS` |
| rclone | 1.74.4 | GitHub release `rclone-v1.74.4-linux-amd64.zip` | ✓ against release `SHA256SUMS` |

Re-verify any time: download the release `SHA256SUMS`, `sha256sum` the archive,
compare.

## Files

Scripts live in `~/havemind-ops/` on sapserver with copies version-controlled
here. Secrets never enter the repo.

| Purpose | Repo path | sapserver path |
|---|---|---|
| Env config | `restic.env` | `~/havemind-ops/restic.env` |
| One-command bootstrap | `bootstrap.sh` | `~/havemind-ops/bootstrap.sh` |
| Init repo | `init-repo.sh` | `~/havemind-ops/init-repo.sh` |
| Backup | `backup.sh` | `~/havemind-ops/backup.sh` |
| Prune (check→forget→prune) | `prune.sh` | `~/havemind-ops/prune.sh` |
| Restore | `restore.sh` | `~/havemind-ops/restore.sh` |
| Verify (`snapshots`+`check`) | `verify.sh` | `~/havemind-ops/verify.sh` |
| rclone remote template | `rclone.conf.template` | staged; real file → `~/.config/rclone/rclone.conf` (0600) |
| Repo password (0600) | NEVER in repo | `~/havemind-ops/secrets/restic-repo-password` |

The repo password was generated on sapserver (`openssl rand -base64 48`) and
written only to the 0600 file above. It is never printed, logged, or committed.

## Repository string

```
rclone:nas-backup:backup/havemind-restic
```

`nas-backup` is the rclone remote (`type = smb`, host `192.168.254.10`). SMB has
no "share" config key, so the share (`backup`) is the **first path element**,
followed by the repo dir `havemind-restic`. This is set in `restic.env` as
`RESTIC_REPOSITORY` from `RCLONE_REMOTE`/`RCLONE_SHARE`.

## What the agent already did (no sudo)

- Downloaded, SHA256-verified, and installed static `restic` + `rclone` to `~/bin`.
- Rewrote all scripts to the rclone SMB backend (dropped the CIFS mount checks;
  each script now preflights NAS SMB reachability via `nas_reachable`).
- Staged the rclone remote template. The repo password 0600 file already exists.
- Added `bootstrap.sh` — the single command to run once the NAS is up.

## Blocker: SMB not reachable on the NAS (2026-07-16)

From sapserver, `192.168.254.10` pings fine (~1.5 ms, local net) but **TCP 445
and 139 are both refused**. SMB is not currently served (or is firewalled) on
the NAS. Everything above is ready; only this remains.

## User steps to finish SRV-03

### A. On the NAS (admin panel — cannot be automated)

1. Enable the SMB/CIFS service.
2. Confirm the `backup` share is exported and writable by a chosen account.
3. Note that account's username/password (needed in step B2).

### B. On sapserver, as mikolaj (no sudo)

1. Confirm SMB is now reachable: `nc -z -w3 192.168.254.10 445 && echo open`
   (or `timeout 3 bash -c '>/dev/tcp/192.168.254.10/445' && echo open`).
2. Create the rclone remote **interactively** so the SMB password is typed at
   the terminal and never sent over chat:
   ```
   ~/bin/rclone config
   #   n) new remote → name: nas-backup → storage: smb
   #   host: 192.168.254.10 → user: <account> → password: <typed, hidden>
   ```
   `rclone config` writes `~/.config/rclone/rclone.conf`; then `chmod 600` it.
   (Alternative: copy `rclone.conf.template`, fill `user`, and set `pass` to the
   output of `~/bin/rclone obscure 'THEPASSWORD'` — never the plaintext.)
3. Verify the share lists: `~/bin/rclone lsd nas-backup:backup`
4. Run the one command:
   ```
   bash ~/havemind-ops/bootstrap.sh
   ```
   It preflights, inits the encrypted repo, takes the first snapshot of
   `HAVEMIND_APPDATA` (pilot default `~/havemind-ops/staging`), then runs
   `restic snapshots` + `restic check` — the SRV-03 acceptance method.
5. Apply retention any time after ≥1 snapshot exists:
   ```
   bash ~/havemind-ops/prune.sh
   ```
   It runs `restic check` first and aborts before any `forget --prune` if the
   check fails (plan/01 reguła 9, plan/08).

## Acceptance mapping

- **Encrypted repo, off system disk** — restic repos are always encrypted; the
  repo lives on the NAS share via rclone SMB.
- **Retention 7/4/6** — configured in `restic.env`, applied by `prune.sh`.
- **Verification `restic snapshots` + `restic check`** — `verify.sh` (also the
  final step of `bootstrap.sh`).

SRV-04 (single-file restore) and SRV-05 (full-service restore) then use
`restore.sh`.
