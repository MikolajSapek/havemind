#!/usr/bin/env bash
# Havemind server, one-command install (plans/013-one-command-install.md).
#
#   curl -fsSL https://github.com/MikolajSapek/havemind/releases/latest/download/install.sh | bash
#
# Linux (Debian, Ubuntu, Raspberry Pi OS) and macOS. It installs Docker and
# Tailscale with their official installers when they are missing, ASKING first,
# starts the Havemind server from the published image, serves it inside your
# tailnet with Tailscale Serve (never Funnel, never the public internet), and
# prints one line to paste into Havemind in Obsidian.
#
# Re-running is safe: an existing install is updated or gets a new code.
#
# Environment (all optional):
#   HAVEMIND_VERSION   image tag to run (default: the version this script ships with)
#   HAVEMIND_HOME      where compose.yaml and .env live (default: ~/havemind-server)
#   HAVEMIND_OWNER     owner display name (default: asked)
#   HAVEMIND_VAULT     vault name (default: asked)
#   HAVEMIND_YES=1     answer yes to every question (unattended installs)
#   HAVEMIND_DRY_RUN=1 print what would run, change nothing (used by the tests)

set -euo pipefail

VERSION="${HAVEMIND_VERSION:-__HAVEMIND_VERSION__}"
[ "$VERSION" = "__HAVEMIND_VERSION__" ] && VERSION="latest"
IMAGE="ghcr.io/mikolajsapek/havemind-server:${VERSION}"
HOME_DIR="${HAVEMIND_HOME:-$HOME/havemind-server}"
PORT=8787
DRY="${HAVEMIND_DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nHavemind install stopped: %s\n' "$*" >&2; exit 1; }

# Runs a command, or prints it in a dry run.
run() {
  if [ "$DRY" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Yes/no from the terminal, also when the script itself arrives on stdin.
ask() {
  local question="$1" answer
  if [ "${HAVEMIND_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -r /dev/tty ]; then die "no terminal to ask: $question (set HAVEMIND_YES=1 to agree in advance)"; fi
  printf '%s [y/N] ' "$question" > /dev/tty
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES|t|T|tak) return 0 ;; *) return 1 ;; esac
}

# A value from the terminal with a default.
ask_value() {
  local question="$1" fallback="$2" answer
  if [ "${HAVEMIND_YES:-0}" = "1" ] || [ ! -r /dev/tty ]; then printf '%s' "$fallback"; return; fi
  printf '%s [%s] ' "$question" "$fallback" > /dev/tty
  read -r answer < /dev/tty || answer=""
  printf '%s' "${answer:-$fallback}"
}

# ---------------------------------------------------------------------------
# 1. The machine
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      case "${ID:-} ${ID_LIKE:-}" in
        *debian*|*ubuntu*|*raspbian*) ;;
        *) die "this Linux (${PRETTY_NAME:-unknown}) is not supported by the installer yet. Follow docs/self-hosting.md instead." ;;
      esac
    fi
    SUDO="sudo"
    [ "$(id -u)" = "0" ] && SUDO=""
    ;;
  Darwin)
    SUDO=""
    ;;
  *)
    die "$OS is not supported by the installer. Follow docs/self-hosting.md instead."
    ;;
esac

step "Havemind ${VERSION} on ${OS}"
say "This sets up a Havemind server on this machine, reachable only inside your Tailscale network."
say "Files go to ${HOME_DIR}. Nothing is opened to the public internet."

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
step "Docker"
if ! command -v docker >/dev/null 2>&1; then
  if [ "$OS" = "Linux" ]; then
    ask "Docker is not installed. Install it now with Docker's official script (needs sudo)?" \
      || die "Docker is required. Install it and run this again."
    run sh -c "curl -fsSL https://get.docker.com | ${SUDO} sh"
  else
    say "Docker is not installed. Install Docker Desktop (docker.com) or OrbStack (orbstack.dev),"
    say "start it once, and run this again."
    if command -v brew >/dev/null 2>&1 && ask "Install OrbStack with Homebrew now?"; then
      run brew install --cask orbstack
      say "Open OrbStack once so it finishes setting up, then run this again."
    fi
    exit 1
  fi
fi
DOCKER="docker"
if [ "$OS" = "Linux" ] && [ "$DRY" != "1" ] && ! docker info >/dev/null 2>&1; then
  DOCKER="${SUDO} docker"
fi
say "Docker is ready."

# ---------------------------------------------------------------------------
# 3. Tailscale
# ---------------------------------------------------------------------------
step "Tailscale"
TS="tailscale"
if [ "$OS" = "Darwin" ] && ! command -v tailscale >/dev/null 2>&1 \
  && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if ! command -v "$TS" >/dev/null 2>&1; then
  if [ "$OS" = "Linux" ]; then
    ask "Tailscale is not installed. Install it now with Tailscale's official script (needs sudo)?" \
      || die "Tailscale is required. Install it and run this again."
    run sh -c "curl -fsSL https://tailscale.com/install.sh | sh"
  else
    say "Install the Tailscale app (tailscale.com/download/mac or the App Store), sign in, and run this again."
    if command -v brew >/dev/null 2>&1 && ask "Install Tailscale with Homebrew now?"; then
      run brew install --cask tailscale
      say "Open Tailscale once and sign in, then run this again."
    fi
    exit 1
  fi
fi
TSC="$TS"
[ "$OS" = "Linux" ] && TSC="${SUDO} ${TS}"
if [ "$DRY" != "1" ] && ! $TS status >/dev/null 2>&1; then
  say "This machine is not signed in to Tailscale yet. A login link follows; open it in a browser."
  $TSC up
fi
DNS_NAME="${HAVEMIND_DNS_NAME:-}"
if [ -z "$DNS_NAME" ]; then
  DNS_NAME="$($TS status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n 1)"
fi
DNS_NAME="${DNS_NAME%.}"
[ -n "$DNS_NAME" ] || die "could not read this machine's Tailscale name. Is MagicDNS on in the Tailscale admin console?"
SERVER_URL="https://${DNS_NAME}"
say "This server will be ${SERVER_URL} inside your tailnet."

# ---------------------------------------------------------------------------
# 4. The server
# ---------------------------------------------------------------------------
step "Havemind server"
FRESH=1
if [ -f "${HOME_DIR}/compose.yaml" ]; then
  FRESH=0
  say "Havemind is already installed in ${HOME_DIR}; updating it to ${VERSION}."
fi
run mkdir -p "${HOME_DIR}"
if [ "$DRY" = "1" ]; then
  say "[dry-run] write ${HOME_DIR}/compose.yaml and ${HOME_DIR}/.env"
else
  cat > "${HOME_DIR}/compose.yaml" <<EOF
# Written by the Havemind installer. Re-running it rewrites this file.
name: havemind
services:
  havemind-server:
    image: ${IMAGE}
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    init: true
    restart: unless-stopped
    # Loopback only; Tailscale Serve fronts it. Never a public bind.
    ports: ["127.0.0.1:${PORT}:8787"]
    env_file: .env
    environment:
      HAVEMIND_HOST: "::"
      HAVEMIND_ALLOW_NON_LOOPBACK: "true"
      HAVEMIND_PORT: "8787"
      HAVEMIND_DATA_DIR: /data
      HAVEMIND_BACKUP_DIR: /backups
    volumes:
      - havemind-data:/data
      - ./backups:/backups
    tmpfs:
      - /tmp
    logging:
      driver: local
      options:
        max-size: "10m"
        max-file: "5"
volumes:
  havemind-data:
EOF
  cat > "${HOME_DIR}/.env" <<EOF
HAVEMIND_API_BASE_URL=${SERVER_URL}
HAVEMIND_SERVER_NAME=Havemind
EOF
  mkdir -p "${HOME_DIR}/backups"
fi
run $DOCKER compose --project-directory "${HOME_DIR}" pull
# The container runs as uid 1000 with no capabilities, so it cannot chown its
# backup folder itself; do it once from the same image, as root.
run $DOCKER run --rm --user 0 --entrypoint chown -v "${HOME_DIR}/backups:/backups" "${IMAGE}" -R 1000:1000 /backups
run $DOCKER compose --project-directory "${HOME_DIR}" up -d

if [ "$DRY" != "1" ]; then
  say "Waiting for the server to start..."
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1 || die "the server did not start. See: ${DOCKER} compose --project-directory ${HOME_DIR} logs"
fi
say "The server is running."

# ---------------------------------------------------------------------------
# 5. Tailscale Serve (inside the tailnet only)
# ---------------------------------------------------------------------------
step "Tailscale Serve"
run $TSC serve --bg --https=443 "http://127.0.0.1:${PORT}"
say "Served at ${SERVER_URL} for devices in your tailnet."

# ---------------------------------------------------------------------------
# 6. The owner and the code to paste
# ---------------------------------------------------------------------------
step "Your vault"
# $DOCKER is "docker" or "sudo docker": split on purpose.
# shellcheck disable=SC2206
CLI=( $DOCKER compose --project-directory "${HOME_DIR}" exec -T havemind-server node apps/server/bin/havemind.js )
if [ "$FRESH" = "1" ]; then
  OWNER="${HAVEMIND_OWNER:-$(ask_value 'Your name (shown to the people you invite):' "${USER:-Owner}")}"
  VAULT="${HAVEMIND_VAULT:-$(ask_value 'Name of the shared vault:' 'Shared vault')}"
  OUTPUT="$(run "${CLI[@]}" setup --owner "$OWNER" --vault "$VAULT")"
elif ask "Make a new code to connect another Obsidian as the owner? (the old code stops working)"; then
  OUTPUT="$(run "${CLI[@]}" rotate-pairing)"
else
  OUTPUT=""
fi
[ "$DRY" = "1" ] && [ -n "$OUTPUT" ] && say "$OUTPUT"
CODE="$(printf '%s\n' "$OUTPUT" | sed -n 's/^ *\(hm_pt_[A-Za-z0-9_-]*@https:[^ ]*\)$/\1/p' | head -n 1)"

step "Done"
if [ -n "$CODE" ]; then
  say "In Obsidian: install Havemind (Settings, Community plugins), open it, choose"
  say "\"I'll run the server\", then \"I've done this, connect\", and paste this one line:"
  say ""
  say "  ${CODE}"
  say ""
  say "It works once and expires soon. Your laptop and phone must be signed in to the same Tailscale account."
elif [ "$DRY" = "1" ]; then
  say "[dry-run] the code to paste would be printed here."
else
  say "Server updated. Your devices stay connected."
fi
