#!/usr/bin/env bash
# Havemind — initialise the Restic repository on the NAS via rclone SMB (SRV-03).
# Idempotent: if the repo already exists we report "already initialised" instead
# of failing. Sudo-free: runs as the ordinary user, uses ~/bin/{restic,rclone}
# and the 0600 password file under ~/havemind-ops/secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! nas_reachable; then
  echo "ERROR: NAS SMB ${NAS_HOST}:${SMB_PORT} not reachable. Enable SMB on the NAS." >&2
  exit 1
fi
if [ ! -r "${RESTIC_PASSWORD_FILE}" ]; then
  echo "ERROR: password file ${RESTIC_PASSWORD_FILE} not readable." >&2
  exit 1
fi

if restic cat config >/dev/null 2>&1; then
  echo "Repository already initialised at ${RESTIC_REPOSITORY}."
else
  restic init
  echo "Repository initialised at ${RESTIC_REPOSITORY}."
fi
