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

# Everything runs inside main(), called on the last line: with `curl | bash`
# the script arrives on stdin, and a command that reads stdin (docker compose
# exec) would otherwise eat the rest of it and end the install silently.
main() {

# ---------------------------------------------------------------------------
# 1. The machine
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)
    if [ -r /etc/os-release ]; then
      # Read in a subshell: os-release defines VERSION, which would replace ours.
      # shellcheck disable=SC1091
      DISTRO="$(. /etc/os-release && printf '%s %s|%s' "${ID:-}" "${ID_LIKE:-}" "${PRETTY_NAME:-unknown}")"
      case "${DISTRO%%|*}" in
        *debian*|*ubuntu*|*raspbian*) ;;
        *) die "this Linux (${DISTRO#*|}) is not supported by the installer yet. Follow docs/self-hosting.md instead." ;;
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
if [ "$FRESH" = "1" ]; then
  # A stack set up by hand (deploy/compose.yaml, project "havemind") must never
  # be recreated with this image and a rewritten .env.
  if [ -n "$($DOCKER ps -aq --filter label=com.docker.compose.project=havemind 2>/dev/null)" ] \
    || { [ "$DRY" != "1" ] && curl -fsS "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; }; then
    die "this machine already runs Havemind, set up another way. Update it as docs/self-hosting.md says, section j."
  fi
fi
run mkdir -p "${HOME_DIR}"
# Agents reach the server by its tailnet name. On Linux that name and the
# Tailscale Serve port live on the host's network; Docker Desktop on a Mac
# resolves and routes it from its own network.
AGENT_NETWORK=""
[ "$OS" = "Linux" ] && AGENT_NETWORK="    network_mode: host"
if [ "$DRY" = "1" ]; then
  say "[dry-run] write ${HOME_DIR}/compose.yaml and ${HOME_DIR}/.env"
else
  cat > "${HOME_DIR}/compose.yaml" <<EOF
# Written by the Havemind installer. Re-running it rewrites this file.
name: havemind-install
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
  # AI agents (plan 014), off until: docker compose --profile agents up -d
  # Same image, its own process. The model key lives in agents.env, which this
  # installer never writes or reads.
  havemind-agents:
    image: ${IMAGE}
    profiles: [agents]
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    init: true
    restart: unless-stopped
    command: ["node", "agent/havemind-agent.mjs", "run"]
${AGENT_NETWORK}
    env_file:
      - path: agents.env
        required: false
    environment:
      HAVEMIND_AGENTS_DIR: /agents
    volumes:
      - ./agents:/agents
    tmpfs:
      - /tmp
    logging:
      driver: local
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  havemind-data:
EOF
  # Kept on a re-run: the owner may have added settings since.
  if [ ! -f "${HOME_DIR}/.env" ]; then
    cat > "${HOME_DIR}/.env" <<EOF
HAVEMIND_API_BASE_URL=${SERVER_URL}
HAVEMIND_SERVER_NAME=Havemind
EOF
  fi
  mkdir -p "${HOME_DIR}/backups" "${HOME_DIR}/agents"
fi
run $DOCKER compose --project-directory "${HOME_DIR}" pull
# The container runs as uid 1000 with no capabilities, so it cannot chown its
# data volume or backup folder itself (a fresh volume is root-owned); do it
# from the same image, as root. Not `compose run`: it keeps cap_drop ALL, and
# root without CAP_CHOWN cannot chown. `up --no-start` creates the volume first.
run $DOCKER compose --project-directory "${HOME_DIR}" up --no-start
run $DOCKER run --rm --user 0 --entrypoint chown \
  -v havemind-install_havemind-data:/data -v "${HOME_DIR}/backups:/backups" \
  -v "${HOME_DIR}/agents:/agents" "${IMAGE}" -R 1000:1000 /data /backups /agents
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
NEW_CODE=0
OUTPUT=""
# Written only after setup succeeds, so a run that stopped earlier sets up again.
OWNER_MARK="${HOME_DIR}/.owner-ready"
if [ ! -f "$OWNER_MARK" ]; then
  OWNER="${HAVEMIND_OWNER:-$(ask_value 'Your name (shown to the people you invite):' "${USER:-Owner}")}"
  VAULT="${HAVEMIND_VAULT:-$(ask_value 'Name of the shared vault:' 'Shared vault')}"
  NEW_CODE=1
  OUTPUT="$(run "${CLI[@]}" setup --owner "$OWNER" --vault "$VAULT")"
  run touch "$OWNER_MARK"
elif ask "Make a new code to connect another Obsidian as the owner? (the old code stops working)"; then
  NEW_CODE=1
  OUTPUT="$(run "${CLI[@]}" rotate-pairing)"
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
  say "It works once and expires in 15 minutes. Your laptop and phone must be signed in to the same Tailscale account."
elif [ "$DRY" = "1" ]; then
  say "[dry-run] the code to paste would be printed here."
elif [ "$NEW_CODE" = "1" ]; then
  # The token is single-use: never swallow it because its line looked different.
  say "The one-line code was not found in the server's answer. Here is the answer in full;"
  say "paste the hm_pt_ token and the Server URL (${SERVER_URL}) into Havemind:"
  say ""
  say "$OUTPUT"
else
  say "Server updated. Your devices stay connected."
fi
}

main "$@"
