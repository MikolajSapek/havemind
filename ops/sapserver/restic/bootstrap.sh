#!/usr/bin/env bash
# Havemind — SRV-03 one-command bootstrap (sudo-free, SFTP backend).
# Run this AFTER the Mac side of the activation checklist is done (Remote Login
# on, key authorised, `ssh havemind-backup true` works):
#     bash ~/havemind-ops/bootstrap.sh
#
# It runs the full acceptance sequence in order and stops at the first failure:
#   1. preflight  — Mac reachable over SSH + at least one artifact to back up
#   2. init-repo  — create the encrypted restic repo (idempotent)
#   3. backup     — take the first snapshot of HAVEMIND_BACKUP_SOURCE
#   4. verify     — `restic snapshots` + `restic check` (the SRV-03 AC method)
#
# Retention (prune.sh) is intentionally NOT auto-run here: it needs ≥1 snapshot
# and always runs `restic check` before any forget/prune (plan/01 reguła 9).
# The restore drill (restore-drill.sh) is the separate 1.0 release gate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

echo "== SRV-03 bootstrap =="
echo "repo:   ${RESTIC_REPOSITORY}"
echo "source: ${HAVEMIND_BACKUP_SOURCE}"

echo "-- step 1/4: preflight --"
if ! mac_reachable; then
  echo "ABORT: ${MAC_SSH_ALIAS} not reachable. Finish the Mac side of the activation" >&2
  echo "       checklist first (Remote Login on, key in authorized_keys)." >&2
  exit 1
fi
if ! source_has_artifact; then
  echo "ABORT: no artifact under ${HAVEMIND_BACKUP_SOURCE}." >&2
  echo "       Seed one first (inside the container): havemind backup --to /backups" >&2
  exit 1
fi

echo "-- step 2/4: init-repo --"
bash "${HERE}/init-repo.sh"

echo "-- step 3/4: backup --"
bash "${HERE}/backup.sh"

echo "-- step 4/4: verify (restic snapshots + restic check) --"
bash "${HERE}/verify.sh"

echo "== SRV-03 bootstrap complete. =="
echo "Next: bash ${HERE}/restore-drill.sh   # the 1.0 release gate"
