# Deploying the Havemind server on sapserver (pilot runbook)

Paste-ready runbook for standing up the single-service Havemind server on
`sapserver` behind Tailscale. It matches the real `deploy/compose.yaml`,
`deploy/.env.example`, `apps/server/Dockerfile` and the `havemind` CLI as they
exist in the repo today.

Conventions (from `plan/08-sapserver-operations.md` and `plan/02-fundamenty.md`):

- Compose file lives at `/srv/compose/havemind/`.
- Secrets are files under `/srv/secrets/` (mode `0600`), never inline env values.
- The host port is published on `127.0.0.1` only; the tailnet reaches it via
  `tailscale serve`. The server is **never** bound to a public/wildcard address.
- Note data lives in the Docker-managed named volume `havemind-data` — this
  stack does **not** use a `/srv/appdata/havemind` bind mount.

> **Steps marked `[sudo]` require the sapserver sudo password.** Per
> `plan/01-zasady-i-slownik.md` rule 5 the agent must not run these without the
> user; the user runs them. Everything else can run as the ordinary login user.

> **Honesty note:** the pilot ships **without end-to-end encryption** — use only
> the two disposable pilot vaults. Step 5 (first invitation) is currently
> **blocked** — see the warning in that section.

Where each command runs is called out. If your shell prompt already shows
`…@sapserver`, you are on the server: run server commands directly (no `ssh`).

---

## 0. Prerequisites

- `sapserver` reachable over Tailscale (`tailscale status` from your Mac shows
  it online). Tailscale 1.98.x is installed on sapserver.
- Docker Engine + the Compose v2 plugin installed on sapserver (`docker
  compose version`). Installing Docker or adding your user to the `docker`
  group is a `[sudo]` step — confirm with the user first (rule 5).
- This repo checked out on sapserver (or rsynced there — step 1).

---

## 1. Get the sources onto sapserver (no secrets)

Run from your **Mac**, in the repo root. `rsync` excludes build output, local
env and any secrets so nothing sensitive is copied:

```bash
rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'coverage' \
  --exclude '**/main.js' \
  --exclude 'deploy/.env' \
  --exclude '.env' \
  ./ sapserver:/srv/compose/havemind/
```

`/srv/compose` may need creating once (`[sudo]` if `/srv` is root-owned):

```bash
# on sapserver, once
[sudo] mkdir -p /srv/compose/havemind
[sudo] chown "$USER":"$USER" /srv/compose/havemind   # so rsync can write as you
```

Alternative to rsync: `git clone https://github.com/MikolajSapek/havemind.git
/srv/compose/havemind` on sapserver, then `git pull` to update. The repo is
private; never commit `deploy/.env` or anything under `/srv/secrets`.

---

## 2. Secrets, env and the container

All commands in this section run **on sapserver**, in
`/srv/compose/havemind`.

### 2a. Create the secrets directory `[sudo]`

```bash
[sudo] mkdir -p /srv/secrets
[sudo] chmod 700 /srv/secrets
```

### 2b. Generate the database key

The key generator only prints random bytes; run it wherever Node ≥22.20 is
available. **Trap:** `deploy/compose.yaml`'s runtime image does **not** include
the `havemind` CLI wrapper (`bin/` is not copied in the Dockerfile — only
`dist/`, `package.json`, `healthcheck.js` and `node_modules`). So run the CLI
one of these two ways, not `docker compose run … havemind`:

- **On your Mac** (repo built with `npm ci`):

  ```bash
  node apps/server/bin/havemind.js generate-db-key
  ```

- **On sapserver against the build stage** (has full sources + the CLI),
  after the image is built in step 2d:

  ```bash
  docker compose -f /srv/compose/havemind/deploy/compose.yaml \
    run --rm --no-deps --entrypoint "" havemind-server \
    node apps/server/dist/setup/cli.js generate-db-key
  ```

The command prints the key plus a safe (non-secret) fingerprint. Write **only
the key value** (first line) to the secret file `[sudo]`:

```bash
# paste the printed key value between the quotes (no trailing newline noise)
printf '%s' 'PASTE_KEY_VALUE_HERE' | [sudo] tee /srv/secrets/havemind_db_key >/dev/null
[sudo] chmod 600 /srv/secrets/havemind_db_key
```

### 2c. Fill in the environment file

`compose.yaml` reads `deploy/.env`. Copy the template and set the public URL
(this must be the exact HTTPS URL clients reach — it is baked into the
discovery document, so set it **before** starting the container):

```bash
cp deploy/.env.example deploy/.env
```

Get sapserver's MagicDNS name to fill `HAVEMIND_API_BASE_URL`:

```bash
tailscale status | head -1     # first column is the node's <name>.<tailnet>.ts.net
```

Edit `deploy/.env` so:

```
HAVEMIND_API_BASE_URL=https://sapserver.<tailnet>.ts.net
```

Leave the other values at their defaults unless you have a reason to change
them (`HAVEMIND_PORT=8787`, `HAVEMIND_IMAGE_TAG=0.0.0-private`,
`HAVEMIND_SERVER_NAME=Havemind`, `HAVEMIND_LOG_LEVEL=info`). `deploy/.env`
holds no secret — the DB key is the file secret from step 2b.

### 2d. Build and start

```bash
docker compose -f /srv/compose/havemind/deploy/compose.yaml build
docker compose -f /srv/compose/havemind/deploy/compose.yaml up -d
```

The container runs non-root (`1000:1000`), read-only, all caps dropped,
`no-new-privileges`, with the DB key mounted as a Docker secret. Confirm it is
healthy (the Compose healthcheck runs `apps/server/healthcheck.js`):

```bash
docker compose -f /srv/compose/havemind/deploy/compose.yaml ps
# STATUS should read "Up (healthy)" within ~40s
docker compose -f /srv/compose/havemind/deploy/compose.yaml logs --tail=50 havemind-server
```

### 2e. Initialise the instance owner

`setup` writes to the database in the `havemind-data` volume, so it must run
against the same data directory the server uses. Run it inside the running
container (CLI via `dist`, since `bin/` is absent — see the 2b trap):

```bash
docker compose -f /srv/compose/havemind/deploy/compose.yaml \
  exec -e HAVEMIND_DATA_DIR=/data havemind-server \
  node apps/server/dist/setup/cli.js setup --owner "Mikolaj" --vault "Pilot Vault A"
```

This prints the **owner's single-use pairing token** (for the owner's own first
device) and its expiry. Hand it to the first device promptly; only its hash is
stored server-side.

---

## 3. Expose over Tailscale (HTTPS on 443) `[sudo]`

Run **on sapserver**. This fronts the loopback port `8787` with Tailscale's
HTTPS on 443, on sapserver's own tailnet name — no public exposure, no Funnel:

```bash
[sudo] tailscale serve --bg --https=443 http://127.0.0.1:8787
[sudo] tailscale serve status
```

> **Verify the syntax on your Tailscale 1.98 build** with `tailscale serve
> --help` before relying on it. The `--https=<port> <target>` form above is the
> current documented shape, but the `serve` CLI has changed across releases;
> if 1.98 rejects it, `tailscale serve --help` shows the exact accepted form.
> Do **not** use `tailscale funnel` — that would make the server public, which
> the pilot forbids (`plan/08`, tailnet-only).

MagicDNS HTTPS also requires that HTTPS certificates are enabled for the
tailnet (Tailscale admin console → DNS → *Enable HTTPS*). If `serve` complains
about certificates, enable that first (admin action, not a server command).

---

## 4. Health check

From **either Mac on the tailnet** (or sapserver itself):

```bash
curl -fsS https://sapserver.<tailnet>.ts.net/healthz
# → {"status":"ok"}

curl -fsS https://sapserver.<tailnet>.ts.net/.well-known/havemind | head
# → discovery document; "apiBaseUrl" must equal HAVEMIND_API_BASE_URL
```

If `/healthz` succeeds over HTTPS from the *other* Mac, the transport path
(container → loopback publish → tailscale serve → tailnet) is proven end to
end.

---

## 5. First invitation for the second participant

The onboarding HTTP surface now exists (F8-02c): invitation review/redeem,
device-approval polling, bootstrap and refresh→access rotation. Generating an
invitation for the *second* participant (an `editor` membership) is an
**owner-only, authenticated** action against:

```
POST /vaults/:vaultId/invitations      (Authorization: Bearer <owner access token>)
```

### 5a. Get the owner connected first

The owner's own first device connects with the single-use pairing token printed
by `setup` (step 2e). Once that device is connected in Obsidian (status bar
reads `Havemind: Synced`), its session holds a rotating refresh token in
SecretStorage and can mint short-lived access tokens via `POST /auth/refresh`.
An owner-side "create invitation" affordance in the plugin UI is the natural
place for step 5b; until that button ships it can be issued by hand.

### 5b. Create the invitation (owner, authenticated)

From the owner's connected machine, with a current access token `$ACCESS`:

```bash
VAULT_ID=<the vault UUID from setup>
curl -fsS -X POST \
  "https://sapserver.<tailnet>.ts.net/vaults/$VAULT_ID/invitations" \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"intendedRole":"editor","intendedMemberDisplayName":"Friend"}'
# → { "invitationId", "invitationToken":"hm_it_…", "intendedMemberId",
#     "intendedMemberDisplayName", "expiresAt" }  (valid 15 minutes, single use)
```

The `invitationToken` is a secret. Wrap it in the canonical envelope the plugin
expects (never put the token in a query string — `plan/05` anti-spec):

```
envelope = "v1." + base64url(JSON.stringify({
  version: 1,
  serverOrigin: "https://sapserver.<tailnet>.ts.net",
  invitationToken: "hm_it_…"
}))
```

Hand that `v1.…` envelope string to the second participant over a trusted
channel. It expires in 15 minutes and is single-use.

### 5c. Second participant connects

On the second MacBook (Obsidian + the Havemind plugin installed, same tailnet —
see `install.md`): command palette → **Havemind: Connect to Havemind**, paste
the `v1.…` envelope, confirm the reviewed server/vault/inviter, and approve. The
owner approves the matching **verification phrase** on their side; the second
device then downloads the initial bootstrap and the status bar settles on
`Havemind: Synced`. From there the live loop (startup / focus / online /
interval) keeps both vaults in sync.

---

## Teardown / restart

```bash
docker compose -f /srv/compose/havemind/deploy/compose.yaml down       # stop, keep data volume
docker compose -f /srv/compose/havemind/deploy/compose.yaml up -d      # restart
[sudo] tailscale serve --https=443 off                                 # stop serving (verify syntax on 1.98)
```

The `havemind-data` volume persists across `down`/`up`. Removing it
(`docker volume rm havemind_havemind-data`) destroys the pilot database — only
do this to reset the pilot, and note the pilot runs without off-host backup
(see `DECISIONS.md`).
