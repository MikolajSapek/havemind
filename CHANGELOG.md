# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows independent [Semantic Versioning](https://semver.org) for the plugin
and the server.

## [0.9.0] — 2026-07-24

First feature-complete build for the two-person technical alpha. Distributed as
a three-file Obsidian artifact (`main.js`, `manifest.json`, `styles.css`) via
GitHub Releases and BRAT.

> **Alpha — disposable vaults only.** The pilot payload format is plaintext and
> has no end-to-end encryption. Do not connect a vault with real or sensitive
> notes.

### Added

- Two-way sync of Markdown notes with line-level history, and of image
  attachments (PNG/JPG/GIF/WebP/SVG) and PDFs up to 25 MB, synced byte-for-byte.
- Append-only history with zero silent overwrites: concurrent edits land as
  conflict copies under `Havemind Conflicts/`, both versions preserved.
- Authorship throughout: an Activity panel showing who changed what, a stable
  colour per author, and one-click restore of any previous revision.
- Presence roster so the vault owner sees who is connected.
- Rejoin without re-pairing when a device session drops.
- Human-verified onboarding via a 6-digit code, with identity bound
  server-side at approval and never trusted from the client afterwards.
- Opaque, append-only server (Fastify + SQLite): content-addressed blob store,
  forward-only checksummed migrations, refresh-token rotation with reuse
  detection, and per-device rate limiting.

### Notes

- `.obsidian/` and Havemind's own device state are excluded from sync by two
  independent guard layers.
- End-to-end encryption is a hard gate before any real vault is connected; the
  disposable plaintext pilot will not be upgraded in place.
