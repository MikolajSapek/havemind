# 11, BACKLOG.md

Ordering rule: F0→F9 strictly sequential; SRV-* runs in parallel from F0, but SRV-03/04/05
are a hard blocker for F8 (see `09-pilotaz-i-decyzje.md`). Labels: `server`, `plugin`,
`sapserver`, `security`, `user-decision`. Milestones = phases (F0…F9, SRV). Checkboxes in this
file are the source of truth for progress, the subagent checks one off only after the AC passes,
not before.

**Phase Definition of Done** (added on top of the sum of the phase's issue ACs): `npm run build && npm
run lint && npm test` green for the whole workspace; 80%+ coverage threshold maintained; one entry
in the phase report (what works, what's deferred, evidence).

## F0, Foundation

- [x] **F0-01** `foundation` Configure strict TS/lint/Vitest across the whole workspace (T002)
  - AC: `npm run typecheck && npm run lint && npm test` green for all packages
    (functional); 80% coverage threshold enforced in configuration, not only described in CI
    (qualitative, method: `npm run test:coverage` reports the threshold from configuration); no
    existing test T004-T017 stops passing (regression).
  - AC negative: no `any` without an explicit justifying comment in newly touched files.
  - Files: `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `scripts/check-workspace.mjs`.
  - Evidence (2026-07-16): typecheck + lint + test green (279 pass / 3 skipped, approved
    F3-01 quarantine, see DECISIONS.md); `npm run test:coverage` exit 0, statements 84.75%,
    branches 80.22%, functions 88.99%, lines 85.41%, 80% threshold enforced in `vitest.config.ts`;
    zero regression on T004-T017; no `any` (`no-explicit-any` = error passes cleanly).

- [x] **F0-02** `foundation` Verify canonical data without duplication
  - AC: grep of the `plan/` package for phrases copied 1:1 from `specs/*.md`/`plans/*.md` longer than
    one sentence → 0 hits (functional, method: manual review + grep).
  - AC: table from `02-fundamenty.md` verified, every referenced file exists (curl/cat
    the path).
  - Evidence (2026-07-16): sentence-level diff plan/*.md vs specs/*.md+plans/*.md → 0 duplicated
    sentences (≥12 words); 6/6 repo files exist; Sapserver note confirmed to exist as
    the operator's private setup note (outside this repo).

## F1, Cross-cutting systems

- [x] **F1-01** `server,security` Token and rotation primitives (T018)
  - Evidence (2026-07-16): auth suite 4 files / 38 tests green; fast-check property numRuns=1000
    (replay → wasRetry, divergence → REFRESH_REUSE_DETECTED + family revocation); coverage-final.json
    confirms both branch directions of revocation (L528 stale-generation [1,1009], L535 hash collision
    [1,1008]); grep console.* in src/auth → 0; .todo-F1-01 files restored and green; workspace
    stmts 90.67 / branch 85.17 / funcs 93.43 / lines 91.52.
  - AC: `npm test --workspace @havemind/server -- auth` green (functional).
  - AC: retry with the same `rotation_id` succeeds, reuse with a different one → family revocation
    (functional, method: property test with ≥1000 random combinations from `03-systemy-przekrojowe.md`).
  - AC: 100% branch coverage on the revocation path (qualitative, method: coverage report).
  - AC negative: no raw token ever reaches the logs (grep test fixtures for `console.log`
    with a token in plaintext).
  - AC (F0-01 quarantine): restore `apps/server/src/auth/{setup,session-repository}.test.ts.todo-F1-01`
    (rename back to `.test.ts`) and bring to green, see DECISIONS.md 2026-07-16.

## F2, Skeleton (server + plugin vertical slice)

- [x] **F2-01** `server` Invitations and device approval (T019)
  - Evidence (2026-07-16): invitations.test.ts 17/17 green, 256-bit token (32B), only SHA-256
    stored in DB, TTL 900s; >15 min → 410 + burn + retry 409; phrase mismatch/reject → device removed,
    zero token issued; second redeem → 409, 1 pending device; workspace 313 pass / 3 skipped,
    coverage branch 84.56%.
  - AC: 256-bit/15-min/single-use invitation, race-safe verification phrase (functional,
    `npm test --workspace @havemind/server -- invitations`).
  - AC: redeem with an invitation older than 15 min → `410 Gone`, invitation marked used,
    no retry (functional, row 2 of the table in `04-serwer-auth-i-api.md`).
  - AC: owner rejects the phrase or the phrase doesn't match → pending device removed, zero token
    issued (functional, row 4 of the table in `04`).
  - AC negative: redeeming the same token a second time → `409`, no second pending device.

- [x] **F2-02** `server,security` Deny-by-default auth-routes (T020)
  - Evidence (2026-07-16): auth-routes.test.ts 10/10, cross-vault IDOR 403 with no leak; spoofed
    actor-id header 403 + log without the header value; nonexistent vs. no-access identical
    byte-for-byte; 429 before auth with no account info. Workspace 323 pass / 3 skipped, branch 84.66%.
  - AC: cross-vault IDOR attempt → `403` with no leak of resource existence (functional + regression
    against the event table in `04-serwer-auth-i-api.md`).
  - AC: a header spoofing a different `actor_id` → `403`, the log doesn't contain the header content
    in plaintext (functional + security, method: grep test logs for the header value).
  - AC: "vault does not exist" and "vault exists without access" return an identical status code/response
    shape (functional, method: byte-for-byte comparison of the two responses outside the error body).
  - AC: a request before authentication after exceeding the rate limit → `429` with no information about
    account existence (functional).
  - AC: `npm test --workspace @havemind/server -- auth-routes` green.

- [x] **F2-03** `server` Sync push/pull API (T021)
  - Evidence (2026-07-16): sync-routes.test.ts 15/15, a cycle in parent_revision_ids → 422 before
    any write (pre-flight Kahn); replay of identical bytes → 200 replayed with the same
    receipt; different bytes → 409 REVISION_ID_REUSE; cursor-based pull + byte-exact blob; server
    stays opaque (payload as bytes). Workspace 338 pass, branch 84.33%.
  - AC: a batch with a cycle in `parent_revision_ids` → `422`, whole batch rejected (functional).
  - AC: identical `revision_id` + identical bytes → the original result; different bytes → `409`
    (functional, `npm test --workspace @havemind/server -- sync-routes`).

- [x] **F2-04** `plugin` Vault-adapter and reconciliation (T026)
  - Evidence (2026-07-16): vault-adapter + reconciliation 11/11, dedup by SHA-256 (a modify with the
    same hash → null), rename preserves fileId; classifyVaultPath rejects `.obsidian/**`,
    `.trash`, `Havemind Conflicts` (reconciliation ignored:2, zero commits); .todo-F2-04
    files restored and green; workspace 349 pass / 3 skipped, branch 84.53%.
  - AC: create/modify/rename/delete deduplicated by hash (functional).
  - AC negative: `.obsidian/**` never reaches the outbox (`npm test --workspace
    @havemind/obsidian-plugin -- vault-adapter`).
  - AC (F0-01 quarantine): restore `src/obsidian/vault-adapter.test.ts.todo-F2-04` and
    `src/sync/reconciliation.test.ts.todo-F2-04` (rename to `.test.ts`) and bring to green.

## F3, Onboarding (first value for the user: being able to connect)

- [x] **F3-01** `plugin,security` Secure invitation onboarding (T025)
  - Evidence (2026-07-16): the havemind-join handler accepts only {action}, it.each tests for
    token/envelope/secret/harmless → no view, requestCalls=0; onboarding resume() green;
    no merge logic on the onboarding path (grep); F3-01 quarantine lifted, lifecycle 11/11
    (RED 3 failed → GREEN); workspace coverage branch 84.62%.
  - AC: the invitation secret is never in the `obsidian://havemind-join` query string (functional,
    method: grep the wizard code + integration test checking the URL).
  - AC: resumable bootstrap after interruption (functional, `npm test --workspace
    @havemind/obsidian-plugin -- onboarding`).
  - AC negative: no automatic merging of two existing vaults.
  - AC (F0-01 quarantine): in `src/main.lifecycle.test.ts` remove 3× `it.skip` (marker `F3-01:`)
    and the `@ts-expect-error` on the `HAVEMIND_ONBOARDING_VIEW` import; all 11 tests green.

## F4, Sync end-to-end

- [x] **F4-01** `plugin` Sync runner and safe remote apply (T027)
  - Evidence (2026-07-16): sync-runner.test.ts 11/11, single-flight coalescing, jittered backoff
    2.5→5s with reset, echo suppression (0 writes, cursor+1), no re-push after restart;
    a diverged buffer → recordConflict without applyRemote, unknown base → deferred with the
    cursor held (regression per §14 "Never"); sync-runner.ts branch 96.42%; workspace 363 pass.
  - AC: single-flight + backoff, echo suppression, no duplicate after restart (functional,
    `npm test --workspace @havemind/obsidian-plugin -- sync-runner`).
  - AC: an active diverged buffer → deferral/conflict, never a silent overwrite (regression against
    `plans/001-technical-plan.md` §14 "Never").

## F5, History

- [x] **F5-01** `plugin` Activity, diff, restore (T028)
  - Evidence (2026-07-16): activity.test.ts 10/10, restore creates a NEW revision attributed
    to the restorer (restoredFromRevisionId, the DAG grows by exactly 1, the input stays
    byte-for-byte untouched); provenance: restored bytes → restorer, surviving bytes keep their
    author; newest-first feed, added/removed/context diff; workspace 374 pass, branch 84.44%.
  - AC: restore creates a NEW revision attributed to the restorer (functional, `npm test
    --workspace @havemind/obsidian-plugin -- activity`).

## F6, Attribution

- [x] **F6-01** `plugin` Author overlay (T029)
  - Evidence (2026-07-16): attribution.test.ts 12/12 (RED→GREEN), hash mismatch → visible:false,
    zero markers; Reading view: section:null → silence, no guessing; every segment has
    underline+tooltip+ariaLabel+colorToken+legend; reducedMotion → animate:false. Visual
    part: deterministic light/dark render in screenshots/F6/author-overlay.html from the real
    module output, CONFIRMED by the user 2026-07-16 ("overlay ok", both themes).
    Workspace 386 pass, branch 83.99%.
  - AC: hash mismatch → overlay hidden, Reading view never guesses without `getSectionInfo()`
    (functional + regression, `npm test --workspace @havemind/obsidian-plugin -- attribution`).
  - AC: color + underline + tooltip together, never color alone (qualitative, method: manual
    light/dark test + screenshot to `screenshots/F6/`).

## F7, Polish

- [x] **F7-01** `server,security` Backup, restore, server epoch (T022)
  - Evidence (2026-07-16): backup-restore.test.ts 10/10, restore: PRAGMA integrity_check +
    byte-for-byte manifest verification BEFORE startup, epoch unchanged on failure; new
    server_epoch after restore, old cursor → 409 CURSOR_INVALID end-to-end over HTTP;
    non-empty target rejected. Workspace 396 pass, branch 83.35%. Unblocks SRV-03.
  - AC: restore into an empty directory verifies the manifest + `PRAGMA integrity_check` before
    startup (functional, `npm test --workspace @havemind/server -- backup-restore`).
  - AC: a restored instance changes epoch, the old cursor forces reconciliation (functional).

- [x] **F7-02** `sapserver,security` Hardened Compose (T030)
  - Evidence (2026-07-16): `docker compose config` on sapserver (Compose v5.3.1, no sudo) exit 0,
    grep 0.0.0.0 → 0, host_ip 127.0.0.1:8787 publication; `npm run compose:smoke` exit 0;
    FROM node:22.23.1-bookworm-slim@sha256:6c74791e… (pinned digest, enforced by test);
    npm audit 0 vulnerabilities. Workspace 401 pass. The real `docker build/up` on sapserver
    is waiting on the user's sudo (mikolaj is outside the docker group), outside this issue's AC.
  - AC: `docker compose config` shows no port outside `127.0.0.1:*` (functional,
    method: `docker compose config | grep -c '0.0.0.0'` → 0).
  - AC: `npm run compose:smoke` green (functional).
  - AC negative: no image without a pinned digest.

- [x] **F7-03** `server,security` Setup CLI: secret generator + `.env.example` + diagnostics
  - Evidence (2026-07-16): env-example.test.ts, .env.example contains no working secret (pattern
    grep + every value rejected by token parsers); setup ≥256-bit, only sha256 stored in the DB
    (table dump with no raw token); doctor reads only /srv/secrets metadata, grep of text+json
    output for an injected secret → 0. Workspace 444 pass, branch 83.77%.
  - AC: `.env.example` contains no working secret (functional, method: grep the file +
    attempt to connect with values from the file → rejected).
  - AC: the setup command generates secrets with ≥256-bit entropy, stored only as a hash on the
    server side (functional, test).
  - AC: `havemind doctor` (or an equivalent diagnostic command) never prints a raw token,
    password, or the contents of a file from `/srv/secrets` in any output mode (functional,
    security, method: test against a fixture with an injected secret, grep output → 0 hits).
  - Prerequisite for: F8-02 (this issue's "diagnostics" AC assumes this command exists).

## F8, Decision gate (⏳ STOP and ask the user before starting, see `09-pilotaz-i-decyzje.md`)

- [x] **F8-01** `security` E2E fault harness (T031)
  - Evidence (2026-07-16): tests/e2e/fault-matrix.test.ts, 6/6 fault matrix rows from plan/07
    against a real Fastify instance (server restart mid-push → replay; client restart mid-apply
    → no half-applied state; partition 2× offline → convergence with no loss; duplicate delivery
    → the same serverSequence; restore → 409 CURSOR_INVALID and reconciliation; conflict on the
    same line → 2 heads + a Havemind Conflicts/ artifact, zero silent overwrites). `npm run
    test:e2e` exit 0; workspace 450 pass, branch 83.82%.
  - AC: a two-client simulation passes the whole fault matrix from `07-pakiet-wdrozeniowy-i-e2e.md`
    (functional, `npm run test:e2e`).

- [x] **F8-02a** `plugin` Plugin runtime integration (pilot prerequisite, uncovered at the
  start of T032): HTTP transport via requestUrl(), durable store (outbox/cursor/deferred),
  sync-runner scheduler in main.ts (startup/focus/online/interval), Activity view wired
  to F5-01 data, plugin install bundle (main.js+manifest.json) + instructions for joining
  a second device.
  - Evidence (2026-07-16): src/runtime/*, RequestUrlTransport (6 tests), DurableSyncState on
    saveData with no secrets (12), VaultApplyPort with conflicts routed to Havemind Conflicts/ (3),
    startup/focus/online/interval scheduler (3+4), Activity feed+Restore in the view (5+lifecycle),
    status bar Synced/Offline/Conflict (8); dist/{main.js,manifest.json} + docs/pilot/install.md;
    workspace 491 pass, branch 83.33%. Follow-up at deploy time: wire up the onboarding→connected
    resolvers (token/vaultId/fileId↔path/blob fetch) and controller.start().
- [x] **F8-02c** `server,security` Auth/onboarding HTTP surface (closes out T019/T020 over
  HTTP, a gap uncovered by F8-02b): invitation review/redeem routes, approval polling,
  bootstrap, refresh→access issuance, owner generate-invitation, all within the F2-02
  deny-by-default scope, consuming the existing F1-01/F2-01 services; Dockerfile: include the
  CLI (bin/ or dist/setup/cli.js invokable inside the container).
  - Evidence (2026-07-16): onboarding-routes.test.ts 11 tests, POST /vaults/:id/invitations
    (owner-only 200/401/403), review/redeem pre-auth with the F2-02 limiter (429 before lookup),
    GET /devices/:id/approval (pending→approved), GET /bootstrap, POST /auth/refresh (F1-01
    rotation); codes 410/409/403/429 with no leak; deferred refresh-token binding (the owner never
    learns the invitee's secret); Dockerfile copies bin/. Workspace 503 pass, branch 82.36%.
- [x] **F8-02b-A** `plugin` Wire up Connect/live loop (resumes after F8-02c): onboarding →
  connected → controller.start(), token/vaultId/fileId↔path/blob-fetch resolvers.
  - Evidence (2026-07-16): the Connect command + havemind-join → paste screen; RequestUrlOnboardingApi
    against the F8-02c routes (review→redeem→approval polling→bootstrap→connected, 6+4 tests);
    secrets held only in SecretStorage; refresh→access with caching and persistence of the successor;
    controller.start() on onLayoutReady when connected, passive when not; dist rebuilt;
    workspace 529 pass, branch 82.23%. GAP deferred → F8-02b-B: materialization of remote-only
    files (payload header decode) + a "create invitation" button in the owner UI.
- [x] **F8-02b-B** `plugin` Materialization of remote-only files + owner "create invitation" in the UI.
  - Evidence (2026-07-16): payload-codec (8 tests, rejects reserved/traversal paths); vault-apply
    rewritten (8 tests, create/update/collision→Conflicts/delete/rename, zero overwrites);
    the create-invitation command (v1. envelope, 15-min TTL, never logged); 545 pass. Commit d282a46.
- [x] **F8-02b-C** `plugin` fileId↔path map in DurableSyncState → edits to already-synced
  files apply in-place; only real collisions go to Havemind Conflicts/.
  - Evidence (2026-07-16): pathOwners in PersistedSyncState (3 tests), ownership recorded after
    every write/rename, forgotten on delete; a collision never overwrites or takes over a
    path; 551 pass, plugin branch ≥80%. dist rebuilt (631,959 B).
- [x] **F8-02d** `plugin,server` Onboarding UI gaps uncovered during the real pilot (2026-07-17).
  Done (TDD, green gate: build+typecheck+lint+test 605 pass):
  1. **Copy invitation**, the "Create invitation" panel has a button to copy the `v1.…`
     envelope (`clipboard.ts`: navigator.clipboard + fallback readonly textarea/execCommand).
  2. **Owner approve UI**, the "Approve pending device" command (`approve-device.ts` +
     `approvePendingDeviceForOwner` in obsidian-adapters): pending list + phrase + Approve →
     POST /vaults/:vaultId/invitations/:invitationId/approve (approveRedeemedDevice, matching
     the real onboarding-routes path; phrase only in the body, never in the log/URL).
  3. **create-invitation / approve CLI**, server-side subcommands (like rotate-pairing):
     `create-invitation [--role --name]` mints a v1.… envelope; `approve [--invitation --phrase]`
     lists/approves a pending device. The raw token is never logged separately.
  - Evidence (2026-07-17): server 230 tests (27 in cli.test.ts), plugin 235 tests; full workspace
    gate EXIT=0, 605 tests. `dist/main.js` rebuilt (new symbols present).
- [x] **F8-02** `user-decision` Seven-day pilot on sapserver (T032)
  - ✅ CLOSED 2026-08-07 by user decision, with deviations recorded in
    `docs/pilot/checklist.md` ("Pilot closure"): 4/7 df-h entries (window restarted
    on redeploys), backup still deferred (gate before 1.0). Real usage
    25.07–07.08, zero data loss, 3 detected incidents fixed.
  - AC: full checklist from `09-pilotaz-i-decyzje.md`, recorded in `docs/pilot/checklist.md`.
  - AC: daily `df -h /` entry in `docs/pilot/checklist.md` for 7 days; alarm and entry in
    `DECISIONS.md` if growth exceeds 20 GB relative to the start day (qualitative, method: 7 dated
    entries in the checklist).
  - ⏳ BLOCKED: waiting on user confirmation (decision gate) + SRV-03/04/05 + F7-03 completed.

## F9, Follow-up (equivalent to Phase 8 in `plans/001-technical-plan.md`; ⚠ HARD, separate plans, sequential)

- [x] **F9-01** `user-decision` Prepare 4 separate follow-up plans (T033), GitHub/BRAT alpha,
  E2EE/recovery, attachments/quota, encrypted checkpoints.
  - ✅ CLOSED 2026-08-07: 4 plans exist. 003 done de facto (the obsidian-havemind
    distribution repo + BRAT works); 004 and 006 dropped by user decision (E2EE abandoned,
    tailnet-only model); 005 partially done (binaries work; per-vault quota still open).
  - AC: 4 files `plans/00X-*.md` exist, each containing the headings `## Spec`, `## Threat model`,
    `## Acceptance tests`, `## Rollout/rollback` (functional, method: script/grep checking
    the presence of the 4 headings in each of the 4 files → 16/16 hits).
  - AC: each plan cites a specific Stage gate from `specs/003-open-source-release.md` (e.g.
    "Stage 2, public technical alpha") by name, not generically (functional).
  - ⏳ BLOCKED: waiting on F8-02 closure.

## SRV, Sapserver operations (parallel from F0, blocks F8)

- [x] **SRV-01** `sapserver` Tailscale update on the server
  - AC: `tailscale version` after the update ≥ the current version on the day of execution
    (functional).
  - Evidence (2026-07-16): the user ran `sudo apt install tailscale`, `tailscale version` → 1.98.9
    (from 1.98.8), output pasted in the orchestrator session.
- [x] **SRV-02** `sapserver,user-decision` Choice of backup location
  - Evidence (2026-07-16): the user chose a NAS on the local network (AskUserQuestion in the
    orchestrator session).
  - Follow-up for SRV-03: before deploying Restic, ask the user for the NAS host/share/protocol
    (NFS/SMB/SFTP), this data hasn't been provided yet.
- [x] **SRV-03** `sapserver,security` Restic deployment, WON'T FIX (closed 2026-08-18 by user
  decision, see DECISIONS.md). The server is a pure opaque relay; every vault's full content and
  history already lives on each member's local machine, so a server-side backup protects no data
  that isn't already duplicated. Not a pilot-only waiver anymore, closed for the life of this
  architecture. Revisit only if the server ever stops being a pure relay.
  - Done without sudo: scripts in ops/sapserver/restic + ~/havemind-ops on the server (backup/
    prune 7/4/6 with restic check before forget/restore/verify), a 384-bit repo password in a 0600
    file, an smb-credentials template, systemd mount+automount for //192.168.x.n/backup.
  - UPDATE (2026-07-16, sudo-free architecture): restic 0.19.1 + rclone 1.74.4 static binaries
    in ~/bin (SHA256-verified), smb remote `nas-backup` in rclone.conf 0600, repo string
    `rclone:nas-backup:backup/havemind-restic`, 7/4/6 retention in prune.sh (check before forget),
    bootstrap.sh closes out init+backup+verify with one command. ZERO sudo steps.
  - USER BLOCKERS (the only ones): (1) enable SMB on the NAS at 192.168.x.n + a writable `backup`
    share (445/139 currently refused); (2) `rclone config` on sapserver, enter the SMB
    credentials interactively; then `bash ~/havemind-ops/bootstrap.sh`.
  - AC: repo encrypted off the server's system disk, 7/4/6 retention configured
    (functional, method: `restic snapshots` + `restic check`).
  - Depends on: F7-01 (application backup/restore needs an endpoint/CLI before Restic wraps
    the same logic around a real repository on the server, see `08-sapserver-operations.md`).
  - Blocks: F8-02.
- [x] **SRV-04** `sapserver` Single-file restore test, WON'T FIX, closed with SRV-03
  (2026-08-18): no backup to restore from; see DECISIONS.md.
- [x] **SRV-05** `sapserver` Full-service restore test onto a clean instance, WON'T FIX, closed
  with SRV-03 (2026-08-18): no backup to restore from; see DECISIONS.md.
- [x] **SRV-06** `sapserver` Docker test page on `127.0.0.1:8080` + Tailscale Serve
  - AC: the page is reachable only over the tailnet, `ss -lntu` (no `sudo` needed to
    check the bind address) shows no port on the public interface (functional
    + regression).
  - Evidence (2026-09-04): closed by the REAL service rather than the nginx dry
    run, which would have proved less. `docker compose ps` shows
    `127.0.0.1:8787->8787/tcp`: the bind is on loopback, no port on a public
    interface, and the tailnet reaches it through `tailscale serve`. Container
    `Up (healthy)`, and the live logs show `/vaults/:vaultId/wait` and
    `/events` answering 200 to a real client. Standing up a test page beside a
    deployment that already satisfies the AC would have added risk, not proof.
- [x] **SRV-07** `sapserver,user-decision` Power-loss autostart in BIOS
  - Evidence (2026-07-16): the user set Restore on AC/Power Loss → Power On (Advanced →
    Chipset Configuration, bottom of the list, confirmed against the ASRock manual pp. 63-64) and
    restarted; the server came up (uptime 0 min, Tailscale 1.98.9). Recorded in
    docs/pilot/checklist.md.
  - AC: the agent CANNOT perform or verify this remotely (no IPMI/BMC on the ASRock
    Z370 Gaming-ITX/ac), this phase's first report returns this as an explicit request to the user
    to physically enter the BIOS at the next restart, rather than attempting 3 tries or
    checking it off as "almost done" (manual, method: user confirmation recorded in
    `docs/pilot/checklist.md`).
  - Blocks: F8-02 (7-day pilot).

## AUDIT-FINDINGS (loop bug-hunt, 2026-07-18)

Findings from parallel audits (plugin coexistence + e2e/migrations/config/DAG).
Fixes from this loop are committed separately; below is what was deliberately deferred.

- [x] **AUD-01** `server,security` TOCTOU race in orphaned-blob cleanup
  - Hot-path fix (reject) removed; sweep on server startup (with no concurrent pushes).
  - Fixed: `915cc4b` (blob-gc.ts + startup sweep). Previous racy fix `0382eb8` reverted.
- [x] **AUD-02** `plugin` A file (not a folder) named `Havemind Conflicts` jams the pull loop
  - Guard `instanceof TFolder` + fallback (`Havemind Conflicts (files)` → root) in
    `writeConflictArtifact`.
  - Fixed: plugin conflict-folder commit (below, same loop).
- [x] **AUD-03** `plugin` Formatter/linter churn between machines with different settings
  - Closed (2026-08-31) as a duplicate: the fix is the AUD-03 row further down
    (`37e609d`, hash-side canonicalization + 1500 ms settle window + one-time
    rebase). `runtime/modify-debounce.ts` and `runtime/canonicalization-rebase.ts`
    are in the tree. This row is the pre-fix description, kept for its analysis.
  - Symptom: an auto-formatting plugin (Linter "format on save", Prettier-for-Obsidian) rewrites
    the note after Havemind writes it → `contentHash` differs from the seeded value → a new
    revision gets pushed. Two machines with different styles oscillate indefinitely; under
    concurrency a growing pile of `Havemind Conflicts/`. No data loss. MEDIUM, partly inherent to
    file-sync+formatters.
  - Direction: (1) extend `canonicalizeMarkdown` (already normalizes CRLF) with symmetric
    trailing-newline handling before hashing; (2) a short "settling" window after apply before
    hashing; (3) DOC, recommend users sync their formatter settings / disable format-on-save
    for conflicts.
  - Decision: for the 2-person pilot, DOC + trailing-newline is enough; the full fix is deferred.
- [x] **AUD-04** `plugin` Folder rename/delete from another plugin can leave stale mappings
  - Fixed: `1ace877`, `observeFolderRename`/`observeFolderDelete` (segment-exact prefix,
    idempotent across per-child events, reusing per-file machinery). 371 plugin tests.
  - Conditional (depends on whether Obsidian emits per-child TFile events on a folder move).
    If only a TFolder event fires, the child gets a new fileId (fork/duplicate on the peer) until
    `reconcileVaultState` on reconnect heals it (content-match pairing). LOW-MEDIUM,
    eventual-consistency, no permanent loss.
  - Direction: on a TFolder rename/delete event, immediately re-path/tombstone child mappings, or
    verify on a live Obsidian build that per-child TFile events always fire, and document it.
- [x] **AUD-05** `server,sapserver` Rate limiter shares one global bucket behind Tailscale
  - Fixed: `eb4acdc`, bucket keyed by `device:<deviceId>` when a valid bearer session exists,
    falling back to `request.ip` for unauthenticated traffic (brute-force cap preserved).
  - `trustProxy: false` + `request.ip` = loopback under Tailscale serve/funnel → the 120/60s limit
    is global across both devices, not per-client. On the invitee's first bulk download (lots of
    blob GETs + event pages) one device could get 429. The client classifies 429 as transient
    and backs off, no loss, but onboarding a large vault slows down. MINOR/operational.
  - Direction: raise/scope the limit, key per authenticated device when a session exists,
    or exempt blob GET from the limit.
- [x] **AUD-06** `server` Missing paths in the fault matrix (test coverage, not a bug)
  - Closed: row 7 (multi-page catch-up, 120 events across the page-100 boundary, cursor
    exactly 120, zero skip/double-apply) + row 8 (retry idempotency for refresh-token rotation
    after a lost response; generation +1 not +2; reuse → 401). Harness fix: InvitationService
    was not wired into buildApp (pre-auth routes returned 404 in e2e).
- [x] **AUD-08** `server,plugin` Large-backlog catch-up can hit 429 mid-drain
  - Fixed: `c1f7f74`, authenticated, session-verified blob GET no longer consumes the bucket
    (null-key bypass in the limiter; the rest of the traffic is unchanged, blobBelongsToVault
    still guards reads).
- [x] **F9 fragment: cleanup-stale CLI** `server`, `5ae748a`: `havemind.js cleanup-stale`
  (--dry-run, --pending-older-than-hours, RESTRICT-safe, approved devices never touched).
- [x] **F9 fragment: Rejoin (backend + modules)** `server,plugin`, `d0c9b12`: rejoin_grants
  (migration 004), a one-time 15-min grant bound to (membershipId, deviceId), redeem flat-401,
  RejoinController + rejoin-roster. UI wiring in main.ts, separate commit (in progress).
- [x] **AUD-09** `server,security` `/auth/rejoin` outside the auth-routes limiter scope
  - Fixed: `b47ee60`, IP-keyed limiter (reusing createRateLimiter) on POST /auth/rejoin.
- [x] **AUD-03** `plugin` Hash-side canonicalization + settling + one-time rebase
  - `37e609d`, trailing newline + BOM only at hash time (on-disk files untouched),
    1500 ms modify debounce, base-hash rebase on startup (version marker, exactly once).
    Deployment requirement: both plugins swapped in the same window; server unchanged.
- [x] **F9: binary attachments** `protocol,sync-core,plugin,server`
  - `acbf46e` (wire format: kind:'binary', base64, raw-byte hash, backward compatible) +
    `b7c663a` (server limits: 36 MiB payload / 40 MiB body) + `6959e90` (plugin: allowlist
    png/jpg/jpeg/gif/webp/svg/pdf, 25 MB cap, whole-file replace, extension-aware conflict copy,
    rebase skips binaries; fix for a base64-regex crash on files >3 MB → O(n) scan).
  - Deployment requirement: server first (limits), then BOTH plugins together, the old plugin
    doesn't decode kind:'binary'. Restore for binaries: markdown-only (documented).
  - Finding from AUD-06: draining >100 revisions = 1 blob-fetch per revision; with the 120/60s
    per-device limit (after AUD-05), a legitimate catch-up after a longer offline period can hit
    429 in bursts. The client classifies 429 as transient and backs off, self-heals after the
    60s window, no loss; the cost is throttled catch-up (tens of seconds to minutes on a large
    backlog). Doesn't block the 2-person pilot.
  - Direction: batch blob-fetch (multiple hashes in one request), exempt blob GET from the limit
    for authenticated devices, or raise the limit for sessions with a valid bearer.
- [x] **AUD-07** `plugin` User notes under a dotted path segment or in the `Havemind Conflicts` folder
  - `isEligiblePath` rejects any segment starting with `.` (e.g. `Notes/.drafts/x.md`) and the
    reserved root `Havemind Conflicts/` → such notes do NOT sync (under-sync, safe by
    direction). LOW/usability, just a note in the user documentation.
  - Evidence (2026-09-03): the function is named `classifyVaultPath`/`eligibleKind`, not
    `isEligiblePath` (`apps/obsidian-plugin/src/obsidian/vault-adapter.ts`). Read from the code,
    the real rules are three, not two: (1) any dot-leading path segment; (2) the reserved
    `Havemind Conflicts/` root, TOP LEVEL ONLY (`Notes/Havemind Conflicts/x.md` and
    `Havemind Conflicts Archive/x.md` both sync); (3) an extension outside `.md` + the binary
    allowlist, tested case-INsensitively (`pic.PNG` syncs), and applied BEFORE rules 1-2. The
    `.obsidian/` appearance allowlist is checked before the dot-path guard, so the backlog's
    "any segment starting with `.`" was already wrong. Documented in
    `docs/pilot/known-limitations.md` ("Dot-paths and the reserved folder") and, user-facing, in
    `docs/self-hosting.md` section h.
  - Bug found while confirming the rules, fixed here (TDD): the producer compared the reserved
    root case-SENSITIVELY while the protocol's `RESERVED_ROOTS` folds case, so
    `havemind conflicts/x.md` was classified eligible, enqueued, then threw inside
    `canonicalizeVaultPath` at envelope build (`packages/sync-core/src/revision-envelope.ts`),
    killing the push cycle and latching the device Offline. Tests written first and observed RED
    (2 failed / 35 passed) for that exact reason, then GREEN at 37; fix reverted to re-confirm
    RED and restored. Pinned by "excludes a case variant of the reserved root" and "never
    classifies eligible a path the protocol reserves" in `vault-adapter.test.ts`, the second of
    which fails if the two layers ever disagree again.

- [x] **AUD-10** `server` Minor findings from the pre-pilot audit (2026-07-22, none blocking)
  - (a) `/owner/rejoin-grants` has no limiter (intentional, self-flagged in the code), add it in
    the next server round; (b) `blobByteHash` in the binary payload is dead metadata
    (the external content-addressed hash already closes integrity), wire it in as a
    defense-in-depth cross-check or fix the doc comment; (c) no cap on concurrent in-flight
    pushes (~100-150 MiB transient/request at the ceiling), irrelevant in the 2-person trust
    model, relevant if the trust boundary widens; (d) `#resolveBoundDevice` picks the most
    recently approved device, revisit before multi-device.
  - Evidence (2026-09-03): all four handled; full write-up in
    `docs/pilot/known-limitations.md`, "Server audit follow-ups (backlog AUD-10)".
    (a) ALREADY DONE, not re-done: `/owner/rejoin-grants` runs `grantRateLimit` in `onRequest`
    before the handler, in its own IP-keyed bucket separate from pre-auth `/auth/rejoin`
    (`apps/server/src/auth/rejoin-routes.ts`), covered by "429s once one client exceeds the owner
    grant threshold" in `rejoin-routes.test.ts`. The "self-flagged, no limiter" comment the
    finding cited no longer exists. This landed with AUD2-02; the route lives in
    `rejoin-routes.ts`, so no edit to the concurrently-owned `rejoin-grants.ts` or
    `auth-routes.ts` was needed.
    (b) DOC COMMENT FIXED, field left unwired, deliberately. Verified the decoder ignores
    `blobByteHash` entirely and the consumer recomputes `hashBlob(bytes)` itself
    (`payload-codec.ts`, `vault-apply.ts` `applyRemoteBinary`); the payload JSON including the
    base64 is content-addressed and re-hashed on read (`blob-store.ts` `#verifyExisting`), so a
    cross-check would catch no reachable failure while adding a hash pass over up to 25 MB per
    attachment to the receive path. Corrected the comments in
    `packages/sync-core/src/revision-envelope.ts` and `packages/protocol/src/revision-schema.ts`
    that implied a guarantee; added a characterisation test pinning that a wrong `blobByteHash`
    still decodes ("does not verify blobByteHash: the field is unread metadata"), proven to have
    teeth by making the decoder verify the field and observing the test fail.
    (c) RECORDED, no cap built. Evidence: 40 MiB per-request body limit
    (`DEFAULT_BODY_LIMIT_BYTES`) with a 36 MiB payload ceiling, and 120 req/60 s per client key
    (`DEFAULT_RATE_LIMIT`) on the protected surface, but nothing bounds simultaneity, so peak
    transient memory is concurrency x 40 MiB. Accepted for a two-device tailnet where every
    caller is authenticated; the ceiling and its trigger-to-revisit are now stated in a comment
    on `DEFAULT_BODY_LIMIT_BYTES` in `apps/server/src/config.ts` and in the docs. A semaphore is
    the fix if the trust boundary widens.
    (d) DOCUMENTED KNOWN LIMITATION, no code change. `#resolveBoundDevice` selects
    `ORDER BY (vault_id IS NULL), approved_at DESC, id LIMIT 1`, vault-scoped first, then most
    recently approved; unambiguous at one device per person, arbitrary from the user's point of
    view with several. Must be revisited before multi-device ships, when the grant needs to name
    its target device. Not edited here in any case: it lives in `rejoin-grants.ts`, concurrently
    owned by another agent.

## Server hardening (audit iteration 2)

Findings from the second server audit iteration (2026-07-23). Two fixed in this loop
(FIX #1 cursor-from-the-future CURSOR_INVALID on the pull path; FIX #2 removal of the full
re-hash from the blob `read` hot path); below is what was deliberately deferred.

- [x] **AUD2-01** NIT `server` `auth-routes.ts:129`, the rate-limiter's `windows` map never
  removes entries after `resetAt` (grows with the number of keys). Limited in practice (2 devices).
  - Evidence (2026-09-03): `createRateLimiter` now sweeps expired windows on
    access (`auth-routes.ts:169-178`, `sweep(nowMs)` called at line 187 before the bucket
    lookup), gated by `SWEEP_THRESHOLD_KEYS = 32` so the 2-device steady state
    pays nothing. Deliberately a traffic-driven lazy sweep, not a
    `setInterval`: a timer would outlive the Fastify instance that owns the
    limiter and hold the process open, which is the ownership discipline the
    plugin documents in `scheduler-hooks.ts`. The limiter is now a
    `RateLimiter` (callable + `trackedKeys()`) so eviction is observable
    without reaching into the closure; `rejoin-routes.ts`/`revoke-routes.ts`
    call it unchanged. Covered by
    `auth-routes.test.ts` "AUD2-01 rate-limiter window eviction" (3 tests:
    50 dead keys collapse to 1 after one full window, live windows survive,
    a live counter still 429s across a sweep). Red first
    (`limiter.trackedKeys is not a function`), then green; regression probe
    (delete the `sweep(nowMs)` call) re-failed the eviction test and passed
    again on restore. `npm run verify` exits 0, 1888 tests in 154 files.
- [x] **AUD2-02** NIT `server` `rejoin-routes.ts:157`, `revoke-routes.ts:154`, owner mutation
  endpoints (rejoin/revoke) with no rate limit.
  - Evidence (2026-08-31): both endpoints now build a limiter from
    `createRateLimiter` and run it in `onRequest` before the handler
    (`rejoin-routes.ts:165`, `revoke-routes.ts:165`), each taking its window from
    `deps.rateLimit ?? DEFAULT_RATE_LIMIT`.
- [x] **AUD2-08** MINOR `server` `sync/sync-routes.ts:788-830`, `GET /vaults/:vaultId/blobs/:blobHash`
  authorises on `requireSession` + `loadActiveMembership` + `blobBelongsToVault`
  and never reads the `vaults` table, so a member whose session predates a vault
  soft-delete can still read blob bytes out of that vault. Push and pull already
  fail closed (`revision-repository.ts` `#getVault` and `getCursor` both filter
  `deleted_at IS NULL`); this route is the one gap in that containment. Found
  2026-09-03 while fixing AUD2-05, which closed only the rejoin-shaped path.
  - AC: a soft-deleted vault's blob GET returns 404/403 for a session minted
    before the delete; push/pull behaviour unchanged.
  - Evidence (2026-09-03): the soft-delete filter is folded into the existing
    `blobBelongsToVault` lookup as a join onto `vaults`
    (`sync/sync-routes.ts:340-369`) rather than a second query, so a deleted
    vault stays indistinguishable from a missing blob and the caller's existing
    404 mapping is reused. 2 new tests in `sync-routes.test.ts` ("AUD2-08 blob
    GET honours the vault soft-delete"): one asserts 200 while live then 404
    after the delete (so the refusal cannot be a broken fixture), one guards
    against over-reach by keeping a live vault's blob readable. Red first: the
    delete case returned 200. Regression probe: dropping the
    `vaults.deleted_at IS NULL` line fails exactly that test (1 failed / 44
    passed). `npm run verify` exit 0, 1899 tests.
- [x] **AUD2-07** NIT `server` `device-throttles.ts:70`, `BlobByteRateLimiter.#buckets`
  never removes entries, one bucket per device id lives for the process lifetime.
  Same unbounded-map pattern as AUD2-01, found while fixing it (2026-09-03).
  A device bucket is only dead once it has refilled to `burstBytes`, so eviction
  must not drop a bucket that is still paying off a charge. Bounded in practice
  by the device count, so NIT, not MINOR.
  - Evidence (2026-09-03): `BlobByteRateLimiter.#sweep` evicts only buckets that
    have refilled to `burstBytes` (`device-throttles.ts:86-110`), called from
    `tryConsume`, gated by `SWEEP_THRESHOLD_DEVICES = 32`. A full bucket owes
    nothing so dropping it changes no decision; a bucket below its cap is kept,
    or eviction would hand a throttled device a fresh budget. Lazy and
    traffic-driven, not a `setInterval`, matching the AUD2-01 sweep. 3 new tests
    (evicts full buckets, keeps a mid-debt bucket, skips the scan below the
    threshold). Red first: `trackedDevices` did not exist. Regression probe:
    removing the `#sweep` call fails the eviction test. `npm run verify` exit 0,
    1902 tests.
  - Also corrected a misleading comment in the pre-existing "refills the bucket
    over time" test: it read "100 bytes/second == 0.1 bytes/ms" while passing
    `100` into a parameter the production call site feeds bytes-per-MS
    (`sync-routes.ts:427-431` divides a per-second config by 1000). The test was
    correct, its comment was not, and the comment misled this work at first.
- [x] **AUD2-03** NIT `server` `rejoin-grants.ts:321-342`, multiple live rejoin grants
  can be redeemed simultaneously per membership.
  - Evidence (2026-09-03): the finding was diagnosed as TWO separate questions and
    only one of them was a real defect. Single-use redemption was ALREADY atomic:
    `UPDATE rejoin_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`
    guarded by `changes !== 1` (`rejoin-grants.ts:348-357`), inside a
    `BEGIN IMMEDIATE` transaction (`redeem.immediate()`), which is the repo's
    established pattern; better-sqlite3 is synchronous and `busy_timeout` plus
    WAL is configured centrally in `db.ts:72-75`, so two redemptions cannot
    interleave inside one transaction and a second process serialises on the
    write lock. No race to fix there. The REAL defect was upstream: nothing
    stopped `createGrant` from leaving N unconsumed rows for one membership, and
    `#loadLiveGrant` takes the newest unconsumed row (`ORDER BY created_at DESC
    ... LIMIT 1`), so N grants meant N redeemable sessions, each one individually
    "single-use". Fix: `createGrant` now supersedes every earlier unconsumed
    grant for the target membership before inserting the replacement
    (`rejoin-grants.ts:245-260`), in the SAME `BEGIN IMMEDIATE` transaction as
    the insert, so "at most one redeemable grant per membership" holds at every
    commit boundary. Chose the invariant over a schema change: a partial unique
    index would need migration 008 and would make a legitimate re-issue fail
    instead of superseding. Covered by
    `rejoin-grants.test.ts:442` "AUD2-03: one live grant per membership"
    (3 tests: a new grant supersedes the earlier one, three issued grants still
    yield exactly one redemption then `GRANT_NOT_FOUND`, and another
    membership's live grant is untouched). Red first (2 of the 3 failed, the
    third passed as the over-broad-invalidation guard it is meant to be), then
    green; regression probe (delete the superseding UPDATE) re-failed exactly
    those 2 and passed again on restore. `npm run verify` exits 0, 1896 tests in
    154 files.
- [x] **AUD2-04** NIT (latent, unreachable in single-vault) `server` `membership-revocation.ts:127-132`
, membership revocation deletes ALL of a user's devices via `WHERE user_id`; becomes a
  real cross-vault bug if multi-vault is enabled.
  - Evidence (2026-08-31): the device query is scoped,
    `WHERE user_id = ? AND (vault_id = ? OR vault_id IS NULL)`
    (`membership-revocation.ts:139`), the scope column arrives in migration 007,
    and `vault_id IS NULL` stays fail-closed for devices onboarded before it.
    Covered by `membership-revocation.test.ts` and
    `multi-vault-isolation.test.ts:625` (vault B untouched).
- [x] **AUD2-05** NIT `server` `rejoin-grants.ts:254-319`, rejoin ignores vault soft-delete
  (fails fail-closed downstream).
  - Evidence (2026-09-03): the "fail-closed downstream" claim was checked against
    the code and holds for sync, but NOT completely. Push and pull do fail
    closed: every mutation path goes through `revision-repository.ts` `#getVault`
    (line 917, `WHERE id = ? AND deleted_at IS NULL`, NOT_FOUND when absent,
    called at lines 623 and 654 from the commit path) and the pull route calls
    `getCursor` (line 471, same filter) at `sync/sync-routes.ts:768` before
    `listEvents`. The hole is `GET /vaults/:vaultId/blobs/:blobHash`
    (`sync/sync-routes.ts:788-830`): it authorises on `loadActiveMembership`
    (line 795) and `blobBelongsToVault` (line 807) and never reads `vaults` at
    all, so a session minted by rejoin could still read blob bytes out of a
    soft-deleted vault. So the containment was real for writes and for the event
    stream, and incomplete for blob reads, which is exactly why the check
    belongs at the source. Fix: the guard sits in `#loadMembership`
    (`rejoin-grants.ts:411-425`), the ONE loader both `createGrant` and
    `redeemGrant` route through, so issuing and redeeming are both covered by a
    single branch rather than one guard per caller; `#vaultIsLive`
    (`rejoin-grants.ts:427-432`) is the `deleted_at IS NULL` probe. Reused the
    existing `MEMBERSHIP_INACTIVE` code (403 FORBIDDEN via
    `REJOIN_CODE_BY_ERROR`) rather than adding an eighth error code: a
    membership in a deleted vault is inactive in every sense the caller can act
    on, and `/auth/rejoin` flattens every redemption failure to 401 anyway.
    Covered by `rejoin-grants.test.ts:527` "AUD2-05: rejoin honours the vault
    soft-delete" (3 tests: no grant may be issued, no grant may be redeemed, and
    a refused redemption leaves the grant unconsumed so the rejection is not
    itself a way to burn a grant). Red first (all 3 failed with "Expected
    RejoinGrantError but none was thrown"), then green; regression probe
    (delete the `#vaultIsLive` branch) re-failed exactly those 3 and passed
    again on restore. `npm run verify` exits 0, 1896 tests in 154 files.
- [x] **AUD2-06** MINOR `server` `auth-routes.ts:200-203`, blob GET is exempt from the rate limit
  as an amplifier; documented as AUD-08, revisit if abused.
  - Evidence (2026-09-03): resolved as "no behaviour change, the comment was
    lying". The request-count exemption is load-bearing (it is the only way to
    drain a >100-revision catch-up backlog, one blob fetch per revision,
    without 429ing mid-drain, AUD-08) and request counting is the wrong
    instrument for an amplifier whose cost is bytes. The amplifier is already
    bounded on both axes, in `sync-routes.ts`: `blobBelongsToVault`
    (`sync-routes.ts:808`) gates which bytes an authenticated member may read,
    and every served blob is charged by byte length against a per-device
    egress token bucket (`BlobByteRateLimiter`, `device-throttles.ts:69-103`,
    applied at `sync-routes.ts:819-825`) that answers 429 over budget.
    The `defaultClientKey` doc comment claimed only the first of those, so it
    was corrected to state the byte budget and the held-wait ceiling
    (`auth-routes.ts:239-267`, the AUD2-06 paragraph at 253-261). No new test: the claim is already enforced
    end-to-end by `sync-routes.test.ts:1319` "AUD-08b blob-GET per-device byte
    throttle" (200, 200, 429 + refill), which fails if the budget is removed;
    adding a duplicate in a file owned by another workstream was avoided.
    `npm run verify` exits 0, 1888 tests in 154 files.

## MERGE-3WAY (user decision 2026-07-22: modeled on Obsidian Sync / obsidian-livesync)

Research: `docs/research-conflicts.md`. Execution order AFTER the conflict-cascade fix.

- [x] **MRG-01** `plugin,sync-core` Automatic three-way merge from a common ancestor
  - `0f32f65`, diff3 in sync-core (LCS, zero dependencies), ancestor = durable baseContents
    (hash-verified, zero server changes), overlap/adjacency → conservative fallback.
  - On divergence: linear 3-way diff (ancestor from revision history, local, remote);
    non-overlapping hunks → merge in place, no copy; overlap → today's fallback
    (conflict copy). Overlap detection is CONSERVATIVE (prose ≠ code; when in doubt → copy,
    never a garbled merge, the documented silent-merge failure mode of Obsidian Sync).
  - Zero-silent-overwrite remains a hard law; merge extends the convergence path,
    it doesn't weaken the conflict guarantee.
- [x] **MRG-02** `plugin` Readable conflict-copy names, `0f32f65`
  - `<note> (conflict <author> <YYYY-MM-DD HHmm>).md`; a revisionId→path map guards against
    duplicates on redelivery.
  - `note name (conflict, <device/author>, <timestamp>).md` instead of `<uuid>-<uuid>.md`.
- [x] **MRG-03** `plugin` In-app conflict-resolution modal, `0f32f65`
  - A Conflicts section in the panel + a modal (colored diff, Keep mine/theirs/both, two-step
    confirmation); legacy UUIDs get a manual hint.
  - Modeled on: ConflictResolveModal from obsidian-livesync, side-by-side/inline diff only for
    genuinely overlapping hunks, pick a side or merge, without leaving Obsidian.
- [x] **MRG-05** `plugin` Auto-repair sweep for existing conflicts, `9fa4305`
  - On plugin startup and after every new copy appears: for each copy in
    `Havemind Conflicts/`, attempt a three-way merge (ancestor from history, the current note,
    the copy's content); non-overlapping hunks → merge into the note + delete the copy (Notice);
    overlap → leave it for the modal (MRG-03). Idempotent, per-item, never loses content.
- [x] **SND-01** `plugin` Send-queue visibility, `9fa4305` (+ `4a59817` failed-to-queue)
  - Panel: "N changes waiting to send" (outbox non-empty >30s) + a "N failed to send"
    section (quarantine) with Retry/Discard per entry; a Notice on first entry into quarantine.
- [x] **SND-02** `audit` Adversarial audit of the full send path, performed 2026-07-22
  - Found 2 MAJOR (keepTheirs on a vanished copy = data loss; silently swallowed pre-enqueue
    errors) + 2 MINOR, all fixed in `4a59817`. The send path now has no silent loss
    points.
- [x] **MRG-04** `docs` CRDT deliberately rejected at this stage (docs/research-conflicts.md) (cost
  of persistent per-file state, no coverage for binaries/rename, "not production-ready" even at
  large vendors), revisit only if a real need for live concurrent editing arises.

## UI, interface rebuild (plans/007, owner decision 2026-08-20)

The plugin is public, so this interface is now the first thing every new user
meets. E2EE deliberately deferred in favour of this (owner decision). Stages
are sequential; each is independently releasable.

- [x] **UI-00** `plugin,user-decision` One hexagon, one pane (plans/007 Stage 0)
  - Collapse three doors (ribbon hexagon → activity, ribbon `users` → overlay
    toggle, command palette → connect panel) into a single ribbon icon opening
    a single registered view. Connect, activity, authorship, roster and
    conflicts become sections inside it.
  - AC: AT0-1…AT0-4 from `plans/007-ui-rebuild.md` green.
  - AC negative: no command is removed, the palette and hotkeys remain a full
    keyboard/screen-reader path (regression on F8-02d).
  - ⏳ BLOCKED on the visual design of the pane (Claude Design). This issue
    fixes the structure; the layout of the single pane is designed first.
  - Unblocked 2026-09-03: the pane design arrived (`Havemind Mobile.dc.html`,
    nine artboards). Its desktop half was already implemented in an earlier
    round; the phone half landed as `47dbf68` (safe-area + coarse-pointer
    targets) and `10bb8ac` (no hosting path on a phone).
  - Evidence (2026-09-03): the scope was NARROWER than this entry described.
    One ribbon icon and one entry point already existed (Stages 0/1); what
    survived was the second REGISTERED VIEW TYPE. `HAVEMIND_ACTIVITY_VIEW` was
    still registered with nothing left to open it, so a workspace layout saved
    while the old Activity leaf was open could restore a second, orphaned
    Havemind surface that no command reaches and that drifts from the pane's own
    Activity tab. That registration is removed (`main.ts:325`).
  - AT0-1/AT0-2/AT0-4 pinned by `main.single-pane.test.ts` (one ribbon, exactly
    one registered type, every command still present AND invocable). AT0-3 was
    already covered by `activity-in-pane.test.ts` and the tab tests.
  - Follow-on cleanup: `PluginViewRegistry` lost its activity slot, which had
    become three silent no-op `refreshActivity()` calls in `main.ts`; guarded by
    a test in `view-registry.test.ts`. `HavemindActivityView` still builds and
    is still tested (`main.lifecycle.test.ts` constructs it directly), it simply
    has no registered type pointing at it; `HAVEMIND_ACTIVITY_VIEW` stays
    re-exported, since dropping a published name is a separate decision.
  - Regression probes: re-adding a second `registerView` fails AT0-2; discarding
    the `activityLog.subscribe` disposer still fails the repointed unload test,
    so moving it onto the pane kept its guard on F9 bug #4.
  - `npm run verify` exit 0, 1911 tests.

- [x] **UI-01** `plugin` Split the two entry paths (plans/007 Stage 1)
  - Evidence (2026-08-31): chooser shipped in `runtime/entry-choice.ts` +
    `ui/entry-chooser-section.ts`. AT1-1 and AT1-5 covered by
    `ui/priority-column.test.ts` ("asks which path a fresh user is on",
    "skips the question for someone who followed a join link"); AT1-2/AT1-3 by
    `runtime/entry-choice.test.ts` (paths, prices, one copyable command,
    absolute guide URL); AT1-4 by the draft-preservation test added the same
    day, which fails when `captureDrafts()` is removed. Negative AC holds:
    `HavemindOnboardingViewOptions` and the `main.ts` wiring are unchanged.
    Layout defects found while verifying this on screen are fixed in 1.2.2
    (inset, scrolling, bottom air), see `ui/entry-inset.test.ts`.
  - A chooser replaces the unconditional five-step tutorial: "I have an
    invitation" goes straight to the paste form, "I'll host the server" gets
    the tutorial. Both keep a back affordance; a `havemind-join` URI skips the
    chooser.
  - AC: AT1-1…AT1-5 from `plans/007-ui-rebuild.md` green.
  - AC negative: no change to `HavemindOnboardingViewOptions` semantics,
    `main.ts` wiring compiles untouched.
  - Presentation only: no protocol, server or sync change.

- [x] **UI-02** `plugin` Hierarchy in the connected panel (plans/007 Stage 2)
  - Three tiers: always-visible (status, anything actionable), collapsed
    (roster, idle send queue), behind an affordance (tutorial). A healthy panel
    shows the status row and little else.
  - AC: AT2-1…AT2-4 from `plans/007-ui-rebuild.md` green.
  - AC negative (T3): nothing actionable, a conflict, a quarantined send, is
    ever collapsed out of first paint.
  - Evidence (2026-09-03): the BEHAVIOUR was already satisfied by the tabbed
    pane; no production change was needed. What was missing was the proof, so
    this closes as a test-only change (`ui/tiered-panel.test.ts`, 5 tests).
    Tier 1: alarms render above the tab strip on every tab
    (`onboarding-view.ts:452-453`), so a tab can never hide one. Tier 2: the
    roster lives behind the People tab rather than a summary line, which is
    stronger than the stage asked for. Tier 3: the tutorial stays behind its
    affordance (`helpOpen`).
  - Each AC was probed rather than assumed. AT2-2/AT2-4: moving the alarms
    inside the tab body fails both. AT2-1: removing the empty-list guards from
    BOTH `renderConflicts` and `renderConflictSection` fails it.
  - The AT2-1 probe caught a hollow test of my own first: without
    `onResolveConflict`/`onRetrySend` wired, the sections bail out early and the
    test passed for the wrong reason, proving only that an unwired pane draws
    nothing. It now wires the handlers as the real plugin does, and asserts on
    the alarm BLOCK (border, tint, left rule) and the tab's `needs-attention`
    class, not merely on rows.
  - `npm run verify` exit 0, 1916 tests.

- [x] **UI-03** `plugin` Explicit view state (plans/007 Stage 3)
  - Replace the ordered `if … return` chain in `render()` with a discriminated
    `ViewState` and one exhaustive `switch`; derive it in a pure, unit-tested
    `resolveViewState`. Invitation composer becomes a modal, not a screen.
  - AC: AT3-1…AT3-4 from `plans/007-ui-rebuild.md` green.
  - AC: `ui/onboarding-view.ts` under 250 lines; no file in `ui/screens/` over 200.
  - PARTIAL (2026-09-03), deliberately left open. The ViewState half is done and
    pushed (`e275fe5`): `runtime/view-state.ts` resolves the screen from a pure
    function, precedence is table-driven (`view-state.test.ts`, AT3-1), and
    `assertNever` makes a new variant a compile error, verified by adding one and
    watching `tsc` reject it (AT3-3). AT3-2 is fixed and probed: the composer has
    no ViewState variant, so it draws OVER the connected state and the status row
    is lifted above the tab strip while it is open; removing that lift fails the
    test.
  - DONE (2026-09-04): `onboarding-view.ts` is **209 lines**, down from 1240, and
    the 250-line assertion in `ui/file-size.test.ts` is enabled rather than
    skipped. Sixteen screens live under `ui/screens/`, every one inside the
    200-line ceiling, which caught `connected-body.ts` at 226 and forced the
    layout/wiring split that fixed it.
  - The move that finished it was the one predicted here: passing the options
    bag straight to the screens and deleting the adapter layer. Extracting a
    fourteenth screen would not have worked; the adapters cost as much in the
    delegate as they removed.
  - One step was reverted rather than kept: inlining `entryPath` produced a call
    site as long as the method, so it bought nothing and cost readability.
  - Two existing tests caught real defects in the first wiring attempt: a double
    read of `composerProvider` (against the file's own read-once rule), and an
    assertion that selected the approval confirmation as "the first
    `.havemind-status`", which the lifted row displaced.
  - AC (regression, structural): opening the composer while connected leaves the
    status row rendered, the 1.1.3 defect becomes impossible, not just fixed.
  - AC: `npm run test:e2e` green **without modifying** the e2e suites.

## MOB, mobile clients (research 2026-08-31)

The plugin ships `isDesktopOnly: true`, which `plans/001-technical-plan.md` §282
records as a pilot-era decision ("desktop-only until mobile behavior passes its
own smoke tests"), not a technical limit. A code audit found the bundle already
mobile-clean: the build's own check rejects Node and Electron APIs and passes,
there is no `FileSystemAdapter`, no regex lookbehind, no raw `fetch` (61 calls
go through `requestUrl`), no WebSocket, no `localStorage`, and IndexedDB is
reached through `globalThis`. The 16 `adapter.*` calls read `.obsidian/` config
the Vault API cannot see, and `DataAdapter` exists on mobile.

Two constraints are the platform's, not ours, and are documented rather than
fixed: the server URL is a tailnet address, so a phone needs Tailscale, and iOS
suspends background work after roughly 30 seconds, so sync runs while Obsidian
is open. That limit applies to every sync plugin, LiveSync included.

MOB-01 is worth doing on its own merits; the other two are gated behind it and
behind a real device.

- [x] **MOB-01** `plugin` Resume the sync loop when the app comes back to the foreground
  - The server's long poll runs 25s (`sync-routes.ts:121`,
    `DEFAULT_WAIT_TIMEOUT_MS`) and iOS freezes background work at about 30s, yet
    the plugin registers no `visibilitychange` listener at all. Minimising
    Obsidian leaves a `/wait` request frozen mid-flight, and returning to the app
    tells the sync loop nothing: it resumes on backoff at best, and waits out a
    dead request at worst.
  - The teardown work in 1.2.3 already supplies the mechanism (`AbortSignal` in
    `connect-driver.ts`, the stop signal in `wake-subscription.ts`); this wires it
    to document visibility.
  - Worth doing regardless of mobile: a slept laptop behaves the same way.
  - AC: with the document hidden then shown, the runner abandons the in-flight
    wait and re-enters the loop immediately rather than after a backoff delay
    (functional, fake visibility source, no real timers).
  - AC negative: no listener survives `onunload`, and a visibility event after
    teardown starts nothing (regression on the 1.2.3 teardown guarantees).
  - AC: `npm run verify` green; no change to the sync protocol or the server.
  - Correction to the research note: the plugin DOES already re-trigger on
    `focus` (`scheduler.ts`, `scheduler-hooks.ts`), but that drives only the
    periodic poll and never touched `WakeSubscription`, so a frozen long-poll
    still sat dead until its backoff elapsed. The gap was narrower than recorded.
  - Evidence (2026-09-03): `WakeSubscription.resume()` releases the pending
    backoff/settle delay and clears `failureCount`, inert after `stop()` and
    before `start()`; new `onVisible` hook in `SchedulerHooks` registers on
    `document` with a REAL disposer (never `plugin.registerDomEvent`, whose
    unload-only teardown is the leak documented at `scheduler-hooks.ts:24`);
    controller registers on `start()`, disposes on `stop()`, idempotent across a
    double `start()`. 7 new tests (3 resume + 4 controller). `npm run verify`
    exit 0, 1885 tests (was 1878). Coverage 90.08% stmts / 83.17% branches.
    Regression probe: removing the delay release makes the resume test hang and
    fail. Build's Node/Electron check still passes, no CSS touched so the plugin
    class list is unchanged.

- [ ] **MOB-02** `plugin,user-decision` Smoke-test a mobile build on a real device
  - Build with `isDesktopOnly: false` and side-load the three files onto one
    phone. Never flip the shipped manifest first: the plugin is public, and an
    untested flag lands on other people's phones.
  - Cover, in one pass: onboarding from an invitation, sync both directions, one
    conflict, the author overlay in the mobile editor, one binary attachment, and
    behaviour across minimise and return.
  - Two answers cannot come from reading the code. The author overlay uses the
    public `editorInfoField`, but the mobile editor is a different touch surface
    in a narrow column. And `MAX_BINARY_FILE_BYTES` is 25 MB carried as base64 in
    memory (~33 MB, plus copies while converting), which a 3 GB phone may refuse.
  - AC: every item above either passes or is recorded as a named defect with a
    reproduction.
  - Depends on: MOB-01.

- [ ] **MOB-03** `plugin,docs` Ship mobile support
  - Flip `isDesktopOnly`, document what a phone needs (Obsidian, Tailscale on the
    same tailnet, the plugin) and what it does not get (background sync), and say
    plainly that sync runs while Obsidian is open.
  - AC: the defects MOB-02 found are fixed or documented as known limitations.
  - AC: `docs/self-hosting.md` covers joining from a phone end to end.
  - Depends on: MOB-02.

## GITLAB-IMPORT

- Labels: `foundation`, `server`, `plugin`, `sapserver`, `security`, `user-decision`, `docs`.
- Milestones: `F0`, `F1`, `F2`, `F3`, `F4`, `F5`, `F6`, `F7`, `F8`, `F9`, `SRV`, `MOB`.
- Import: `glab issue create` per row above (title = `Fx-NN: description`, body = AC), or export
  to CSV (`Title,Labels,Milestone,Description`) and `glab issue import` where available.
- Checkboxes in this file remain the source of truth for progress, the tracker import is a copy
  for team visibility management, it doesn't replace checking things off here.
