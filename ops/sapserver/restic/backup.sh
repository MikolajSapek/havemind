#!/usr/bin/env bash
# Havemind, ship the server's backup artifacts to the Mac (SRV-03).
#
# Sudo-free and docker-free: the Havemind container writes finished artifacts
# into the host bind mount, this script only reads them. It is the one command
# the user crontab runs (see README "Activation checklist").
#
# Retention is NOT applied here, see prune.sh, which always runs `restic check`
# first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

# A sleeping or absent Mac is normal, not a failure: log a skip and exit 0 so
# cron stays quiet and a genuine error is never lost in recurring noise.
if ! mac_reachable; then
  log "SKIP: ${MAC_SSH_ALIAS} is not reachable (Mac asleep or off the tailnet)."
  exit 0
fi

# An empty source directory is a REAL failure, it is exactly how a backup can
# look green while protecting nothing.
if ! source_has_artifact; then
  log "ERROR: no backup artifact found under ${HAVEMIND_BACKUP_SOURCE}."
  log "       Is HAVEMIND_BACKUP_DIR set in deploy/.env and the directory owned by uid 1000?"
  log "       Seed one now with: havemind backup --to /backups (inside the container)."
  exit 1
fi

log "Backing up ${HAVEMIND_BACKUP_SOURCE} -> ${RESTIC_REPOSITORY}"
restic backup "${HAVEMIND_BACKUP_SOURCE}" \
  --tag "${RESTIC_TAG}" \
  --host "${RESTIC_HOST}"

log "Backup complete. Latest snapshots:"
restic snapshots --latest 3 --tag "${RESTIC_TAG}"
