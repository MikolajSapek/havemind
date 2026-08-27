# SRV-03, Restic backup to the owner's Mac over the tailnet (sapserver runbook)

Encrypted Restic repository on the owner's Mac, reached over the tailnet with
restic's native **SFTP** backend, retention 7 daily / 4 weekly / 6 monthly.

The whole chain is **sudo-free and docker-free** on sapserver:

```
Havemind container (uid 1000)          sapserver host                the Mac
  backup timer every 24 h  ──writes──►  ~/havemind/deploy/backups  ──restic──►  ~/havemind-restic
  (HAVEMIND_BACKUP_DIR=/backups)        (bind mount, uid 1000)       over ssh    (encrypted repo)
```

Why the server writes its own artifacts: the operator account `mikolaj` is **not**
in the `docker` group and has **no** non-interactive `sudo`, so cron cannot run
`docker exec havemind backup`. The server therefore writes artifacts on an
in-process timer into a host bind mount, and the user cron job only has to read
finished files. Nothing in this directory needs elevated rights.

Why not back up the live volume directly: a hot copy of a WAL-mode SQLite file is
not a consistent backup. Each artifact is written through SQLite's online backup
API and carries a `manifest.json` pinning the SHA-256 and size of every blob, so
a restore can prove byte-exactness before it starts an instance.

Confidentiality: an artifact is a byte-for-byte copy of data the live volume
already stores unencrypted, so on sapserver it deserves exactly the same
treatment as the data directory (0700, uid 1000, tailnet-only host). Off the box
it is protected by restic's own repository encryption. For artifacts that are
encrypted **at rest on the host as well**, `havemind checkpoint create` seals
every part to an off-server public key, at the cost of needing the owner's
secret key for every restore, including every drill.

## Static binaries (no sudo)

Installed on sapserver under `~/bin` (already on `PATH` via `~/.profile`;
`restic.env` also prepends it for non-login shells such as cron):

| Tool | Version | Source | SHA256 verified |
|---|---|---|---|
| restic | 0.19.1 | GitHub release `restic_0.19.1_linux_amd64.bz2` | ✓ against release `SHA256SUMS` |

Re-verify any time: download the release `SHA256SUMS`, `sha256sum` the archive,
compare. `rclone` is **no longer needed**, the SFTP backend is built into
restic and speaks plain `ssh`.

## Files

Scripts live in `~/havemind-ops/` on sapserver with copies version-controlled
here. Secrets never enter the repo.

| Purpose | Repo path | sapserver path |
|---|---|---|
| Env config + preflight helpers | `restic.env` | `~/havemind-ops/restic.env` |
| One-command bootstrap | `bootstrap.sh` | `~/havemind-ops/bootstrap.sh` |
| Init repo | `init-repo.sh` | `~/havemind-ops/init-repo.sh` |
| Backup (the cron entry) | `backup.sh` | `~/havemind-ops/backup.sh` |
| Prune (check→forget→prune) | `prune.sh` | `~/havemind-ops/prune.sh` |
| Restore files | `restore.sh` | `~/havemind-ops/restore.sh` |
| Verify (`snapshots`+`check`) | `verify.sh` | `~/havemind-ops/verify.sh` |
| **Restore drill (1.0 gate)** | `restore-drill.sh` | `~/havemind-ops/restore-drill.sh` |
| Repo password (0600) | NEVER in repo | `~/havemind-ops/secrets/restic-repo-password` |
| SSH key for the Mac | NEVER in repo | `~/.ssh/id_ed25519_havemind_backup` |

The repo password is generated on sapserver (`openssl rand -base64 48`) and
written only to the 0600 file above. **Keep a second copy in the owner recovery
kit, off-server**, losing both makes every snapshot unrecoverable, by design.

## Repository string

```
sftp:havemind-backup:havemind-restic
```

`havemind-backup` is an entry in `~/.ssh/config` that pins the Mac's tailnet
hostname, its macOS username and the dedicated key. Keeping those three facts in
`ssh_config` means restic, the reachability probe and any manual `ssh` all agree,
and no hostname is duplicated across scripts. `havemind-restic` is the repo
directory in the Mac login home. Both come from `restic.env`
(`MAC_SSH_ALIAS`, `MAC_REPO_PATH`).

## Activation checklist

Nothing below is automated: it needs the Mac's UI, a password typed at a real
terminal, and one `chown`. Work through it in order. **Every block states which
machine it runs on.**

### A. LOCAL (your Mac), make it a backup destination

1. **Enable Remote Login.** System Settings → General → Sharing → **Remote
   Login** → on. Restrict it to your own user if the panel offers the choice.
2. **Confirm the Mac's tailnet name** and keep it to hand:
   ```bash
   tailscale status | head -1        # or: tailscale ip -4
   ```
3. **Prevent sleep from silencing the backup.** A closed or sleeping Mac makes
   every run a logged skip, not a failure, that is by design, but a Mac that is
   *always* asleep is not a backup. Either keep it awake on power (System
   Settings → Lock Screen / Battery → "Prevent automatic sleeping on power
   adapter when the display is off") or plan to run `bash ~/havemind-ops/backup.sh`
   by hand when you know it is awake.
4. **Create the repository directory:**
   ```bash
   mkdir -p ~/havemind-restic && chmod 700 ~/havemind-restic
   ```

### B. REMOTE (sapserver), connect to the Mac

5. **Open a session.** From your Mac:
   ```bash
   ssh sapserver
   ```
   You are on the server once the prompt reads `mikolaj@sapserver:~$`. Every
   command in sections B–E runs inside this session.
6. **Generate a dedicated key** (no passphrase, so cron can use it):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_havemind_backup -N '' \
     -C 'havemind-backup sapserver->mac'
   cat ~/.ssh/id_ed25519_havemind_backup.pub
   ```
   Copy the printed public key line.
7. **Add the SSH alias** to `~/.ssh/config` (create the file if absent, then
   `chmod 600 ~/.ssh/config`), substituting the two placeholders:
   ```
   Host havemind-backup
     HostName <mac-tailscale-name>
     User <mac-username>
     IdentityFile ~/.ssh/id_ed25519_havemind_backup
     IdentitiesOnly yes
     ServerAliveInterval 15
   ```

### C. LOCAL (your Mac), authorise the key

Open a **new terminal window on your Mac** (you are leaving the ssh session for
this step only):

8. **Authorise the public key** from step 6:
   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   printf '%s\n' 'PASTE_THE_PUBLIC_KEY_LINE_HERE' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```
   The public key is not a secret; the private key never leaves sapserver.

### D. REMOTE (sapserver), prepare the host side

Back in the ssh session from step 5 (`mikolaj@sapserver:~$`):

9. **Confirm the connection works without a password:**
   ```bash
   ssh havemind-backup true && echo reachable
   ```
   Accept the host fingerprint on this first connection. It must print
   `reachable`, cron uses `BatchMode`, so a prompt of any kind means failure.
10. **Create the host backup directory and give it to uid 1000.** The container
    runs as uid 1000 with `cap_drop: [ALL]`, so it cannot `chown` anything from
    the inside, Docker would create this directory root-owned and every backup
    would fail with `EACCES`. Same one-time fix as the data volume in
    `docs/self-hosting.md`:
    ```bash
    mkdir -p ~/havemind/deploy/backups && chmod 700 ~/havemind/deploy/backups
    sudo chown -R 1000:1000 ~/havemind/deploy/backups
    ```
    This is the **only** step that needs `sudo`, and it is a one-off. Without
    `sudo` at all, use the disposable-container form instead:
    ```bash
    docker run --rm -v ~/havemind/deploy/backups:/backups alpine \
      chown -R 1000:1000 /backups
    ```
11. **Turn the timer on.** In `~/havemind/deploy/.env`:
    ```
    HAVEMIND_BACKUP_DIR=/backups
    HAVEMIND_BACKUP_INTERVAL_HOURS=24
    HAVEMIND_BACKUP_KEEP=7
    ```
    then recreate the service so the bind mount and env are applied (this needs
    `sudo` on this host, so it is a **user step**, never an agent step):
    ```bash
    cd ~/havemind && sudo docker compose -f deploy/compose.yaml up -d
    ```
12. **Seed the first artifact** instead of waiting a day:
    ```bash
    cd ~/havemind && sudo docker compose -f deploy/compose.yaml \
      exec havemind-server havemind backup --to /backups
    ls -l ~/havemind/deploy/backups
    ```
13. **Install the ops scripts and the repo password:**
    ```bash
    mkdir -p ~/havemind-ops/secrets && chmod 700 ~/havemind-ops/secrets
    cp ~/havemind/ops/sapserver/restic/*.sh ~/havemind/ops/sapserver/restic/restic.env ~/havemind-ops/
    chmod +x ~/havemind-ops/*.sh
    openssl rand -base64 48 > ~/havemind-ops/secrets/restic-repo-password
    chmod 600 ~/havemind-ops/secrets/restic-repo-password
    ```
    Copy that password into the owner recovery kit now. Type or paste it only at
    a terminal, never into a chat window.

### E. REMOTE (sapserver), activate and prove it

14. **Bootstrap** (preflight → init → first snapshot → verify):
    ```bash
    bash ~/havemind-ops/bootstrap.sh
    ```
15. **Schedule it.** `crontab -e` as `mikolaj`, a **user** crontab, no root, no
    docker:
    ```cron
    # Havemind: ship backup artifacts to the Mac (skips quietly if it is asleep)
    17 3 * * * /bin/bash /home/mikolaj/havemind-ops/backup.sh >> /home/mikolaj/havemind-ops/backup.log 2>&1
    # Havemind: retention 7/4/6, only after a successful restic check
    43 4 * * 0 /bin/bash /home/mikolaj/havemind-ops/prune.sh >> /home/mikolaj/havemind-ops/prune.log 2>&1
    ```
16. **Run the restore drill, this is the 1.0 release gate:**
    ```bash
    bash ~/havemind-ops/restore-drill.sh
    ```
    It must end with `RESTORE DRILL: PASS`. Record the date in
    `docs/pilot/known-limitations.md` (AUD-10). If node is available outside the
    container, export `HAVEMIND_CLI` first to exercise the shipped restore code
    path rather than the python3 equivalent:
    ```bash
    export HAVEMIND_CLI="node $HOME/havemind/apps/server/bin/havemind.js"
    ```

## Acceptance mapping

- **Real data, not a staging directory**, the source is the host side of the
  container's `/backups` bind mount, and `backup.sh` fails loudly if it holds no
  artifact manifest.
- **Encrypted repo, off the server's disk**, restic repos are always encrypted;
  the repo lives on the Mac, reached over the tailnet by SFTP.
- **Retention 7/4/6**, configured in `restic.env`, applied by `prune.sh`, which
  never forgets anything without a passing `restic check` first.
- **Verification `restic snapshots` + `restic check`**, `verify.sh` (also the
  final step of `bootstrap.sh`).
- **Restore proven, not assumed**, `restore-drill.sh` restores the latest
  snapshot, verifies every blob against its manifest and rebuilds a scratch data
  directory that passes `integrity_check`.

SRV-04 (single-file restore) and SRV-05 (full-service restore) use `restore.sh`;
SRV-05 then continues with `havemind backup restore --from <artifact> --to <dir>`
and pointing a fresh container at that directory.
