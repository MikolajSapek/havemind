#!/usr/bin/env bash
# Publish a new Havemind plugin release to the distribution repo (BRAT + catalogue).
#
# One command replaces manual file delivery: it rebuilds the plugin, refuses to
# ship if any secret marker leaks into the bundle, copies the release artefacts to
# the plugin repo, commits, and cuts a GitHub Release tagged to the manifest
# version. BRAT (and the community catalogue) then auto-update every user.
#
# Usage:  bash scripts/publish-plugin.sh
# Assumes the plugin repo is checked out at ../obsidian-havemind (sibling of the
# monorepo). Override with PLUGIN_REPO=/path/to/repo.
set -euo pipefail

MONOREPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SRC="$MONOREPO/apps/obsidian-plugin"
PLUGIN_README="$PLUGIN_SRC/README.md"
PLUGIN_REPO="${PLUGIN_REPO:-$(cd "$MONOREPO/.." && pwd)/obsidian-havemind}"

if [[ ! -d "$PLUGIN_REPO/.git" ]]; then
  echo "FAIL: distribution repository is not available at $PLUGIN_REPO" >&2
  echo "Clone it there or run with PLUGIN_REPO=/absolute/path/to/obsidian-havemind." >&2
  exit 1
fi

echo "==> Checking release metadata"
node "$MONOREPO/scripts/check-plugin-release.mjs"

echo "==> Building plugin"
( cd "$PLUGIN_SRC" && npm run build >/dev/null )

echo "==> Secret scan (AT5)"
if grep -nE '\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|refresh_token|BEGIN [A-Z]* PRIVATE KEY|invitation_secret' "$PLUGIN_SRC/main.js"; then
  echo "FAIL: secret-like content in main.js — aborting"; exit 1
fi

VERSION="$(node -p "require('$PLUGIN_SRC/manifest.json').version")"
RELEASE_NOTES="$MONOREPO/docs/release-notes/$VERSION.md"
if [[ ! -s "$RELEASE_NOTES" ]]; then
  echo "FAIL: release notes are missing or empty: $RELEASE_NOTES" >&2
  exit 1
fi
if [[ ! -s "$PLUGIN_README" ]]; then
  echo "FAIL: plugin README is missing or empty: $PLUGIN_README" >&2
  exit 1
fi
echo "==> Version $VERSION"

echo "==> Copying artefacts to $PLUGIN_REPO"
cp "$PLUGIN_SRC/main.js" "$PLUGIN_SRC/manifest.json" "$PLUGIN_SRC/styles.css" \
   "$PLUGIN_SRC/manifest-beta.json" "$MONOREPO/versions.json" "$PLUGIN_README" \
   "$PLUGIN_REPO/"

cd "$PLUGIN_REPO"
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to publish."; exit 0
fi
git add main.js manifest.json styles.css manifest-beta.json versions.json README.md
git commit -m "release: $VERSION"
git push origin main

echo "==> Creating GitHub Release $VERSION"
gh release create "$VERSION" main.js manifest.json styles.css \
  --title "Havemind $VERSION" --notes-file "$RELEASE_NOTES"

echo "==> Done. BRAT users update automatically."
