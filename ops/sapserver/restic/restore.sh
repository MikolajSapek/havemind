#!/usr/bin/env bash
# Havemind — restore from Restic (SRV-04 single-file, SRV-05 full-service).
# Never restores over the live data directory: always restores into an explicit,
# empty target you pass on the command line, so a mistake can't clobber /srv.
#
# Usage:
#   restore.sh <target-dir> [snapshot-id] [--include <path>]
#     <target-dir>   empty directory to restore into (required)
#     [snapshot-id]  restic snapshot id or "latest" (default: latest)
#     [--include ..] restrict to a path (for SRV-04 single-file restore)
#
# Examples:
#   restore.sh /srv/restore-test                       # full latest (SRV-05)
#   restore.sh /srv/restore-test latest --include /srv/appdata/havemind/havemind.db
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

TARGET="${1:-}"
SNAPSHOT="${2:-latest}"
shift $(( $# > 2 ? 2 : $# )) || true

if [ -z "${TARGET}" ]; then
  echo "ERROR: target directory required. See header for usage." >&2
  exit 1
fi
if ! mountpoint -q "${NAS_MOUNT}"; then
  echo "ERROR: ${NAS_MOUNT} is not mounted." >&2
  exit 1
fi
mkdir -p "${TARGET}"
if [ -n "$(ls -A "${TARGET}" 2>/dev/null)" ]; then
  echo "ERROR: target ${TARGET} is not empty. Refusing to restore over data." >&2
  exit 1
fi

echo "Verifying repository before restore (restic check)..."
restic check

echo "Restoring snapshot ${SNAPSHOT} into ${TARGET} ..."
restic restore "${SNAPSHOT}" --target "${TARGET}" "$@"

echo "Restore complete into ${TARGET}."
