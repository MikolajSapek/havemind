<p align="center">
  <img src="design/brand/havemind-banner-white.png" alt="Havemind — one shared brain for your team and their AIs" width="100%">
</p>

# Havemind

### The living knowledge base your team and your agents both write to.

Havemind is a private, self-hosted, **real-time** sync layer for
[Obsidian](https://obsidian.md), built for a small trusted circle — two or three
people sharing one vault. Everyone keeps a normal local vault; a small server on
your own hardware relays revisions between devices in about a second and records
who changed what — without ever seeing more than it needs to.

**It's not just for people — it's for your agents too.** Point Claude and your
AI tools (MCP, the Obsidian tools, your own agents) at the same shared vault, and
every human and every agent works from one continuously-synced brain. You write,
your Claude writes, their Claude writes — Havemind keeps it one coherent
knowledge base, live, with full authorship and zero silent overwrites.

**Version 0.9.0 — release candidate.** Feature-complete and hardened; in a 7-day
live trial before 1.0.

**Self-hosting your own instance?** See
[docs/self-hosting.md](docs/self-hosting.md) for the full zero-to-working
guide (Docker Compose + Tailscale, tailnet-only).

## What it does

- **Real-time two-way sync (~1 second).** A long-poll wake channel pushes a
  peer's change to your device in roughly a second, with a periodic poll as a
  fallback — no manual refresh, no waiting.
- **Notes and attachments.** Markdown notes sync with line-level history; images
  (PNG/JPG/GIF/WebP/SVG) and PDFs up to 25 MB sync byte-for-byte.
- **Append-only history — zero silent overwrites.** A concurrent edit never
  destroys the other person's work. Non-overlapping edits merge automatically
  (3-way merge over a common ancestor); a genuine clash lands as a conflict copy
  under `Havemind Conflicts/`, both versions preserved, always.
- **Fail-closed durability.** The local queue survives crashes and corrupt
  writes: a torn state file is preserved to a sidecar and flagged for recovery
  rather than silently dropping unsent changes.
- **Authorship everywhere.** The Activity panel shows who changed what, with a
  stable colour per author and one-click restore of any previous revision.
- **Presence roster and rejoin.** The owner sees who is connected; if a device's
  session dies, one click reconnects a known contact — no new code exchange.
- **Human-verified onboarding.** Joining a vault requires a 6-digit code shown
  only on the joining device and read aloud to the owner, who types it in
  (3 attempts). Identity is bound server-side at approval and never trusted from
  the client afterwards.

## What it deliberately does not do

- **No cloud.** The server runs on your own hardware, reachable only over your
  private [Tailscale](https://tailscale.com) network. Nothing is ever published
  to the internet.
- **No config sync.** `.obsidian/`, plugin settings and device state are
  excluded by two independent guard layers — the machines can run entirely
  different plugin sets without conflict.
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
  primitives (present but unused — security is Tailscale-only, see below).

## Security model

Havemind's security rests on **Tailscale**, not on application-layer encryption.
The server is reachable only over your private tailnet — never the public internet
— and all traffic between devices and the server is encrypted in transit by
Tailscale (WireGuard), with per-device authentication.

Content is stored on the server in plaintext, so **the trust boundary is the
machine you run the server on**: anyone who controls that box can read the vault.
Run it on hardware you and your circle trust, keep it tailnet-only (never enable
Tailscale Funnel), and treat server access as vault access. End-to-end encryption
is deliberately out of scope — this is a small, self-hosted, trusted-circle tool,
not a zero-trust service. Secrets never appear in the repository, logs or reports.
See [docs/pilot/known-limitations.md](docs/pilot/known-limitations.md) for current
operational caveats.

## Documents

- [MVP specification](specs/001-mvp.md)
- [Zero-configuration connection amendment](specs/002-public-access.md)
- [Open-source readiness amendment](specs/003-open-source-release.md)
- [Approved technical implementation plan](plans/001-technical-plan.md)
- [Private-pilot task matrix](plans/002-pilot-tasks.md)
- [Known limitations (pilot)](docs/pilot/known-limitations.md)
- [Existing-solutions research](docs/research.md)

## Local verification

Requires Node.js 22 and npm 10.

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test            # 1200+ unit/integration tests
npm run test:e2e    # two-device fault matrix
```

Do not point the development plugin at an existing Obsidian vault — the pilot
uses dedicated disposable vaults.
