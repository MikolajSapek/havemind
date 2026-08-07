#!/usr/bin/env bash
# Havemind — RESTORE DRILL (1.0 release gate).
#
# Proves the whole chain end to end, on real data, with user-level permissions
# only — no sudo, no docker group, no write access to anything live:
#
#   1. the restic repository on the Mac is reachable and internally consistent
#   2. the latest snapshot restores back onto sapserver
#   3. the newest artifact inside it is byte-exact (every blob SHA-256 + size
#      against its manifest)
#   4. that artifact rebuilds a working Havemind data directory in a scratch
#      location, passing SQLite `PRAGMA integrity_check`
#
# Prints a single PASS/FAIL verdict and exits 0 only on PASS. Everything happens
# in a temporary directory that is removed on exit; the live data directory and
# the live database are never opened for writing.
#
# Verification mode:
#   * "cli"     — runs `havemind backup verify` + `havemind backup restore`, i.e.
#                 the same code path the server ships (restoreInstance: manifest
#                 verification, integrity_check, epoch rotation). Used when a
#                 Havemind CLI is available OUTSIDE the container. Point
#                 HAVEMIND_CLI at it, e.g.
#                   export HAVEMIND_CLI="node $HOME/havemind/apps/server/bin/havemind.js"
#   * "offline" — same checks re-implemented over the artifact with python3 only
#                 (stdlib hashlib + sqlite3). Needs no node, no dist build and no
#                 container, so the drill is runnable on a bare sapserver.
#
# Usage: restore-drill.sh [snapshot-id]     (default: latest)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=restic.env
source "${HERE}/restic.env"

SNAPSHOT="${1:-latest}"
DRILL_DIR=""

cleanup() {
  if [ -n "${DRILL_DIR}" ] && [ -d "${DRILL_DIR}" ]; then
    rm -rf "${DRILL_DIR}"
  fi
}
trap cleanup EXIT

fail() {
  echo ""
  echo "=================================================="
  echo " RESTORE DRILL: FAIL"
  echo " reason: $*"
  echo "=================================================="
  exit 1
}

echo "== Havemind restore drill =="
echo "repo:     ${RESTIC_REPOSITORY}"
echo "snapshot: ${SNAPSHOT}"

# --- step 1/5: repository reachable and consistent ---------------------------
echo "-- step 1/5: repository reachable + restic check --"
mac_reachable || fail "${MAC_SSH_ALIAS} is not reachable (wake the Mac, then retry)."
restic check || fail "restic check reported a damaged repository."

# --- step 2/5: restore the snapshot back onto this host ----------------------
echo "-- step 2/5: restore snapshot into a scratch directory --"
DRILL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/havemind-drill.XXXXXX")"
chmod 700 "${DRILL_DIR}"
RESTORED="${DRILL_DIR}/restored"
mkdir -p "${RESTORED}"
restic restore "${SNAPSHOT}" --target "${RESTORED}" ||
  fail "restic restore of snapshot ${SNAPSHOT} failed."

# --- step 3/5: locate the newest artifact in what came back ------------------
echo "-- step 3/5: locate the newest artifact --"
# Artifact ids are ISO-8601 prefixed, so a lexicographic sort is chronological.
MANIFEST="$(find "${RESTORED}" -name manifest.json -type f | LC_ALL=C sort | tail -1)"
[ -n "${MANIFEST}" ] || fail "the restored snapshot contains no artifact manifest."
ARTIFACT="$(dirname "${MANIFEST}")"
echo "artifact: ${ARTIFACT}"

# --- step 4/5: verify the artifact + rebuild a scratch data directory --------
SCRATCH="${DRILL_DIR}/scratch-data"
CLI="${HAVEMIND_CLI:-}"
if [ -z "${CLI}" ] && command -v havemind >/dev/null 2>&1; then
  CLI="havemind"
fi

if [ -n "${CLI}" ]; then
  echo "-- step 4/5: verify + restore via the Havemind CLI (mode: cli) --"
  # shellcheck disable=SC2086
  ${CLI} backup verify --from "${ARTIFACT}" || fail "havemind backup verify failed."
  # shellcheck disable=SC2086
  ${CLI} backup restore --from "${ARTIFACT}" --to "${SCRATCH}" ||
    fail "havemind backup restore failed."
  MODE="cli"
else
  echo "-- step 4/5: verify + integrity check via python3 (mode: offline) --"
  command -v python3 >/dev/null 2>&1 ||
    fail "neither a Havemind CLI (HAVEMIND_CLI) nor python3 is available."
  mkdir -p "${SCRATCH}"
  cp -a "${ARTIFACT}/." "${SCRATCH}/"
  python3 - "${SCRATCH}" <<'PY' || fail "artifact verification failed (see output above)."
import hashlib
import json
import os
import sqlite3
import sys

artifact = sys.argv[1]
with open(os.path.join(artifact, "manifest.json"), "rb") as handle:
    manifest = json.load(handle)

if manifest.get("schemaVersion") != 1:
    print("FAIL: unsupported manifest schemaVersion:", manifest.get("schemaVersion"))
    sys.exit(1)

# Every blob must be present, byte-exact and the declared size. This is the same
# guarantee restoreInstance enforces before it starts an instance.
for entry in manifest["blobs"]:
    digest = entry["hash"]
    path = os.path.join(artifact, "blobs", digest[:2], digest)
    if not os.path.isfile(path):
        print("FAIL: manifest blob missing from the artifact:", digest)
        sys.exit(1)
    with open(path, "rb") as handle:
        payload = handle.read()
    if hashlib.sha256(payload).hexdigest() != digest or len(payload) != entry["size"]:
        print("FAIL: blob failed byte-exact verification:", digest)
        sys.exit(1)

database = os.path.join(artifact, manifest["database"]["filename"])
if not os.path.isfile(database):
    print("FAIL: the artifact has no database snapshot.")
    sys.exit(1)

connection = sqlite3.connect(database)
try:
    result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        print("FAIL: restored database failed integrity_check:", result)
        sys.exit(1)
    row = connection.execute(
        "SELECT instance_id, server_epoch, restore_epoch"
        " FROM instance_state WHERE singleton = 1"
    ).fetchone()
    if row is None:
        print("FAIL: the restored database has no instance_state row.")
        sys.exit(1)
    revisions = connection.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
finally:
    connection.close()

print("blobs verified:      %d (all byte-exact)" % len(manifest["blobs"]))
print("created at:          %s" % manifest["createdAt"])
print("instance id:         %s" % row[0])
print("source epoch:        %s (restore epoch %s)" % (row[1], row[2]))
print("revisions in backup: %d" % revisions)
print("integrity_check:     ok")
PY
  MODE="offline"
fi

# --- step 5/5: the rebuilt directory holds what the server opens -------------
echo "-- step 5/5: confirm the rebuilt data directory --"
[ -f "${SCRATCH}/havemind.db" ] ||
  fail "the rebuilt data directory has no havemind.db (the file the server opens)."

echo ""
echo "=================================================="
echo " RESTORE DRILL: PASS   (mode: ${MODE})"
echo " snapshot ${SNAPSHOT} -> artifact $(basename "${ARTIFACT}")"
echo " Record the date of this run in docs/pilot/known-limitations.md (AUD-10)."
echo "=================================================="
