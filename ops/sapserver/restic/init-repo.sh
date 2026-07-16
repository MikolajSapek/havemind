#!/usr/bin/env bash
# Havemind — initialise the Restic repository on the NAS mount (SRV-03).
# Idempotent: if the repo already exists, restic init exits non-zero and we
# report "already initialised" instead of failing. Run as root (repo lives on
# a root-owned CIFS mount and password file lives in /srv/secrets).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! mountpoint -q "${NAS_MOUNT}"; then
  echo "ERROR: ${NAS_MOUNT} is not mounted. Mount the NAS share first." >&2
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
