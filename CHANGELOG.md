# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows independent [Semantic Versioning](https://semver.org) for the plugin
and the server.

## [1.5.9], 2026-10-06

### Fixed

- Plugin: when the server had already accepted the same merge from another
  device, the plugin kept a full copy of the note in its sync state forever,
  and that file is rewritten on every save, phones included. It no longer
  keeps that copy, and copies made by a recovery are dropped after 7 days.
  On one device the file shrinks from about 577 KB to about 110 KB as the
  old copies age out.

## [1.5.8], 2026-09-30

### Fixed

- Plugin: a change queued while the plugin was still starting up could drop
  out of the queue, so that edit never reached the server.
- Plugin: an attachment deleted on another device is now deleted here too.
  It used to stay, with an empty conflict copy next to it.
- Plugin: a server whose responses carry fields this version does not know no
  longer stops a device from joining.
- Plugin: stored copies of queued changes no longer pile up in the device's
  local database, and Reset connection deletes the database it leaves behind.

### Changed

- Plugin: opening the app no longer reads and hashes every file. A file whose
  size and modification time match what the last start saw is skipped.
- Plugin: each change carries a note's text once instead of twice, so an edit
  uploads and stores half as much, and notes of roughly 250 to 490 KiB that
  were refused as too large now sync. Merges keep the old form, so devices on
  older versions still recognise the same merge made on both sides.
- Plugin: sending and receiving a large attachment takes about a third of the
  time and a fraction of the memory it did (a 25 MiB file: about 3 s instead of
  9 to 12 s, measured on a computer).
- Server: `HAVEMIND_TRUSTED_PROXIES` (empty by default) names the proxy in
  front of the server, such as `tailscale serve`, so each client gets its own
  pre-login rate limit instead of all of them sharing one.
- Which paths sync is decided in one place, the protocol package, so the
  plugin can no longer queue a path the server would refuse.
- Plugin (internal): notes and attachments share one apply flow, `main.ts` is
  split into modules, the longest files carry half the comment lines, and
  duplicated helpers, eight-parameter functions and an apply branch that
  never ran are gone.

## [1.5.7], 2026-09-29

### Fixed

- Plugin: an incoming change this device cannot apply (like the PDF iOS
  refused to read on 26 September) no longer stops the whole vault. After
  three tries it is set aside, listed in the pane with its reason and Retry
  and Discard, and everything else keeps syncing.

### Changed

- Plugin: Restore in the Activity feed now really restores. It fetches the
  note's text from that revision in the server history and writes it as a
  normal edit. It used to add a feed entry only.
- Plugin: the status bar names who last edited the open note, from the
  author the server stamps on each revision, so it survives a restart.
- Plugin: People no longer shows an invented connected/disconnected state;
  Rejoin is offered on every other member. The owner can reject a waiting
  device.

### Removed

- Server: encrypted checkpoints (`havemind checkpoint`, plans/006) and the
  `@havemind/crypto` package with its libsodium dependency. They were never
  enabled in production; backups stay plaintext on the host and are encrypted
  off it by restic, as the docs now say.
- sync-core: the revision DAG and recipe modules the old Restore used.
- Plugin: two one-time data migrations. The July canonicalization rebase
  predates the public release; the September mapping compaction now happens
  on the next ordinary save of the producer state.
- Plugin: the author overlay and its Show authors toggle. It coloured a whole
  note by an in-memory entry lost on restart; the status-bar label replaces
  it. sync-core's provenance module went with it.

## [1.5.6], 2026-09-29

### Fixed

- Plugin: conflict resolution never loses both versions or locks a copy, and
  the automatic sweep never overwrites a note edited mid-merge or a
  same-named note of a different file.
- Plugin: the panel says why a sync failed; Sync now and Retry run one cycle
  instead of rebuilding the connection, and never show Synced over a refused
  session.
- Plugin: one quarantined change no longer blocks every later edit of that
  file, a full vault quota no longer quarantines the whole queue, and Retry
  never silently drops a change whose queued copy was lost.
- Plugin: a failing upload no longer stops the device receiving changes, and
  instant updates keep arriving while an apply waits on an unsaved editor.
- Plugin: Reset connection asks first; Disconnect and Reset are not undone by
  a connection still being built.
- Plugin: a rejected guest is no longer stuck failing every start, a
  case-only name collision no longer stops the whole vault, and a guest
  device stops getting 403 and 401 at every start.
- Plugin: a half-typed approval code survives a repaint, and a huge
  conflict diff no longer exhausts memory.
- Server: a device that keeps syncing stays signed in; the session deadline
  slides on every refresh instead of ending 30 days after pairing.
- Server: attachments up to the advertised 25 MiB are accepted, and a slow
  upload is no longer cut off after 60 to 90 seconds.
- Server: a replayed old refresh token still burns its session, junk
  pre-auth traffic can no longer starve token refresh, `cleanup-stale` keeps
  onboardings in progress, and backup intervals above 596 hours no longer
  run back to back.

### Changed

- Plugin: faster and lighter on phones. data.json is read once instead of
  on every access, no longer holds the text of every note, and a sync-state
  save is one write; a remote change costs fewer writes; `.obsidian` is
  polled every 30 s and only changed files are read; the author overlay
  costs nothing while off; a new connection reads only the revision history
  it lacks; obsolete revisions are skipped before download; attachments are
  no longer kept in memory.
- Server: expired tokens and idempotency records are pruned hourly, each
  pushed payload is hashed once, and backups hard-link unchanged blobs
  instead of copying them again.

- README: no longer claims line-level history or live presence, and says
  which file types are not synced.

### Removed

- The unused database key (`HAVEMIND_DB_KEY_FILE`, `generate-db-key`); the
  live database was never encrypted with it, and the docs now say so.
- Dead code: the unscheduled end-to-end encryption module, unused sync-core
  modules, the old server invitation path, the plugin's second secret store
  and IndexedDB queue, the join-time bootstrap phase in the plugin, and the
  unregistered Activity view.

## [1.5.5], 2026-09-26

### Fixed

- Mobile devices stopped receiving updates at the first changed attachment.
  Before applying a remote change the plugin read the file on disk as text to
  check for unsaved edits, even when no editor had it open. iOS refuses to read
  a PDF as text, so every sync cycle failed there and the device stayed offline.
  The disk is now read only when an editor has the file open.

## [1.5.4], 2026-09-26

### Fixed

- A connected device no longer downloads every file in the vault each time
  Obsidian starts. The startup identity check fetched the full contents of all
  files, PDFs included, before the first pull; on a phone that restarted
  before it finished, updates from other devices never arrived. The check now
  downloads nothing unless the vault holds a local file sync does not know yet.

### Changed

- The release script publishes the full README to the distribution
  repository instead of replacing it with the short plugin README.

## [1.5.3], 2026-09-25

### Changed

- The test suite runs about 17 seconds faster. Three slow tests now prove the
  same behaviour with less work: the refresh-token replay cases are listed
  explicitly instead of sampled 1000 times, the binary payload ceiling is
  checked with a 1 MiB attachment plus an explicit bound for the 25 MB file
  cap, and the 1.5 MB encryption round trip no longer fills its payload
  through libsodium's slow random generator. No change to plugin or server
  behaviour.

## [1.5.2], 2026-09-22

### Changed

- Installation and update guidance now consistently directs users to the
  Obsidian Community directory. The plugin no longer documents BRAT as a
  distribution path.

## [1.4.10], 2026-09-14

### Fixed

- The adjacent-line merge shipped in 1.4.9 could drop a line. It checked
  whether the other side had touched the line the walk was standing on, but not
  the rest of the span a multi-line change covers, so a change overlapping on
  its second line passed the check and was then skipped over. CI's property
  battery found it after 437 random cases, having lost the text "foo" from
  ancestor "b\n", local "# h\n- a", remote "b\nfoo". Overlap is now tested
  across the whole span, and such a region falls back to a conflict copy.

## [1.4.9], 2026-09-14

### Fixed

- Two people editing neighbouring lines no longer produce a conflict copy. The
  merge groups changes that sit within one unchanged line of each other into a
  single region, and any region both sides had touched failed outright, even
  when each individual line had been rewritten by only one of them. That is the
  commonest shape of a shared vault: consecutive table rows, list items, or a
  heading and the paragraph under it. Such a region is now resolved line by
  line, and only a line claimed by both sides still becomes a conflict copy.

  The recovery is deliberately narrow. It applies when every change in the
  region replaces ancestor lines one for one; an insertion, a deletion, or a
  change in line count still falls back to a conflict copy, because line
  ownership alone cannot say where the new text belongs. A deletion next to
  someone else's edit stays a conflict for the same reason: combining them
  would silently drop a line the other person was working around, and nothing
  in the text says whether they meant to keep it.

## [1.4.8], 2026-09-11

### Fixed

- A remote delete could take an unsent local edit with it. The delete path
  checked only that the revision owned the file, never that the copy on disk
  still matched the last synced version, so a note edited while Obsidian was
  closed could be removed with no conflict copy left behind. It now compares
  the content first and writes a conflict copy when they differ, the same
  guard the rename path already had.
- Renaming onto an occupied path destroyed the original. The destination was
  checked only after the source had been deleted, so the operation correctly
  reported a conflict while the file the user had been working on was already
  gone. The check now runs first.
- The two choice cards on the disconnected screen overlapped, the second
  sitting on top of the first card's description, with text running past the
  pane edge.

### Added

- The People tab reads the member list from the server, so everyone in a vault
  sees the same people. An offline device keeps showing the list it last knew
  rather than emptying the panel.
- Activity names the author of a remote change. The author travels with the
  revision from the server, so it is never inferred: a change from someone the
  roster does not know reads as a remote edit rather than the wrong name.

## [1.4.7], 2026-09-05

### Fixed

- A request could hang indefinitely. Every outgoing call is now bounded by a
  timeout, so a stalled network leaves the pane responsive instead of pinned on
  a spinner that never resolves.

## [1.4.6], 2026-09-05

### Fixed

- A tap could leave the pane looking unchanged until the next repaint. Every
  tap path now repaints immediately.

## [1.4.5], 2026-09-04

### Performance

- Only the activity rows that will actually be drawn are formatted, so a long
  history no longer costs work nobody sees.

## [1.4.4], 2026-09-04

### Performance

- The rendered activity list is capped, bounding the work a busy vault can put
  on a phone.

## [1.4.3], 2026-09-04

### Performance

- Base64 encoding runs in chunks rather than byte by byte, which is what made
  attachment sync slow on mobile.

## [1.4.2], 2026-09-04

### Performance

- The conflict scan is cached between vault changes, and repaints are coalesced
  while taps stay immediate.

## [1.4.1], 2026-09-04

### Fixed

- The scroll rule no longer depends on `:has()`, which older mobile webviews do
  not support; it uses a class instead.

## [1.4.0], 2026-09-04, Mobile support

### Added

- Mobile support: the pane fills the screen on a phone, with touch targets and
  safe areas sized for it (`isDesktopOnly: false`).

### Fixed

- Migration comments restored and applied checksums frozen on the server.

### Internal

- The plugin UI reached its 250-line-per-module ceiling, closing UI-03.

## [1.3.0], 2026-09-03

### Added

- The push channel resumes when the app returns to the foreground, so a phone
  that was backgrounded picks changes straight back up.

## [1.2.3], 2026-08-31

### Fixed

- Unloading or reloading the plugin cancels the work still in flight. A sync
  retry timer scheduled moments earlier could fire after unload, and a
  connection attempt awaiting onboarding I/O ran to completion regardless of
  whether the plugin was still there to receive it. Retry timers are now
  cancellable and released on teardown, and the connect drive takes an
  `AbortSignal` that `onunload` and `disconnect` both trigger.

### Internal

- The generated plugin class list no longer collects CSS custom properties.
  `list-plugin-classes.mjs` greps identifier-shaped strings, so
  `--havemind-first-run-pad` read as a class the moment a test named it, and
  eleven tokens had already entered the list the same way. The list feeds
  `stylesheet-conflicts.test.ts`, whose whole job is to fail on a rule for a
  class nothing renders, so padding it with tokens weakened that check.

## [1.2.2], 2026-08-31

### Fixed

- The first-run screens no longer run into the edges of the pane. The chooser
  and the host path mount their blocks directly on the view, which had given up
  its own padding so the header could span the pane, so the heading, subheading,
  option rows and the self-hosting link sat flush against the frame while the
  hints between them stayed inset, leaving the text on two left edges in a 300px
  sidebar.
- The first-run screens can be scrolled. Scrolling and the 16px of air below the
  last line come from the tab body on every connected screen, and these screens
  render none, so in a pane shorter than its content the overflow could not be
  reached at all and the host path's "I've done this, connect" button was out of
  reach.

### Added

- A browser preview of the first-run screens (`npm run dev:preview`), which
  renders the shipping section renderers and stylesheet outside Obsidian so
  width- and height-dependent layout defects are visible before release.

## [1.2.1], 2026-08-27

### Fixed

- The panel's keyboard listener is removed when the plugin unloads.
- Release metadata is checked before publishing, preventing a mismatch between
  the plugin package, the manifests and `versions.json`.
- The local test deployment builds once, installs the same artefacts into both
  test vaults and verifies their hashes.

## [1.2.0], 2026-08-24, Panel Redesign & Connection Reliability

### Added

- Redesigned Havemind sidebar with Status, Activity, People, and Connect tabs;
  the Connect tab brings sync, recovery, server, and disconnect controls into
  one place.
- Owner invitation composer has an explicit Close action, so it never traps the
  user in the create-connection screen.

### Fixed

- The sidebar tab uses the Havemind hexagon in Obsidian's top bar.
- Server context appears after the overflow-menu actions rather than splitting
  them.
- Copy invitation confirms success only after clipboard access succeeds and
  provides a manual-copy fallback when it does not.
- Unexpected connect-flow errors are reported in the panel rather than leaving
  an unhandled asynchronous error.

## [1.1.8], 2026-08-20

### Added

- The distribution repository now attests its own release artifacts. The
  monorepo already attested the same bundle, but that attestation is recorded
  against the monorepo, someone installing from the distribution repo could
  not verify it there. The release people actually install is now attested
  against the repository it is served from.

## [1.1.7], 2026-08-18

### Added

- First release built and attested by the release workflow, so `main.js` and
  `styles.css` carry verifiable build provenance.

## [1.1.6], 2026-08-18

### Added

- Release artifacts carry GitHub build-provenance attestations, so `main.js`
  and `styles.css` can be verified as built by CI from this repository. Closes
  the gap where a release was trusted on account control alone.

### Documentation

- README states what the plugin accesses and why: vault-wide path enumeration
  (needed to pair files with revisions and detect renames) and clipboard writes
  (the invitation Copy button; the clipboard is never read).

## [1.1.5], 2026-08-18

### Fixed

- The "Self-hosting guide" link actually opens the guide. 1.1.2 corrected the
  URL but the link stayed inert: a bare `<a href>` inside a plugin view does not
  reliably reach the browser. It now opens the URL explicitly and carries
  Obsidian's `external-link` class. Covered by a test that asserts the click
  behaviour, not just the URL value.

## [1.1.4], 2026-08-18

### Changed

- Plugin description rewritten to lead with what it does, matching the
  convention of the community catalogue.

## [1.1.3], 2026-08-18

### Fixed

- Selecting **Done** in the owner's Create-connection panel returns to the
  connection view instead of leaving the composer open. The composer takes
  render priority over the status row, so a connected vault previously showed
  no "Connected, synced" anywhere and read as if sync had dropped.

## [1.1.2], 2026-08-18

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

## [1.1.1], 2026-08-13

### Added

- Graph view settings (`graph.json`) sync semantically: colour groups, filters
  and display preferences mirror between devices, while volatile view state
  (zoom, pan, node positions) stays local.

### Changed

- `.obsidian/` appearance settings resolve by last-writer-wins instead of
  producing conflict copies. Configuration is not prose; a conflict artifact
  for a settings file was noise, not safety.

## [1.1.0], 2026-08-11

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

## [1.0.1], 2026-08-08

### Fixed

- The plugin no longer detaches its own leaves in `onunload`, per the Obsidian
  community catalogue guidelines.

## [1.0.0], 2026-08-08

First stable release. The seven-day pilot closed on 2026-08-07 with zero data
loss across real two-device use from 2026-07-25.

> **Still disposable vaults only.** Content is stored on the server in
> plaintext; the trust boundary is the machine running the server. End-to-end
> encryption remains out of scope, see the README security model.

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
  code never syncs under any circumstance, `.obsidian/plugins/` is excluded in
  full, enforced at two independent layers.
- Backup integrity is verified (`PRAGMA integrity_check`) and prune verifies
  all retained snapshots; unsafe backup ids are rejected.
- Repeated configuration-poll failures surface via a throttled notice rather
  than failing silently.

### Security

- CI scrubs private infrastructure values, gates releases, and pins actions.
- Dependency advisories for `fast-uri` and `find-my-way` patched.

## [0.9.0], 2026-07-24

First feature-complete build for the two-person technical alpha. Distributed as
a three-file Obsidian artifact (`main.js`, `manifest.json`, `styles.css`) via
GitHub Releases.

> **Alpha, disposable vaults only.** The pilot payload format is plaintext and
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
