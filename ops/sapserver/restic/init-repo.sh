#!/usr/bin/env bash
# Havemind, initialise the Restic repository on the Mac over SFTP (SRV-03).
# Idempotent: an existing repo is reported, not overwritten. Sudo-free: runs as
# the ordinary user with ~/bin/restic and the 0600 password file.
#
# Interactive step: unlike backup.sh/prune.sh this ABORTS loudly when the Mac is
# unreachable, because the operator is watching and there is nothing to skip.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

if ! mac_reachable; then
  echo "ERROR: ${MAC_SSH_ALIAS} not reachable. Wake the Mac, confirm Remote Login is on," >&2
  echo "       and that 'ssh ${MAC_SSH_ALIAS} true' succeeds without a password." >&2
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
