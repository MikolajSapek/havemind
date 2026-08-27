# Self-hosting Havemind

Havemind is **tailnet-only**. There is no cloud service, no public listener, and
no configuration in this guide that exposes anything to the public internet.
The server binds to `127.0.0.1` on its own box; the *only* way anyone reaches it
is over your private [Tailscale](https://tailscale.com) network, via
`tailscale serve`. Every person who joins your vault installs Tailscale and
joins the same tailnet, that's the entire access boundary.

This guide takes you from a fresh checkout to a working, multi-vault Havemind
server and a connected Obsidian plugin.

## Contents

- [a. Requirements](#a-requirements)
- [b. Stand up the server](#b-stand-up-the-server)
- [c. Become the owner](#c-become-the-owner)
- [d. Create more vaults](#d-create-more-vaults)
- [e. Front it with Tailscale](#e-front-it-with-tailscale)
- [f. Connect the plugin](#f-connect-the-plugin)
- [g. Invite people](#g-invite-people)
- [h. Safety notes](#h-safety-notes)

---

## a. Requirements

- **A box you control.** A home server, NAS, or a small VPS you administer,
  anything that can run Docker continuously. Havemind never runs "in the
  cloud" as a managed service; you are always the operator.
- **Docker Engine + the Compose v2 plugin** on that box (`docker compose
  version` should print something).
- **A Tailscale account**, with Tailscale installed and logged in on that box.
- **Every person who will sync** installs Tailscale and joins the *same*
  tailnet. Without that, they cannot reach the server, there is no public
  fallback.

## b. Stand up the server

From the repo root, on the box that will run the server:

```bash
git clone https://github.com/<your-fork>/havemind.git
cd havemind
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env`, at minimum set `HAVEMIND_API_BASE_URL` to the HTTPS URL
you will front the server with in step (e) below (it must be set correctly
*before* first start; it is baked into the server's discovery document):

```
HAVEMIND_API_BASE_URL=https://your-server.your-tailnet.ts.net
```

Build and start the container:

```bash
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
```

Confirm it is healthy:

```bash
docker compose -f deploy/compose.yaml ps
# STATUS should read "Up (healthy)" within about 40 seconds
```

### One-time volume ownership fix

The server's data (SQLite database + attachment blobs) lives in the named
Docker volume `havemind_havemind-data`, mounted at `/data` inside the
container. Docker creates a **fresh** named volume owned by `root`. The
container, however, runs as an unprivileged, non-root user (uid `1000`, the
stock `node` user baked into the image) with `cap_drop: [ALL]`, so it has no
capability to `chown` its own data directory from the inside. Fix the
ownership once, from the outside, using a disposable helper container that
mounts the same volume:

```bash
docker run --rm -v havemind_havemind-data:/data alpine chown -R 1000:1000 /data
```

You only need to do this once, right after the volume is first created (before
or after the first `up -d`, either order works, but the server will not be
able to write its database until the ownership is fixed).

## c. Become the owner

"Instance owner" is the person who ran setup: they own the first vault, hold
the only account that can create additional vaults, and approve who joins.
Run `setup` through the operator CLI, inside the running container:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js setup --owner "Your Name" --vault "My Vault"
```

This prints a **single-use pairing token** (`hm_pt_…`) and its expiry. That
token is how the owner's own first device connects (step f), hand it to
yourself now; only its hash is ever stored server-side.

## d. Create more vaults

Havemind uses "Model B": every vault has its **own**, independent owner. There
is no shared super-admin across vaults, each is fully isolated. Create an
additional vault with `create-vault`:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js create-vault --owner "Piotrek" --vault "TeamA"
```

This prints a fresh single-use pairing token for `Piotrek` as the new owner of
`TeamA`. Repeat per vault. For example, running two fully-isolated team vaults
on one server:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js create-vault --owner "Piotrek" --vault "TeamA"
# → TeamA, owned by Piotrek. Piotrek then invites Kuba into TeamA (step g).

docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js create-vault --owner "Maciek" --vault "TeamB"
# → TeamB, owned by Maciek. Maciek then invites Janek into TeamB (step g).
```

Piotrek and Kuba share `TeamA`; Maciek and Janek share `TeamB`. Neither pair
can see the other vault, same server, same tailnet, zero data overlap.

### Recovering a lost or expired token

Pairing tokens are single-use and expire. If a vault owner loses their token
before pairing, or their only device dies and they need to pair a replacement,
re-issue a fresh token for that specific vault, this works for any vault owner,
not just the instance owner:

```bash
# Instance owner (the first vault), no flag needed:
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js rotate-pairing

# Any additional vault created with create-vault, pass its vault id:
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js rotate-pairing --vault <vaultId>
```

The vault id is printed by `create-vault` (step d). Rotating invalidates that
vault's previous unpaired token and prints a new single-use one; other vaults are
untouched.

## e. Front it with Tailscale

The container only ever listens on `127.0.0.1` on the host, `tailscale
serve` is what makes it reachable from other devices on your tailnet, over
HTTPS, without ever touching the public internet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

Your Tailscale admin console must have HTTPS certificates enabled for the
tailnet (Admin console → DNS → *Enable HTTPS*) for this to work. Once it's
running, the server is reachable, from tailnet devices only, at:

```
https://your-server.your-tailnet.ts.net
```

That URL must match `HAVEMIND_API_BASE_URL` in `deploy/.env` exactly. Never
run `tailscale funnel` for Havemind, that would make it public, which
defeats the entire model.

## f. Connect the plugin

1. Install the Havemind Obsidian plugin (see the plugin's own install
   instructions, it is not in the community catalogue).
2. Open the vault, open the Havemind panel (ribbon icon or command palette →
   **Havemind: Connect to Havemind**).
3. Paste the Server URL (`https://your-server.your-tailnet.ts.net`) and the
   pairing token from step (c) or (d), then click **Connect**.
4. The status bar settles on `Havemind: Synced` once the initial bootstrap
   finishes.

## g. Invite people

Once connected, the vault's owner issues invitations without touching a
terminal:

1. Owner: command palette → **Havemind: Create connection (owner)**. This
   opens the Havemind pane with a one-time invitation envelope to copy.
2. Owner hands that envelope to the joining person over a trusted channel
   (it's a secret, single-use, and expires quickly).
3. Joining person: command palette → **Havemind: Connect to Havemind**, paste
   the envelope, confirm the reviewed server/vault/inviter.
4. A 6-digit verification code appears on the *joining* device only. The
   joining person reads it aloud; the owner types it into their own approval
   prompt. This human-in-the-loop step is what binds identity, it is never
   trusted from the client alone.
5. Once approved, the joining device downloads the initial bootstrap and
   settles on `Havemind: Synced`.

## h. Safety notes

- **Use a dedicated vault**, not your main notes vault. Havemind is
  feature-complete but still pre-1.0, treat it accordingly until you've run
  it for a while.
- **Don't run another sync tool on the same vault.** Obsidian Sync, iCloud
  Drive sync, and Obsidian LiveSync all fight with Havemind's own conflict
  handling if pointed at the same folder. Pick one syncing mechanism per
  vault.
- **Tailnet-only, always.** Nothing here is designed to be exposed to the
  public internet. Don't put the container's port behind a public reverse
  proxy, and don't use `tailscale funnel`.
- **Only appearance settings sync from `.obsidian/`.** Theme stylesheets, CSS
  snippets, hotkeys, graph view settings and the `appearance.json` / `app.json`
  settings mirror between devices, from an explicit allowlist. Plugin code and plugin state
  (`.obsidian/plugins/`, every `data.json` included), the enabled-plugins
  registry (`community-plugins.json`) and the per-machine window layout
  (`workspace.json`) are never synced, so no member of a vault can replace
  another member's installed plugin code.
- **Data on the server is stored in plaintext.** The live database and blob
  store are unencrypted on the volume; the `havemind_db_key` secret encrypts
  only checkpoint snapshots, not the live data. Anyone who controls the server
  can read the vault, so security rests on trusting the host and keeping access
  tailnet-only.
- **Check the project's stated security model** before connecting anything
  you consider sensitive, see the "Security model" section of the main
  [README](../README.md) for the current state of encryption in transit and
  at rest.
