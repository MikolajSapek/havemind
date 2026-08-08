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
  (`100.x.y.z`). Verify with `tailscale status` — the server must be
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
   `obsidian://havemind-join` link — it opens the same screen, never carrying
   the secret in the URL). The screen has a paste box, a server-URL field and a
   **Connect** button.
2. Paste either the `v1.…` invitation envelope (invitee) **or** the owner's
   `hm_pt_…` pairing token from `havemind setup` (owner's first device). For a
   pairing token, also fill in the server URL
   (e.g. `https://<server>.<tailnet>.ts.net`); the plugin auto-detects which
   kind of token you pasted and runs the right flow.
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

## Owner: create an invitation from the plugin

The owner (whoever ran `setup`) can mint invitations without touching a
terminal. On the owner's connected machine: command palette (`Cmd+P`) →
**Havemind: Create invitation (owner)**. The plugin calls the server's
owner-only invitation endpoint with its access token and opens the Connect
screen showing the `v1.…` envelope to copy. The envelope contains a secret, is
single-use, and expires in **15 minutes** — hand it to the second participant
over a trusted channel promptly and never paste it into logs or chat.

## Remote-only files

Files that only ever existed on the *other* device now materialise locally: the
client fetches the opaque payload, decodes its path and content, and creates the
file. If the target path is already occupied by a *different* local file, the
incoming content is written to `Havemind Conflicts/` instead — Havemind never
overwrites pre-existing local content.

## Uninstall / reset

Quit Obsidian, delete `<vault>/.obsidian/plugins/havemind-sync/`, relaunch. No
data leaves the machine; sync bookkeeping lives only in the vault's plugin
`data.json`, and credentials live in Obsidian's SecretStorage.
