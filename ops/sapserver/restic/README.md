# SRV-03 — Restic backup to NAS (sapserver runbook)

Encrypted Restic repository on the local-network NAS (SMB share `backup` at
`192.168.254.10`), retention 7 daily / 4 weekly / 6 monthly. Restic has no native
SMB backend, so the repo lives on a CIFS mount of the share — the encrypted repo
therefore sits on the NAS, off the server system disk (satisfies the SRV-03
"repo poza dyskiem systemowym" criterion).

## Files

On sapserver these live in `~/havemind-ops/` (scripts + templates) with copies
version-controlled here in the repo. Secrets never enter the repo.

| Purpose | Repo path | sapserver path |
|---|---|---|
| Env config | `restic.env` | `~/havemind-ops/restic.env` |
| Init repo | `init-repo.sh` | `~/havemind-ops/init-repo.sh` |
| Backup | `backup.sh` | `~/havemind-ops/backup.sh` |
| Prune (check→forget→prune) | `prune.sh` | `~/havemind-ops/prune.sh` |
| Restore | `restore.sh` | `~/havemind-ops/restore.sh` |
| Verify (`snapshots`+`check`) | `verify.sh` | `~/havemind-ops/verify.sh` |
| SMB creds template | `smb-credentials.template` | `~/havemind-ops/secrets/smb-credentials` |
| CIFS mount unit | `../systemd/mnt-havemind_backup.mount` | staged in `~/havemind-ops/systemd/` |
| CIFS automount unit | `../systemd/mnt-havemind_backup.automount` | staged in `~/havemind-ops/systemd/` |
| fstab alternative | `fstab.snippet` | — |
| Repo password (0600) | NEVER in repo | `~/havemind-ops/secrets/restic-repo-password` |

The repo password was generated on sapserver (`openssl rand -base64 48`,
384-bit entropy) and written only to the 0600 file above. It is never printed,
logged, or committed.

## What the agent already did (no sudo)

- Generated the repo password into `~/havemind-ops/secrets/restic-repo-password`
  (0600, mikolaj-owned).
- Staged all scripts + unit files + the SMB creds template under `~/havemind-ops/`.
- Confirmed `restic`, `smbclient`, `cifs-utils` are NOT installed and there is no
  passwordless sudo, so the steps below require the user.

## Blocker found: SMB not reachable on the NAS (2026-07-16)

From sapserver, `192.168.254.10` pings fine (~1.7 ms, local net) but **TCP 445
and 139 are both refused**. SMB is not currently served (or is firewalled) on
the NAS. The CIFS mount in step 4 will fail until this is fixed NAS-side:
enable the SMB/CIFS service and confirm the `backup` share is exported. Re-test
from sapserver with `nc -vz 192.168.254.10 445` (after `smbclient`/`cifs-utils`
install) or `smbclient -L //192.168.254.10 -U <user>`.

## Steps requiring the user (sudo / interactive)

Run these on sapserver as mikolaj. Copy-paste exactly.

### 1. Fill in the SMB credentials (interactive, no sudo yet)

```
nano ~/havemind-ops/secrets/smb-credentials
# replace the CHANGE_ME values with the NAS account username/password; set the
# correct domain/workgroup or delete the domain line. Save.
chmod 600 ~/havemind-ops/secrets/smb-credentials
```

### 2. Install packages (sudo)

```
sudo apt-get update
sudo apt-get install -y restic cifs-utils smbclient
```

### 3. Move secrets into root-owned /srv/secrets (sudo)

```
sudo install -d -m 700 -o root -g root /srv/secrets
sudo install -m 600 -o root -g root ~/havemind-ops/secrets/restic-repo-password /srv/secrets/restic-repo-password
sudo install -m 600 -o root -g root ~/havemind-ops/secrets/smb-credentials /srv/secrets/smb-credentials
# then remove the home-dir copies so the only secrets live in /srv/secrets:
shred -u ~/havemind-ops/secrets/restic-repo-password ~/havemind-ops/secrets/smb-credentials
```

### 4. Create the mount point and install the mount units (sudo)

```
sudo mkdir -p /mnt/havemind_backup
sudo install -m 644 ~/havemind-ops/systemd/mnt-havemind_backup.mount /etc/systemd/system/
sudo install -m 644 ~/havemind-ops/systemd/mnt-havemind_backup.automount /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mnt-havemind_backup.automount
# verify the share mounts on access:
sudo ls /mnt/havemind_backup && mountpoint /mnt/havemind_backup
```

(Alternative to step 4: add the single line from `fstab.snippet` to `/etc/fstab`
and `sudo mount /mnt/havemind_backup` — use one approach, not both.)

### 5. Initialise the repo and take the first backup (sudo — reads root-owned /srv)

```
sudo -E bash ~/havemind-ops/init-repo.sh
sudo -E bash ~/havemind-ops/backup.sh
```

### 6. Verify (this is the SRV-03 acceptance method)

```
sudo -E bash ~/havemind-ops/verify.sh
```

Expected: `restic snapshots` lists at least the snapshot from step 5, and
`restic check` prints `no errors were found`.

## After the user finishes

Once step 6 passes, SRV-03 acceptance is met:
- repo encrypted (Restic repos are always encrypted) and on the NAS (off system disk);
- retention 7/4/6 configured in `restic.env` and applied by `prune.sh`
  (verify with `sudo -E bash ~/havemind-ops/prune.sh` after ≥1 snapshot exists —
  it runs `restic check` before any `forget --prune`, per plan/01 reguła 9);
- verification method `restic snapshots` + `restic check` = `verify.sh`.

SRV-04 (single-file restore) and SRV-05 (full-service restore to a clean
instance) then use `restore.sh`.

## Retention and prune safety

`prune.sh` always runs `restic check` first and aborts before any
`forget --prune` if the check fails — `restic forget --prune` without a
preceding successful `restic check` is forbidden (plan/01 reguła 9, plan/08).
