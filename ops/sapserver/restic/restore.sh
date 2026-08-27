#!/usr/bin/env bash
# Havemind, restore files from Restic (SRV-04 single-file, SRV-05 full-service).
# Sudo-free: runs as the ordinary user over the SFTP backend. NEVER restores over
# the live data directory: it always restores into an explicit, empty target you
# pass on the command line, so a mistake cannot clobber existing data.
#
# This recovers FILES. Turning a recovered artifact back into a running instance
# is `havemind backup restore`, see restore-drill.sh, which does both.
#
# Usage:
#   restore.sh <target-dir> [snapshot-id] [--include <path>]
#     <target-dir>   empty directory to restore into (required)
#     [snapshot-id]  restic snapshot id or "latest" (default: latest)
#     [--include ..] restrict to a path (for SRV-04 single-file restore)
#
# Examples:
#   restore.sh ~/restore-test                       # full latest (SRV-05)
#   restore.sh ~/restore-test latest --include /home/mikolaj/havemind/deploy/backups
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
if ! mac_reachable; then
  echo "ERROR: ${MAC_SSH_ALIAS} not reachable. Wake the Mac and retry." >&2
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
