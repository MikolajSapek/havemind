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

## Connecting a vault (Connect flow)

Once the server is deployed and the owner has generated an invitation envelope
(see `deploy.md` step 5), connect the vault:

1. Command palette (`Cmd+P`) → **Havemind: Connect to Havemind** (or open the
   `obsidian://havemind-join` link — it opens the same paste screen, never
   carrying the secret in the URL).
2. Paste the `v1.…` invitation envelope handed to you by the owner.
3. Review the server, vault and inviter shown, then confirm. The plugin redeems
   the invitation with a refresh token it generates locally and stores in
   Obsidian SecretStorage — the token never touches `data.json`.
4. A **verification phrase** appears. The owner approves the matching phrase on
   their side; the plugin polls approval, then downloads the initial bootstrap.
5. The status bar settles on `Havemind: Synced`. From then on the live loop
   syncs on startup, window focus, regained network and a periodic interval.

On plugin load the plugin also resumes any in-progress or already-connected
onboarding automatically (on Obsidian's layout-ready), so a restart mid-connect
picks up where it left off. If there is no connection it stays the passive
shell — zero networking, `Havemind: disconnected`.

Note: the owner-side "create invitation" button and the full remote-file
materialisation (writing files that only ever existed on the *other* device)
are the remaining follow-up — see `DECISIONS.md` (F8-02b-A). Edits to files that
exist locally sync both ways today.

## Uninstall / reset

Quit Obsidian, delete `<vault>/.obsidian/plugins/havemind-sync/`, relaunch. No
data leaves the machine; sync bookkeeping lives only in the vault's plugin
`data.json`, and credentials live in Obsidian's SecretStorage.
