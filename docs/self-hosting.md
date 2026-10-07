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
- [i. Backups](#i-backups)
- [j. Update the server](#j-update-the-server)

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

On the box that will run the server:

```bash
git clone https://github.com/MikolajSapek/havemind.git
cd havemind
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env`, at minimum set `HAVEMIND_API_BASE_URL` to the HTTPS URL
you will front the server with in step (e) below (it must be set correctly
*before* first start; it is baked into the server's discovery document):

```
HAVEMIND_API_BASE_URL=https://your-server.your-tailnet.ts.net
```

### Server preparation

There is no database key to generate: the live database and blob store are
plaintext on the volume (see [h. Safety notes](#h-safety-notes)).

Before starting the container, prepare its writable storage, once. The shipped
Compose service runs as uid 1000 with every capability dropped, so it cannot
change ownership from the inside, and Docker creates a fresh volume and a missing
bind-mount directory owned by root:

```bash
docker volume create havemind_havemind-data
docker run --rm -v havemind_havemind-data:/data alpine chown -R 1000:1000 /data
mkdir -p deploy/backups
chmod 700 deploy/backups
docker run --rm -v "$PWD/deploy/backups:/backups" alpine chown -R 1000:1000 /backups
```

The backup bind mount is relative to `deploy/compose.yaml`. Without this
preparation Docker can create it as root-owned and scheduled backups fail with
permission errors. Run these commands from the repository root.

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

`havemind doctor` checks the configuration (including the base URL) and the
data directory, and prints no secret values:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js doctor
```

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

### Give people access to the server

Everyone who syncs needs Tailscale on every device they sync from, signed in to
your tailnet:

1. In the Tailscale admin console, open **Users**, select **Invite external
   users**, and send the invite by email or as a link.
2. They open the invite, sign in to Tailscale, and install the Tailscale app on
   each device, phones included.
3. From one of their devices, open
   `https://your-server.your-tailnet.ts.net/.well-known/havemind` in a browser.
   It should show `"service":"havemind"`. If it does not load, the device is
   not on your tailnet yet, and the plugin will not connect either.

### Per-client rate limits behind the proxy (optional)

Requests that carry a device token are rate limited per device. Requests that
do not (invitation review and redeem, approval polling, owner pairing,
bootstrap, rejoin, and a refresh with a token nobody knows) are limited per
client address, 120 a minute. Behind `tailscale serve` every one of them reaches
the server from the proxy, so by default everyone using your server shares one
bucket: a device that polls or retries a lot makes everyone else's requests wait
out the minute. The plugin backs off and retries on a `429`, so the cost is
delay, not lost data, and on a small tailnet it is tolerable. That is why the
default stays as it is.

To give each client its own bucket, tell the server which address your proxy
connects from, in `HAVEMIND_TRUSTED_PROXIES`: comma-separated IP addresses or
CIDR ranges, empty by default. On a connection from one of those addresses the
server takes the client's address from `X-Forwarded-For`; on any other
connection it ignores the header, so a client cannot choose its own bucket. The
address is used for nothing but choosing the bucket.

The address to list is the one **the server** sees, not the client's and, in the
shipped Compose stack, not `127.0.0.1`: `tailscale serve` connects to the
published port on the host, and Docker forwards that into the container from an
address on the Compose network. List that network's range:

```bash
docker network inspect havemind_default \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
# e.g. 172.18.0.0/16
```

Put it in `deploy/.env` and recreate the container:

```
HAVEMIND_TRUSTED_PROXIES=172.18.0.0/16
```

```bash
docker compose -f deploy/compose.yaml up -d
```

`tailscale serve` sets `X-Forwarded-For` to the tailnet address of the calling
device and replaces anything the client sent (Tailscale 1.98,
`addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go`). Confirm the whole chain
from two tailnet devices: use up the limit on the first, then try the second
straight away.

```bash
probe() { curl -s -o /dev/null -w '%{http_code} ' -X POST \
  -H 'content-type: application/json' -d '{"invitationToken":"x"}' \
  https://your-server.your-tailnet.ts.net/invitations/review; }
for i in $(seq 125); do probe; done; echo   # first device: ends in 429s
probe; echo                                 # second device: anything but 429
```

If the second device gets `429` too, the setting did not match: the server does
not see your proxy at an address you listed, or your Tailscale version does not
send the header. The server then behaves exactly as it does without the setting,
so nothing is worse than before. The server refuses to start on a value it
cannot parse, and `havemind doctor` says why. If you recreate the stack and
Docker gives the Compose network another range, repeat the `docker network
inspect` step.

List only addresses that belong to your proxy: anything that can connect from a
listed address can choose its own bucket, which is why the shipped stack
publishes the port on the host's loopback and nowhere else. A range that matches
every address (`0.0.0.0/0`) is refused.

## f. Connect the plugin

1. Install the Havemind Obsidian plugin: Settings, then Community plugins,
   then Browse, and search for **Havemind**. Needs Obsidian 1.11.4 or newer.
2. Open the vault, open the Havemind panel (ribbon icon or command palette →
   **Havemind: Connect to Havemind**), choose **I'll run the server**, then
   **I've done this, connect**.
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
- **Some notes never sync, silently.** Havemind skips a file when any path
  segment starts with a dot (`Notes/.drafts/x.md`, `.trash/…`), when it sits at
  the top level of the reserved `Havemind Conflicts/` folder (matched
  case-insensitively), or when its extension is neither `.md` nor an allowed
  attachment (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `pdf`, max 25 MB).
  Nested folders are fine, `Notes/Havemind Conflicts/x.md` does sync; only the
  top level is reserved. The plugin shows no warning for a skipped file, so keep
  notes you want synced out of dot-paths and out of `Havemind Conflicts/`. Full
  rules: [known limitations](pilot/known-limitations.md#dot-paths-and-the-reserved-folder-aud-07).

- **Data on the server is stored in plaintext.** The live database and blob
  store are unencrypted on the volume, and so are the backups the server
  writes; encrypt copies you move off the server. Anyone who controls the server
  can read the vault, so security rests on trusting the host and keeping access
  tailnet-only.
- **Check the project's stated security model** before connecting anything
  you consider sensitive, see the "Security model" section of the main
  [README](../README.md) for the current state of encryption in transit and
  at rest.

## i. Backups

The shipped Compose file turns scheduled backups on: every 24 hours the server
writes a snapshot of its database and blobs to `deploy/backups/` on the host and
keeps the newest 7. Snapshots are plaintext, like the live data, so encrypt any
copy you move off the box. To write one now:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js backup --to /backups
```

Settings, verifying a snapshot and restoring one are in
[backup and restore](operations/backup-restore.md).

## j. Update the server

The plugin updates itself through Obsidian; the server does not. When the
[changelog](../CHANGELOG.md) lists a server change, update from the repository
root, after a fresh backup:

```bash
docker compose -f deploy/compose.yaml exec havemind-server \
  node apps/server/bin/havemind.js backup --to /backups
git pull
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps
```

`git pull` leaves `deploy/.env`, the data volume and `deploy/backups/` alone,
since none of them are in the repository, and the server applies its own
database migrations when it starts. Wait for `Up (healthy)` before syncing
again.
