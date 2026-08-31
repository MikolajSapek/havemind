<p align="center">
  <img src="design/brand/havemind-banner-white.png" alt="Havemind, a shared Obsidian vault for people you trust" width="100%">
</p>

# Havemind

### Share one Obsidian vault with people you trust.

Havemind is private, self-hosted sync for [Obsidian](https://obsidian.md). It is
built for two or three people sharing one vault: each person keeps a normal local
copy while a server you control relays changes, keeps history, and records who
changed what.

Use it with people first. If you choose to use Claude, MCP, or another local
agent in that vault, Havemind keeps those changes in the same history too.

**Version 1.2.3, clean teardown.** A seven-day,
two-device pilot completed without data loss. Havemind does not provide
end-to-end encryption: the self-hosted server stores synced content in plaintext.
Read the [security model](#security-model) before connecting a vault you care
about.

**Self-hosting your own instance?** See
[docs/self-hosting.md](docs/self-hosting.md) for the full zero-to-working
guide (Docker Compose + Tailscale, tailnet-only).

**Connecting Claude or an AI agent?** See
[docs/using-with-ai-agents.md](docs/using-with-ai-agents.md) for the
requirements and the steps.

## What it does

- **Real-time two-way sync (~1 second).** A long-poll wake channel pushes a
  peer's change to your device in roughly a second, with a periodic poll as a
  fallback. You do not need to manually refresh.
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
- **Authorship everywhere.** The Activity panel shows who changed what, with a
  stable colour per author and one-click restore of any previous revision.
- **Presence roster and rejoin.** The owner sees who is connected; if a device's
  session dies, one click reconnects a known contact, no new code exchange.
- **Human-verified onboarding.** Joining a vault requires a 6-digit code shown
  only on the joining device and read aloud to the owner, who types it in
  (3 attempts). Identity is bound server-side at approval and never trusted from
  the client afterwards.

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
  merge, payload codec (markdown + binary), canonicalization, and crypto
  primitives (present but unused, security is Tailscale-only, see below).

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
npm run build
npm run typecheck
npm run lint
npm test            # unit and integration tests
npm run test:e2e    # two-device fault matrix
```

Do not point a development build at an existing important vault. Use a dedicated
test vault for development and automated testing.
