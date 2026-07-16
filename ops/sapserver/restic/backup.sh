#!/usr/bin/env bash
# Havemind — create one Restic snapshot of the application data (SRV-03).
# Run as root (reads root-owned /srv/appdata/havemind). Retention is NOT applied
# here — see prune.sh, which always runs `restic check` before forgetting.
#
# Consistency note: Havemind stores state in SQLite + a blob store. For a
# crash-consistent snapshot, have the application backup CLI (F7-01) dump to a
# staging dir first and point HAVEMIND_APPDATA at it. Backing up the live dir is
# acceptable for the pilot but a hot SQLite file may need WAL checkpointing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! mountpoint -q "${NAS_MOUNT}"; then
  echo "ERROR: ${NAS_MOUNT} is not mounted." >&2
  exit 1
fi
if [ ! -d "${HAVEMIND_APPDATA}" ]; then
  echo "ERROR: backup source ${HAVEMIND_APPDATA} not found." >&2
  exit 1
fi

restic backup "${HAVEMIND_APPDATA}" \
  --tag "${RESTIC_TAG}" \
  --host "${RESTIC_HOST}" \
  --verbose

echo "Backup complete. Latest snapshots:"
restic snapshots --latest 3 --tag "${RESTIC_TAG}"
