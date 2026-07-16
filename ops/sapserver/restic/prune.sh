#!/usr/bin/env bash
# Havemind — apply retention 7/4/6 and prune (SRV-03).
#
# HARD RULE (plan/01 reguła 9, plan/08): `restic forget --prune` is FORBIDDEN
# without a preceding successful `restic check`. This script enforces that: if
# the check fails, it aborts BEFORE any forget/prune and deletes nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! nas_reachable; then
  echo "ERROR: NAS SMB ${NAS_HOST}:${SMB_PORT} not reachable." >&2
  exit 1
fi

echo "Step 1/2: restic check (mandatory before any forget/prune)..."
if ! restic check; then
  echo "ABORT: restic check failed. No snapshots forgotten, nothing pruned." >&2
  exit 1
fi

echo "Step 2/2: forget with retention ${KEEP_DAILY}d/${KEEP_WEEKLY}w/${KEEP_MONTHLY}m + prune..."
restic forget \
  --tag "${RESTIC_TAG}" \
  --host "${RESTIC_HOST}" \
  --keep-daily "${KEEP_DAILY}" \
  --keep-weekly "${KEEP_WEEKLY}" \
  --keep-monthly "${KEEP_MONTHLY}" \
  --prune

echo "Retention applied. Remaining snapshots:"
restic snapshots --tag "${RESTIC_TAG}"
