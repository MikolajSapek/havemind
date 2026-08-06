#!/usr/bin/env bash
# Publish a new Havemind plugin release to the distribution repo (BRAT + catalogue).
#
# One command replaces manual file delivery: it rebuilds the plugin, refuses to
# ship if any secret marker leaks into the bundle, copies the four artefacts to
# the plugin repo, commits, and cuts a GitHub Release tagged to the manifest
# version. BRAT (and the community catalogue) then auto-update every user.
#
# Usage:  bash scripts/publish-plugin.sh
# Assumes the plugin repo is checked out at ../obsidian-havemind (sibling of the
# monorepo). Override with PLUGIN_REPO=/path/to/repo.
set -euo pipefail

MONOREPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SRC="$MONOREPO/apps/obsidian-plugin"
PLUGIN_REPO="${PLUGIN_REPO:-$(cd "$MONOREPO/.." && pwd)/obsidian-havemind}"

echo "==> Building plugin"
( cd "$PLUGIN_SRC" && npm run build >/dev/null )

echo "==> Secret scan (AT5)"
if grep -nE '\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|refresh_token|BEGIN [A-Z]* PRIVATE KEY|invitation_secret' "$PLUGIN_SRC/main.js"; then
  echo "FAIL: secret-like content in main.js — aborting"; exit 1
fi

VERSION="$(node -p "require('$PLUGIN_SRC/manifest.json').version")"
echo "==> Version $VERSION"

echo "==> Copying artefacts to $PLUGIN_REPO"
cp "$PLUGIN_SRC/main.js" "$PLUGIN_SRC/manifest.json" "$PLUGIN_SRC/styles.css" \
   "$PLUGIN_SRC/manifest-beta.json" "$MONOREPO/versions.json" "$PLUGIN_REPO/"

cd "$PLUGIN_REPO"
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to publish."; exit 0
fi
git add main.js manifest.json styles.css manifest-beta.json versions.json
git commit -m "release: $VERSION"
git push origin main

echo "==> Creating GitHub Release $VERSION"
gh release create "$VERSION" main.js manifest.json styles.css \
  --title "$VERSION" --notes "Havemind $VERSION"

echo "==> Done. BRAT users update automatically."
