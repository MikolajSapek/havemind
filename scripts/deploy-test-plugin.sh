#!/usr/bin/env bash
# Build Havemind once and install the exact same artefacts in both local test vaults.
# Reload the plugin in Obsidian after this script finishes.
set -euo pipefail

MONOREPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SOURCE="$MONOREPO/apps/obsidian-plugin"
TARGETS=(
  "/Users/sapek/Documents/ObsidianVaults/Testvault/Testvault/.obsidian/plugins/havemind-sync"
  "/Users/sapek/Documents/ObsidianVaults/Testvault2/.obsidian/plugins/havemind-sync"
)
ARTIFACTS=(main.js manifest.json manifest-beta.json styles.css)

echo "==> Checking release metadata"
node "$MONOREPO/scripts/check-plugin-release.mjs"
echo "==> Building plugin"
(cd "$PLUGIN_SOURCE" && npm run build)

for target in "${TARGETS[@]}"; do
  if [[ ! -d "$target" ]]; then
    echo "FAIL: plugin folder does not exist: $target" >&2
    exit 1
  fi
  echo "==> Installing in $target"
  cp "${ARTIFACTS[@]/#/$PLUGIN_SOURCE/}" "$target/"
done

echo "==> Verifying identical installs"
for artifact in "${ARTIFACTS[@]}"; do
  source_hash="$(shasum -a 256 "$PLUGIN_SOURCE/$artifact" | awk '{print $1}')"
  for target in "${TARGETS[@]}"; do
    target_hash="$(shasum -a 256 "$target/$artifact" | awk '{print $1}')"
    [[ "$source_hash" == "$target_hash" ]] || {
      echo "FAIL: $artifact differs in $target" >&2
      exit 1
    }
  done
done

echo "Done. Reload Havemind in each open Obsidian vault to activate this build."
