# Havemind

Havemind is a private, self-hosted sync layer for [Obsidian](https://obsidian.md),
built for exactly two people sharing one vault. Each person keeps a normal local
vault; a small server on their own hardware relays revisions between devices and
records who changed what — without ever seeing more than it needs to.

**Version 0.9.0 — release candidate.** Feature-complete for the two-person
pilot; undergoing a 7-day live trial before 1.0.

## What it does

- **Two-way sync of notes and attachments.** Markdown notes sync with
  line-level history; images (PNG/JPG/GIF/WebP/SVG) and PDFs up to 25 MB sync
  byte-for-byte.
- **Append-only history — zero silent overwrites.** A concurrent edit never
  destroys the other person's work: the diverged version lands as a conflict
  copy under `Havemind Conflicts/`, both versions preserved, always.
- **Authorship everywhere.** The Activity panel shows who changed what, with a
  stable colour per author and one-click restore of any previous revision of a
  note.
- **Presence roster.** The vault owner sees who is connected (name + green
  dot); a connection persists until explicitly broken.
- **Rejoin without re-pairing.** If a device's session dies, the owner clicks
  *Rejoin* and the known contact reconnects automatically — no new code
  exchange.
- **Human-verified onboarding.** Joining a vault requires a 6-digit code shown
  only on the joining device and read aloud to the owner, who types it in
  (3 attempts). Identity is bound server-side at approval and never trusted
  from the client afterwards.

## What it deliberately does not do

- **No cloud.** The server runs on the owners' own hardware, reachable only
  over their private [Tailscale](https://tailscale.com) network. Nothing is
  ever published to the internet.
- **No config sync.** `.obsidian/`, plugin settings and device state are
  excluded by two independent guard layers — the two machines can run entirely
  different plugin sets without conflict.
- **No server-side intelligence.** The server is an opaque, append-only relay:
  it stores content-addressed blobs and revision headers, and never computes
  diffs, merges or provenance. All of that happens in the client.

## Architecture

```
Obsidian plugin (Vault A) ─┐
                           ├── HTTPS over tailnet ──► opaque server (Fastify + SQLite)
Obsidian plugin (Vault B) ─┘                          content-addressed blob store
```

- **Plugin** (`apps/obsidian-plugin`): vault observer with per-path settling,
  durable outbox, pull/apply loop with causal fast-forward detection,
  hash-side content canonicalization (files on disk are never rewritten),
  conflict artifacts, activity log, presence roster, rejoin controller.
- **Server** (`apps/server`): Fastify + better-sqlite3 (WAL), forward-only
  checksummed migrations, refresh-token rotation with reuse detection,
  per-device rate limiting, orphaned-blob sweep at startup. Runs as a
  non-root, read-only, cap-dropped container.
- **Shared packages** (`packages/protocol`, `packages/sync-core`): wire
  schemas (Zod), revision DAG and provenance, payload codec (markdown +
  binary), canonicalization.

## Security model (pilot)

The current pilot payload format is intentionally plaintext over the tailnet.
End-to-end encryption is a hard gate before any real vault is connected; the
disposable plaintext pilot will never be upgraded in place. Secrets never
appear in the repository, logs or reports. See
[docs/pilot/known-limitations.md](docs/pilot/known-limitations.md) for current
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
npm test            # 870+ unit/integration tests
npm run test:e2e    # two-device fault matrix
```

Do not point the development plugin at an existing Obsidian vault — the pilot
uses dedicated disposable vaults.
