# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows independent [Semantic Versioning](https://semver.org) for the plugin
and the server.

## [1.1.4] — 2026-08-18

### Changed

- Plugin description rewritten to lead with what it does, matching the
  convention of the community catalogue.

## [1.1.3] — 2026-08-18

### Fixed

- Selecting **Done** in the owner's Create-connection panel returns to the
  connection view instead of leaving the composer open. The composer takes
  render priority over the status row, so a connected vault previously showed
  no "Connected — synced" anywhere and read as if sync had dropped.

## [1.1.2] — 2026-08-18

### Fixed

- The "Self-hosting guide" link in the getting-started panel opens the guide
  instead of doing nothing. It pointed at a repo-relative path, which Obsidian
  resolved against its own internal origin rather than GitHub, so the click went
  nowhere.

### Security

- Development dependency advisories cleared (`brace-expansion`, `nanoid`,
  `postcss`). None of these ever shipped in the plugin bundle or the server
  image; the fix keeps the dependency scan clean.

### Documentation

- The changelog, README and security policy describe the shipped release. They
  had been left describing `0.9.0` across four subsequent releases, including
  claiming a supported-version range that matched no published build.

## [1.1.1] — 2026-08-13

### Added

- Graph view settings (`graph.json`) sync semantically: colour groups, filters
  and display preferences mirror between devices, while volatile view state
  (zoom, pan, node positions) stays local.

### Changed

- `.obsidian/` appearance settings resolve by last-writer-wins instead of
  producing conflict copies. Configuration is not prose; a conflict artifact
  for a settings file was noise, not safety.

## [1.1.0] — 2026-08-11

### Added

- Author overlay wired into both the editor and reading view, with a working
  settings tab.
- Command palette actions for the plugin's commands, with keyboard and
  screen-reader access.

### Fixed

- **Security:** the rejoin flow no longer treats knowledge of a
  `(membershipId, deviceId)` pair as proof of identity. Rejoining now requires
  a per-device secret verified server-side, closing a device-impersonation
  path. Devices paired before this release fail closed and must re-pair.
- Owner mutation endpoints (revoke, rejoin-grant) are rate limited.
- Vault storage accounting charges each distinct blob hash once, so a
  duplicated attachment no longer counts repeatedly against the quota.
- Status semantics are honest: retrying and deferred states are distinct,
  timestamps are human-readable, and synced appearance changes apply
  immediately.
- Skipped files are named with their reason in the console behind the
  reconcile summary notice, instead of a vague "markdown only".

### Security

- Home LAN addresses redacted from the public tree; the privacy scan widened to
  cover RFC1918 `192.168.x.x` ranges, not only Tailscale CGNAT.

## [1.0.1] — 2026-08-08

### Fixed

- The plugin no longer detaches its own leaves in `onunload`, per the Obsidian
  community catalogue guidelines.

## [1.0.0] — 2026-08-08

First stable release. The seven-day pilot closed on 2026-08-07 with zero data
loss across real two-device use from 2026-07-25.

> **Still disposable vaults only.** Content is stored on the server in
> plaintext; the trust boundary is the machine running the server. End-to-end
> encryption remains out of scope — see the README security model.

### Added

- Scheduled server backups with a restic pipeline and a verified restore drill
  (the explicit gate for tagging 1.0).
- `.obsidian/` configuration mirroring across devices via adapter polling,
  scoped to an explicit appearance allowlist.
- Multi-vault isolation: vault-scoped bootstrap selection, device revocation,
  and rejoin-grant device binding scoped to the grant's own vault.
- Corrupt pairing state is detected at connect and offers a reset instead of
  failing opaquely.

### Fixed

- **Breaking:** configuration sync is an explicit appearance allowlist. Plugin
  code never syncs under any circumstance — `.obsidian/plugins/` is excluded in
  full, enforced at two independent layers.
- Backup integrity is verified (`PRAGMA integrity_check`) and prune verifies
  all retained snapshots; unsafe backup ids are rejected.
- Repeated configuration-poll failures surface via a throttled notice rather
  than failing silently.

### Security

- CI scrubs private infrastructure values, gates releases, and pins actions.
- Dependency advisories for `fast-uri` and `find-my-way` patched.

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
