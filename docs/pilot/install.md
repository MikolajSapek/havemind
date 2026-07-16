# Installing the Havemind plugin on both MacBooks (pilot)

This guide installs the desktop Havemind Obsidian plugin from the built package
in `apps/obsidian-plugin/dist/` onto the two pilot MacBooks. It is a manual
"unmanaged plugin" install — Havemind is private and is not in the Obsidian
community catalogue.

> Honesty note: the pilot ships **without end-to-end encryption**. Use only the
> two disposable pilot vaults, never a real vault (see `plan/01-zasady-i-slownik.md`).

## What the package contains

`apps/obsidian-plugin/dist/`:

- `main.js` — the bundled plugin (built with `npm run build` in the workspace).
- `manifest.json` — plugin id `havemind-sync`, desktop-only.

Rebuild any time with:

```bash
npm ci
npm run build --workspace @havemind/obsidian-plugin
# → apps/obsidian-plugin/main.js (also copy into dist/ for distribution)
```

## Prerequisites (both machines)

- Obsidian 1.11.4 or newer (the manifest `minAppVersion`).
- Both MacBooks joined to the **same tailnet** as `sapserver`
  (`100.112.246.26`). Verify with `tailscale status` — the server must be
  reachable before the plugin can sync. The second Mac in particular must be
  added to the tailnet (Tailscale admin console → invite/authorise the device)
  or it will stay `Offline`.

## Install steps (repeat on each MacBook)

1. Open (or create) the disposable pilot vault in Obsidian.
2. In Finder, go to the vault folder and open the hidden `.obsidian` directory
   (`Cmd+Shift+.` toggles hidden files).
3. Create the plugin folder:

   ```
   <vault>/.obsidian/plugins/havemind-sync/
   ```

4. Copy `main.js` and `manifest.json` from `apps/obsidian-plugin/dist/` into
   that folder. The folder must contain exactly those two files.
5. In Obsidian: **Settings → Community plugins**. If "Restricted mode" is on,
   turn it off (this only enables community plugins locally; nothing is
   published).
6. Under **Installed plugins**, click the refresh icon, find **Havemind**, and
   toggle it **on**.
7. Open the command palette (`Cmd+P`) → **Havemind: Open activity**, or click
   the ribbon icon, to confirm the plugin loaded. The status bar shows
   `Havemind: disconnected` until the vault is connected.

## Second device — extra step

The second Mac must be on the **same tailnet** (step in Prerequisites) so it can
reach `sapserver`. Once both devices are connected to the same server vault,
edits made on one appear on the other after the next sync cycle
(startup / window focus / regained network / periodic interval).

## Connecting a vault (onboarding)

Connecting to the server (paste the invitation envelope, verification-phrase
approval, initial download) is driven by the onboarding wizard. Its runtime
wiring is tracked as the remaining follow-up of F8-02a (see the repo report and
`DECISIONS.md`); until it lands, the plugin installs and runs as the passive
shell described above.

## Uninstall / reset

Quit Obsidian, delete `<vault>/.obsidian/plugins/havemind-sync/`, relaunch. No
data leaves the machine; sync bookkeeping lives only in the vault's plugin
`data.json`, and credentials live in Obsidian's SecretStorage.
