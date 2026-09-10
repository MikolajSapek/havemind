<p align="center">
  <img src="design/brand/havemind-banner-white.png" alt="Havemind, a shared Obsidian vault for people you trust" width="100%">
</p>

<p align="center">
  <img src="design/brand/havemind-hero.gif" alt="A note typed on a MacBook appearing on an iPhone seconds later, the Havemind pane visible on both" width="100%">
</p>

# Havemind

### Share one Obsidian vault with people you trust.

Havemind is private, self-hosted sync for [Obsidian](https://obsidian.md). It is
built for two or three people sharing one vault: each person keeps a normal local
copy while a server you control relays changes, keeps history, and records who
changed what.

Use it with people first. If you choose to use Claude, MCP, or another local
agent in that vault, Havemind keeps those changes in the same history too.

**Version 1.4.7, desktop and mobile.** Runs on macOS, Windows and Linux, and on
iOS and Android through the Obsidian mobile app. A two-week, two-device pilot
ran without data loss, including through three real incidents. Havemind does
not provide end-to-end encryption: the self-hosted server stores synced content
in plaintext. Read the
[security model](#security-model) before connecting a vault you care about.

**Self-hosting your own instance?** See
[docs/self-hosting.md](docs/self-hosting.md) for the full zero-to-working
guide (Docker Compose + Tailscale, tailnet-only).

**Connecting Claude or an AI agent?** See
[docs/using-with-ai-agents.md](docs/using-with-ai-agents.md) for the
requirements and the steps.

## Install

Havemind needs two things: the plugin, and a server you run.

**The plugin.** In Obsidian, open Settings, then Community plugins, then
Browse, and search for **Havemind**. Install it and enable it. It runs on
macOS, Windows, Linux, iOS and Android, and needs Obsidian 1.11.4 or newer.

**The server.** There is no Havemind cloud to sign up for: you host it, or you
join someone who does. See [Quick start](#quick-start) below.

## Quick start

Two paths, depending on whether you are the one running the server.

### You are hosting

1. **Install Tailscale** on the machine that will run the server, and log in.
   Everyone who syncs joins the same tailnet; that is the whole access
   boundary, and nothing is exposed to the public internet.
2. **Configure and start the server.** From a checkout of this repository,
   `cp deploy/.env.example deploy/.env` and set `HAVEMIND_API_BASE_URL` to the
   HTTPS tailnet URL you will use in step 3; it is baked into the server's
   discovery document, so it has to be right before the first start. Then
   `docker compose -f deploy/compose.yaml up -d --build`. You need Docker
   Engine with the Compose v2 plugin.
3. **Put Tailscale in front of it** with `tailscale serve`, so the other
   devices on your tailnet can reach it. Full commands are in the
   [self-hosting guide](docs/self-hosting.md).
4. **Create your account.** Run `setup` inside the container, once:

   ```bash
   docker compose -f deploy/compose.yaml exec havemind-server \
     node apps/server/bin/havemind.js setup --owner "Your Name" --vault "My Vault"
   ```

   It prints a single-use pairing token (`hm_pt_...`).
5. **Connect the plugin.** Open the Havemind pane in Obsidian, go to the
   Connect tab, and enter your server's tailnet address
   (`something.tailnet-name.ts.net`) together with that pairing token. The
   Status tab turns green when it is working.
6. **Invite the other person.** People tab, then Invite someone. Send them the
   invitation; it works once.
7. **Approve their device.** They read a 6-digit code aloud to you, you type
   it in. Three attempts. That handshake is what binds their identity, so do
   it by voice, never by message.

The long version, including backups and multiple vaults, is in
[docs/self-hosting.md](docs/self-hosting.md).

### You are joining someone else's vault

1. Install Tailscale, log in, and accept the invitation to their tailnet.
2. Install the Havemind plugin in Obsidian.
3. Open the invitation the owner sent you.
4. Your device shows a **6-digit code**. Read it aloud to the owner over a
   call, never in a chat message.
5. Once they approve, the vault syncs. It appears in your Obsidian like any
   other vault.

## What it does

- **Desktop and mobile, the same vault.** Havemind runs on macOS, Windows and
  Linux, and on iOS and Android through the Obsidian mobile app. The pane docks
  into the sidebar on a desktop and fills the screen on a phone, with touch
  targets and safe areas sized for it. Edit a note on your phone and it lands on
  your laptop a couple of seconds later.
- **Real-time two-way sync.** A long-poll wake channel delivers a peer's change
  to your device in roughly a second once it is sent, with a periodic poll as a
  fallback. An edit to a note waits 1.5 s to settle before it is sent, so a
  formatter plugin rewriting the file on save cannot start an edit war between
  two devices; creates, renames and deletes go out immediately. You never need
  to refresh by hand.
- **Notes and attachments.** Markdown notes sync with line-level history; images
  (PNG/JPG/GIF/WebP/SVG) and PDFs up to 25 MB sync byte-for-byte.
- **Appearance settings, from an explicit allowlist.** Theme stylesheets
  (`.obsidian/themes/`), CSS snippets, hotkeys, graph view settings (node colour
  groups included) and the `appearance.json` / `app.json` settings mirror between
  devices, so a vault looks and behaves the same everywhere. That list is the
  whole of it, nothing else under `.obsidian/` is in scope.
- **History without silent overwrites.** Non-overlapping concurrent edits merge
  automatically. When two people edit the same content, Havemind keeps both
  versions and places a conflict copy in `Havemind Conflicts/` for review.
- **Fail-closed durability.** The local queue survives crashes and corrupt
  writes: a torn state file is preserved to a sidecar and flagged for recovery
  rather than silently dropping unsent changes.
- **Authorship everywhere.** The Activity panel names who changed what, with a
  stable colour per author and one-click restore of any previous revision. The
  author travels with the revision from the server, so it is never guessed: a
  change from someone the roster does not know reads as a remote edit rather
  than the wrong name.
- **Presence roster and rejoin.** The owner sees who is connected; if a device's
  session dies, one click reconnects a known contact, no new code exchange.
- **Human-verified onboarding.** Joining a vault requires a 6-digit code shown
  only on the joining device and read aloud to the owner, who types it in
  (3 attempts). Identity is bound server-side at approval and never trusted from
  the client afterwards.
- **Several vaults on one server.** Each vault has its own owner and its own
  members, fully isolated: two teams can share one box without seeing, waking or
  writing each other's data.
- **Encrypted checkpoints and scheduled backups.** The server writes a snapshot
  on a timer (24 h by default, keeping the last 7). A checkpoint is sealed to a
  public key, so the machine that creates it cannot read it back; restoring
  needs the secret key from the owner's recovery kit.
- **Per-vault storage quota and per-device throttling**, so one runaway client
  cannot fill the disk or crowd out the others.

## What it looks like

<p align="center">
  <img src="docs/images/01-status-framed.png" alt="The Status tab on a MacBook, connected and synced" width="100%">
</p>

<p align="center">
  <img src="docs/images/03-people-framed.png" alt="The People tab listing the owner and two connected editors" width="100%">
</p>

<p align="center">
  <img src="docs/images/04-mobile-framed.png" alt="The Havemind pane filling the screen on an iPhone" width="49%">
</p>

## What it deliberately does not do

- **No Havemind-hosted cloud.** The server runs on your own hardware and is
  intended to be reachable only over your private
  [Tailscale](https://tailscale.com) network. Do not expose it to the public
  internet.
- **No plugin sync, and no device state.** `.obsidian/plugins/` is excluded in
  full, no plugin code, no plugin state, no plugin secrets (`data.json`), as
  are the enabled-plugins registry (`community-plugins.json`) and the
  per-machine window layout (`workspace.json`). No member of a vault can
  replace another member's installed plugin code, and the machines can run
  entirely different plugin sets without conflict. The allowlist is enforced at
  two independent layers, the producer guard and the wire schema, so a
  revision for an excluded path is rejected on arrival as well as at authoring
  time.
- **No server-side intelligence.** The server is an opaque, append-only relay: it
  stores content-addressed blobs and revision headers, and never computes diffs,
  merges or provenance. All of that happens in the client.

## Architecture

```
Obsidian plugin (Vault A) ─┐
                           ├── HTTPS over tailnet ──► opaque server (Fastify + SQLite)
Obsidian plugin (Vault B) ─┘   real-time /wait wake     content-addressed blob store
```

- **Plugin** (`apps/obsidian-plugin`): vault observer with per-path settling,
  durable outbox, real-time wake subscription, pull/apply loop with causal
  fast-forward detection, hash-side content canonicalization (files on disk are
  never rewritten), conflict artifacts, activity log, presence roster, rejoin
  controller, fail-closed persisted state.
- **Server** (`apps/server`): Fastify + better-sqlite3 (WAL), forward-only
  checksummed migrations, held long-poll wake endpoint, refresh-token rotation
  with reuse detection, per-device rate limiting, per-vault storage quota,
  orphaned-blob sweep at startup. Runs as a non-root, read-only, cap-dropped
  container.
- **Shared packages** (`packages/protocol`, `packages/sync-core`,
  `packages/crypto`): wire schemas (Zod), revision DAG and provenance, 3-way
  merge, payload codec (markdown + binary), canonicalization, and checkpoint
  sealing with libsodium `crypto_box_seal` (X25519). The server holds only the
  recipient public key, so it can create an encrypted checkpoint but never open
  one; the secret key lives off-server in the owner's recovery kit. Live data on
  the volume stays plaintext, and the symmetric vault-key helpers are present
  but unused (see the security model below).

## Security model

Havemind's security rests on **Tailscale**, not on application-layer encryption.
The server is reachable only over your private tailnet, never the public internet
and all traffic between devices and the server is encrypted in transit by
Tailscale (WireGuard), with per-device authentication.

Within a vault, the trust boundary between members is drawn at **code**: the
`.obsidian/` scope is an explicit allowlist of appearance settings (theme
stylesheets, CSS snippets, hotkeys, `graph.json`, `appearance.json` /
`app.json`), and
`.obsidian/plugins/` is excluded in full. Plugin code, plugin state and plugin
secrets never cross the wire, so one member cannot overwrite another member's
installed plugin and have Obsidian execute it on the next reload.

Content is stored on the server in plaintext, so **the trust boundary is the
machine you run the server on**: anyone who controls that box can read the vault.
Run it on hardware you and your circle trust, keep it tailnet-only (never enable
Tailscale Funnel), and treat server access as vault access. End-to-end encryption
is deliberately out of scope, this is a small, self-hosted, trusted-circle tool,
not a zero-trust service. Secrets never appear in the repository, logs or reports.
See [docs/pilot/known-limitations.md](docs/pilot/known-limitations.md) for current
operational caveats.

## Privacy and permission disclosures

Havemind is a sync plugin, so it needs access to the vault it connects and it
makes network requests **only after the user explicitly connects that vault to a
server**. It has no telemetry, analytics, ads, accounts operated by Havemind, or
hard-coded remote service.

- **Network use.** All requests go only to the HTTPS server URL the owner enters
  while connecting. They create and approve invitations, authenticate a device,
  send and receive encrypted-in-transit revisions and blobs, load membership
  state, and hold a long-poll request for near-real-time updates. The configured
  server stores synced vault content in plaintext; it is operated by the user,
  not by Havemind. No request is made while the plugin is disconnected.
- **Vault file enumeration.** On initial reconciliation and when resolving a
  conflict, the plugin lists vault paths to detect creates, deletions, renames
  and conflicts. It reads and syncs only supported vault content plus the
  explicit `.obsidian/` appearance-settings allowlist described above. It never
  syncs `.obsidian/plugins/`, plugin data or plugin secrets.
- **Clipboard.** The plugin only *writes* a one-time invitation when the vault
  owner presses **Copy invitation**. It never reads the system clipboard and
  never logs the invitation.
- **Base64 encoding.** Base64url is a transparent transport format for binary
  revision envelopes and invitation data. It is not encryption, obfuscation or
  a way to hide code, URLs or keys.

This disclosure is intentionally explicit because the Community directory
requires network use to be described in the README. See the
[self-hosting guide](docs/self-hosting.md) for the server trust boundary.

## Documents

- [MVP specification](specs/001-mvp.md)
- [Zero-configuration connection amendment](specs/002-public-access.md)
- [Open-source readiness amendment](specs/003-open-source-release.md)
- [Approved technical implementation plan](plans/001-technical-plan.md)
- [Historical private-pilot task matrix](plans/002-pilot-tasks.md)
- [Current limitations and operational notes](docs/pilot/known-limitations.md)
- [Closed beta programme](docs/beta/README.md)
- [Existing-solutions research](docs/research.md)

## Local verification

Requires Node.js 22 and npm 10.

```bash
npm ci
npm run verify      # what CI enforces: workspace and release checks,
                    # lint, typecheck, tests, build
npm run test:e2e    # two-device fault matrix, not part of verify
```

`npm run verify` is the single gate to run before a release. The individual
steps (`npm run build`, `npm run typecheck`, `npm run lint`, `npm test`) are
still there when you want to run just one.

Do not point a development build at an existing important vault. Use a dedicated
test vault for development and automated testing.
