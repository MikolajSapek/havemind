#!/usr/bin/env bash
# Havemind — SRV-03 one-command bootstrap (sudo-free, rclone SMB backend).
# Run this AFTER SMB is enabled on the NAS and rclone.conf holds real creds:
#     bash ~/havemind-ops/bootstrap.sh
#
# It runs the full acceptance sequence in order and stops at the first failure:
#   1. preflight  — NAS SMB reachable + rclone remote lists the share
#   2. init-repo  — create the encrypted restic repo (idempotent)
#   3. backup     — take the first snapshot of HAVEMIND_APPDATA
#   4. verify     — `restic snapshots` + `restic check` (the SRV-03 AC method)
# Retention (prune.sh) is intentionally NOT auto-run here: it needs ≥1 snapshot
# and always runs `restic check` before any forget/prune (plan/01 reguła 9).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

echo "== SRV-03 bootstrap =="
echo "repo: ${RESTIC_REPOSITORY}"
echo "source: ${HAVEMIND_APPDATA}"

echo "-- step 1/4: preflight --"
if ! nas_reachable; then
  echo "ABORT: NAS SMB ${NAS_HOST}:${SMB_PORT} not reachable. Enable SMB on the NAS first." >&2
  exit 1
fi
if ! rclone lsd "${RCLONE_REMOTE}:${RCLONE_SHARE}" >/dev/null 2>&1; then
  echo "ABORT: rclone cannot list ${RCLONE_REMOTE}:${RCLONE_SHARE}. Check rclone.conf creds/share." >&2
  exit 1
fi
# Ensure the pilot backup source exists (staging with a marker file).
if [ ! -d "${HAVEMIND_APPDATA}" ]; then
  echo "note: creating pilot staging dir ${HAVEMIND_APPDATA}"
  mkdir -p "${HAVEMIND_APPDATA}"
fi

echo "-- step 2/4: init-repo --"
bash "${HERE}/init-repo.sh"

echo "-- step 3/4: backup --"
bash "${HERE}/backup.sh"

echo "-- step 4/4: verify (restic snapshots + restic check) --"
bash "${HERE}/verify.sh"

echo "== SRV-03 bootstrap complete. Apply retention any time with prune.sh. =="
