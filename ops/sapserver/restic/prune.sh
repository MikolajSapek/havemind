#!/usr/bin/env bash
# Havemind — apply retention 7/4/6 and prune (SRV-03).
#
# HARD RULE (plan/01 rule 9, plan/08): `restic forget --prune` is FORBIDDEN
# without a preceding successful `restic check`. This script enforces that: if
# the check fails it aborts BEFORE any forget/prune and deletes nothing.
#
# Cron-driven, so an unreachable Mac is a logged skip, not a failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! mac_reachable; then
  log "SKIP: ${MAC_SSH_ALIAS} is not reachable; retention not applied this run."
  exit 0
fi

log "Step 1/2: restic check (mandatory before any forget/prune)..."
if ! restic check; then
  log "ABORT: restic check failed. No snapshots forgotten, nothing pruned."
  exit 1
fi

log "Step 2/2: forget with retention ${KEEP_DAILY}d/${KEEP_WEEKLY}w/${KEEP_MONTHLY}m + prune..."
restic forget \
  --tag "${RESTIC_TAG}" \
  --host "${RESTIC_HOST}" \
  --keep-daily "${KEEP_DAILY}" \
  --keep-weekly "${KEEP_WEEKLY}" \
  --keep-monthly "${KEEP_MONTHLY}" \
  --prune

log "Retention applied. Remaining snapshots:"
restic snapshots --tag "${RESTIC_TAG}"
