#!/usr/bin/env bash
# Havemind, SRV-03 verification method: `restic snapshots` + `restic check`.
# This is the exact command pair named in the SRV-03 acceptance criterion.
# Read-only: lists snapshots and verifies repository integrity. Deletes nothing.
#
# Repository-level only. It proves the restic repo is internally consistent, it
# does NOT prove a Havemind instance can be rebuilt from it. That is what
# restore-drill.sh does, and the drill is the 1.0 release gate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! mac_reachable; then
  echo "ERROR: ${MAC_SSH_ALIAS} not reachable. Wake the Mac and retry." >&2
  exit 1
fi

echo "=== restic snapshots ==="
restic snapshots

echo "=== restic check ==="
restic check

echo "=== configured retention (SRV-03: 7 daily / 4 weekly / 6 monthly) ==="
echo "keep-daily=${KEEP_DAILY} keep-weekly=${KEEP_WEEKLY} keep-monthly=${KEEP_MONTHLY}"
