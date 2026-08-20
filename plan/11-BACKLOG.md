# 11 — BACKLOG.md

Ordering rule: F0→F9 strictly sequential; SRV-* runs in parallel from F0, but SRV-03/04/05
are a hard blocker for F8 (see `09-pilotaz-i-decyzje.md`). Labels: `server`, `plugin`,
`sapserver`, `security`, `user-decision`. Milestones = phases (F0…F9, SRV). Checkboxes in this
file are the source of truth for progress — the subagent checks one off only after the AC passes,
not before.

**Phase Definition of Done** (added on top of the sum of the phase's issue ACs): `npm run build && npm
run lint && npm test` green for the whole workspace; 80%+ coverage threshold maintained; one entry
in the phase report (what works, what's deferred, evidence).

## F0 — Foundation

- [x] **F0-01** `foundation` Configure strict TS/lint/Vitest across the whole workspace (T002)
  - AC: `npm run typecheck && npm run lint && npm test` green for all packages
    (functional); 80% coverage threshold enforced in configuration, not only described in CI
    (qualitative, method: `npm run test:coverage` reports the threshold from configuration); no
    existing test T004-T017 stops passing (regression).
  - AC negative: no `any` without an explicit justifying comment in newly touched files.
  - Files: `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `scripts/check-workspace.mjs`.
  - Evidence (2026-07-16): typecheck + lint + test green (279 pass / 3 skipped — approved
    F3-01 quarantine, see DECISIONS.md); `npm run test:coverage` exit 0 — statements 84.75%,
    branches 80.22%, functions 88.99%, lines 85.41%, 80% threshold enforced in `vitest.config.ts`;
    zero regression on T004-T017; no `any` (`no-explicit-any` = error passes cleanly).

- [x] **F0-02** `foundation` Verify canonical data without duplication
  - AC: grep of the `plan/` package for phrases copied 1:1 from `specs/*.md`/`plans/*.md` longer than
    one sentence → 0 hits (functional, method: manual review + grep).
  - AC: table from `02-fundamenty.md` verified — every referenced file exists (curl/cat
    the path).
  - Evidence (2026-07-16): sentence-level diff plan/*.md vs specs/*.md+plans/*.md → 0 duplicated
    sentences (≥12 words); 6/6 repo files exist; Sapserver note confirmed to exist as
    the operator's private setup note (outside this repo).

## F1 — Cross-cutting systems

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
    (rename back to `.test.ts`) and bring to green — see DECISIONS.md 2026-07-16.

## F2 — Skeleton (server + plugin vertical slice)

- [x] **F2-01** `server` Invitations and device approval (T019)
  - Evidence (2026-07-16): invitations.test.ts 17/17 green — 256-bit token (32B), only SHA-256
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
  - Evidence (2026-07-16): auth-routes.test.ts 10/10 — cross-vault IDOR 403 with no leak; spoofed
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
  - Evidence (2026-07-16): sync-routes.test.ts 15/15 — a cycle in parent_revision_ids → 422 before
    any write (pre-flight Kahn); replay of identical bytes → 200 replayed with the same
    receipt; different bytes → 409 REVISION_ID_REUSE; cursor-based pull + byte-exact blob; server
    stays opaque (payload as bytes). Workspace 338 pass, branch 84.33%.
  - AC: a batch with a cycle in `parent_revision_ids` → `422`, whole batch rejected (functional).
  - AC: identical `revision_id` + identical bytes → the original result; different bytes → `409`
    (functional, `npm test --workspace @havemind/server -- sync-routes`).

- [x] **F2-04** `plugin` Vault-adapter and reconciliation (T026)
  - Evidence (2026-07-16): vault-adapter + reconciliation 11/11 — dedup by SHA-256 (a modify with the
    same hash → null), rename preserves fileId; classifyVaultPath rejects `.obsidian/**`,
    `.trash`, `Havemind Conflicts` (reconciliation ignored:2, zero commits); .todo-F2-04
    files restored and green; workspace 349 pass / 3 skipped, branch 84.53%.
  - AC: create/modify/rename/delete deduplicated by hash (functional).
  - AC negative: `.obsidian/**` never reaches the outbox (`npm test --workspace
    @havemind/obsidian-plugin -- vault-adapter`).
  - AC (F0-01 quarantine): restore `src/obsidian/vault-adapter.test.ts.todo-F2-04` and
    `src/sync/reconciliation.test.ts.todo-F2-04` (rename to `.test.ts`) and bring to green.

## F3 — Onboarding (first value for the user: being able to connect)

- [x] **F3-01** `plugin,security` Secure invitation onboarding (T025)
  - Evidence (2026-07-16): the havemind-join handler accepts only {action} — it.each tests for
    token/envelope/secret/harmless → no view, requestCalls=0; onboarding resume() green;
    no merge logic on the onboarding path (grep); F3-01 quarantine lifted — lifecycle 11/11
    (RED 3 failed → GREEN); workspace coverage branch 84.62%.
  - AC: the invitation secret is never in the `obsidian://havemind-join` query string (functional,
    method: grep the wizard code + integration test checking the URL).
  - AC: resumable bootstrap after interruption (functional, `npm test --workspace
    @havemind/obsidian-plugin -- onboarding`).
  - AC negative: no automatic merging of two existing vaults.
  - AC (F0-01 quarantine): in `src/main.lifecycle.test.ts` remove 3× `it.skip` (marker `F3-01:`)
    and the `@ts-expect-error` on the `HAVEMIND_ONBOARDING_VIEW` import; all 11 tests green.

## F4 — Sync end-to-end

- [x] **F4-01** `plugin` Sync runner and safe remote apply (T027)
  - Evidence (2026-07-16): sync-runner.test.ts 11/11 — single-flight coalescing, jittered backoff
    2.5→5s with reset, echo suppression (0 writes, cursor+1), no re-push after restart;
    a diverged buffer → recordConflict without applyRemote, unknown base → deferred with the
    cursor held (regression per §14 "Never"); sync-runner.ts branch 96.42%; workspace 363 pass.
  - AC: single-flight + backoff, echo suppression, no duplicate after restart (functional,
    `npm test --workspace @havemind/obsidian-plugin -- sync-runner`).
  - AC: an active diverged buffer → deferral/conflict, never a silent overwrite (regression against
    `plans/001-technical-plan.md` §14 "Never").

## F5 — History

- [x] **F5-01** `plugin` Activity, diff, restore (T028)
  - Evidence (2026-07-16): activity.test.ts 10/10 — restore creates a NEW revision attributed
    to the restorer (restoredFromRevisionId, the DAG grows by exactly 1, the input stays
    byte-for-byte untouched); provenance: restored bytes → restorer, surviving bytes keep their
    author; newest-first feed, added/removed/context diff; workspace 374 pass, branch 84.44%.
  - AC: restore creates a NEW revision attributed to the restorer (functional, `npm test
    --workspace @havemind/obsidian-plugin -- activity`).

## F6 — Attribution

- [x] **F6-01** `plugin` Author overlay (T029)
  - Evidence (2026-07-16): attribution.test.ts 12/12 (RED→GREEN) — hash mismatch → visible:false,
    zero markers; Reading view: section:null → silence, no guessing; every segment has
    underline+tooltip+ariaLabel+colorToken+legend; reducedMotion → animate:false. Visual
    part: deterministic light/dark render in screenshots/F6/author-overlay.html from the real
    module output — CONFIRMED by the user 2026-07-16 ("overlay ok", both themes).
    Workspace 386 pass, branch 83.99%.
  - AC: hash mismatch → overlay hidden, Reading view never guesses without `getSectionInfo()`
    (functional + regression, `npm test --workspace @havemind/obsidian-plugin -- attribution`).
  - AC: color + underline + tooltip together, never color alone (qualitative, method: manual
    light/dark test + screenshot to `screenshots/F6/`).

## F7 — Polish

- [x] **F7-01** `server,security` Backup, restore, server epoch (T022)
  - Evidence (2026-07-16): backup-restore.test.ts 10/10 — restore: PRAGMA integrity_check +
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
    is waiting on the user's sudo (mikolaj is outside the docker group) — outside this issue's AC.
  - AC: `docker compose config` shows no port outside `127.0.0.1:*` (functional,
    method: `docker compose config | grep -c '0.0.0.0'` → 0).
  - AC: `npm run compose:smoke` green (functional).
  - AC negative: no image without a pinned digest.

- [x] **F7-03** `server,security` Setup CLI: secret generator + `.env.example` + diagnostics
  - Evidence (2026-07-16): env-example.test.ts — .env.example contains no working secret (pattern
    grep + every value rejected by token parsers); setup ≥256-bit, only sha256 stored in the DB
    (table dump with no raw token); doctor reads only /srv/secrets metadata — grep of text+json
    output for an injected secret → 0. Workspace 444 pass, branch 83.77%.
  - AC: `.env.example` contains no working secret (functional, method: grep the file +
    attempt to connect with values from the file → rejected).
  - AC: the setup command generates secrets with ≥256-bit entropy, stored only as a hash on the
    server side (functional, test).
  - AC: `havemind doctor` (or an equivalent diagnostic command) never prints a raw token,
    password, or the contents of a file from `/srv/secrets` in any output mode (functional,
    security, method: test against a fixture with an injected secret, grep output → 0 hits).
  - Prerequisite for: F8-02 (this issue's "diagnostics" AC assumes this command exists).

## F8 — Decision gate (⏳ STOP and ask the user before starting — see `09-pilotaz-i-decyzje.md`)

- [x] **F8-01** `security` E2E fault harness (T031)
  - Evidence (2026-07-16): tests/e2e/fault-matrix.test.ts — 6/6 fault matrix rows from plan/07
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
  - Evidence (2026-07-16): src/runtime/* — RequestUrlTransport (6 tests), DurableSyncState on
    saveData with no secrets (12), VaultApplyPort with conflicts routed to Havemind Conflicts/ (3),
    startup/focus/online/interval scheduler (3+4), Activity feed+Restore in the view (5+lifecycle),
    status bar Synced/Offline/Conflict (8); dist/{main.js,manifest.json} + docs/pilot/install.md;
    workspace 491 pass, branch 83.33%. Follow-up at deploy time: wire up the onboarding→connected
    resolvers (token/vaultId/fileId↔path/blob fetch) and controller.start().
- [x] **F8-02c** `server,security` Auth/onboarding HTTP surface (closes out T019/T020 over
  HTTP, a gap uncovered by F8-02b): invitation review/redeem routes, approval polling,
  bootstrap, refresh→access issuance, owner generate-invitation — all within the F2-02
  deny-by-default scope, consuming the existing F1-01/F2-01 services; Dockerfile: include the
  CLI (bin/ or dist/setup/cli.js invokable inside the container).
  - Evidence (2026-07-16): onboarding-routes.test.ts 11 tests — POST /vaults/:id/invitations
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
    rewritten (8 tests — create/update/collision→Conflicts/delete/rename, zero overwrites);
    the create-invitation command (v1. envelope, 15-min TTL, never logged); 545 pass. Commit d282a46.
- [x] **F8-02b-C** `plugin` fileId↔path map in DurableSyncState → edits to already-synced
  files apply in-place; only real collisions go to Havemind Conflicts/.
  - Evidence (2026-07-16): pathOwners in PersistedSyncState (3 tests), ownership recorded after
    every write/rename, forgotten on delete; a collision never overwrites or takes over a
    path; 551 pass, plugin branch ≥80%. dist rebuilt (631,959 B).
- [x] **F8-02d** `plugin,server` Onboarding UI gaps uncovered during the real pilot (2026-07-17).
  Done (TDD, green gate: build+typecheck+lint+test 605 pass):
  1. **Copy invitation** — the "Create invitation" panel has a button to copy the `v1.…`
     envelope (`clipboard.ts`: navigator.clipboard + fallback readonly textarea/execCommand).
  2. **Owner approve UI** — the "Approve pending device" command (`approve-device.ts` +
     `approvePendingDeviceForOwner` in obsidian-adapters): pending list + phrase + Approve →
     POST /vaults/:vaultId/invitations/:invitationId/approve (approveRedeemedDevice, matching
     the real onboarding-routes path; phrase only in the body, never in the log/URL).
  3. **create-invitation / approve CLI** — server-side subcommands (like rotate-pairing):
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

## F9 — Follow-up (equivalent to Phase 8 in `plans/001-technical-plan.md`; ⚠ HARD, separate plans, sequential)

- [x] **F9-01** `user-decision` Prepare 4 separate follow-up plans (T033) — GitHub/BRAT alpha,
  E2EE/recovery, attachments/quota, encrypted checkpoints.
  - ✅ CLOSED 2026-08-07: 4 plans exist. 003 done de facto (the obsidian-havemind
    distribution repo + BRAT works); 004 and 006 dropped by user decision (E2EE abandoned,
    tailnet-only model); 005 partially done (binaries work; per-vault quota still open).
  - AC: 4 files `plans/00X-*.md` exist, each containing the headings `## Spec`, `## Threat model`,
    `## Acceptance tests`, `## Rollout/rollback` (functional, method: script/grep checking
    the presence of the 4 headings in each of the 4 files → 16/16 hits).
  - AC: each plan cites a specific Stage gate from `specs/003-open-source-release.md` (e.g.
    "Stage 2 — public technical alpha") by name, not generically (functional).
  - ⏳ BLOCKED: waiting on F8-02 closure.

## SRV — Sapserver operations (parallel from F0, blocks F8)

- [x] **SRV-01** `sapserver` Tailscale update on the server
  - AC: `tailscale version` after the update ≥ the current version on the day of execution
    (functional).
  - Evidence (2026-07-16): the user ran `sudo apt install tailscale` — `tailscale version` → 1.98.9
    (from 1.98.8), output pasted in the orchestrator session.
- [x] **SRV-02** `sapserver,user-decision` Choice of backup location
  - Evidence (2026-07-16): the user chose a NAS on the local network (AskUserQuestion in the
    orchestrator session).
  - Follow-up for SRV-03: before deploying Restic, ask the user for the NAS host/share/protocol
    (NFS/SMB/SFTP) — this data hasn't been provided yet.
- [x] **SRV-03** `sapserver,security` Restic deployment — WON'T FIX (closed 2026-08-18 by user
  decision, see DECISIONS.md). The server is a pure opaque relay; every vault's full content and
  history already lives on each member's local machine, so a server-side backup protects no data
  that isn't already duplicated. Not a pilot-only waiver anymore — closed for the life of this
  architecture. Revisit only if the server ever stops being a pure relay.
  - Done without sudo: scripts in ops/sapserver/restic + ~/havemind-ops on the server (backup/
    prune 7/4/6 with restic check before forget/restore/verify), a 384-bit repo password in a 0600
    file, an smb-credentials template, systemd mount+automount for //192.168.x.n/backup.
  - UPDATE (2026-07-16, sudo-free architecture): restic 0.19.1 + rclone 1.74.4 static binaries
    in ~/bin (SHA256-verified), smb remote `nas-backup` in rclone.conf 0600, repo string
    `rclone:nas-backup:backup/havemind-restic`, 7/4/6 retention in prune.sh (check before forget),
    bootstrap.sh closes out init+backup+verify with one command. ZERO sudo steps.
  - USER BLOCKERS (the only ones): (1) enable SMB on the NAS at 192.168.x.n + a writable `backup`
    share (445/139 currently refused); (2) `rclone config` on sapserver — enter the SMB
    credentials interactively; then `bash ~/havemind-ops/bootstrap.sh`.
  - AC: repo encrypted off the server's system disk, 7/4/6 retention configured
    (functional, method: `restic snapshots` + `restic check`).
  - Depends on: F7-01 (application backup/restore needs an endpoint/CLI before Restic wraps
    the same logic around a real repository on the server — see `08-sapserver-operations.md`).
  - Blocks: F8-02.
- [x] **SRV-04** `sapserver` Single-file restore test — WON'T FIX, closed with SRV-03
  (2026-08-18): no backup to restore from; see DECISIONS.md.
- [x] **SRV-05** `sapserver` Full-service restore test onto a clean instance — WON'T FIX, closed
  with SRV-03 (2026-08-18): no backup to restore from; see DECISIONS.md.
- [ ] **SRV-06** `sapserver` Docker test page on `127.0.0.1:8080` + Tailscale Serve
  - AC: the page is reachable only over the tailnet, `ss -lntu` (no `sudo` needed to
    check the bind address) shows no port on the public interface (functional
    + regression).
- [x] **SRV-07** `sapserver,user-decision` Power-loss autostart in BIOS
  - Evidence (2026-07-16): the user set Restore on AC/Power Loss → Power On (Advanced →
    Chipset Configuration, bottom of the list — confirmed against the ASRock manual pp. 63-64) and
    restarted; the server came up (uptime 0 min, Tailscale 1.98.9). Recorded in
    docs/pilot/checklist.md.
  - AC: the agent CANNOT perform or verify this remotely (no IPMI/BMC on the ASRock
    Z370 Gaming-ITX/ac) — this phase's first report returns this as an explicit request to the user
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
- [ ] **AUD-03** `plugin` Formatter/linter churn between machines with different settings
  - Symptom: an auto-formatting plugin (Linter "format on save", Prettier-for-Obsidian) rewrites
    the note after Havemind writes it → `contentHash` differs from the seeded value → a new
    revision gets pushed. Two machines with different styles oscillate indefinitely; under
    concurrency a growing pile of `Havemind Conflicts/`. No data loss. MEDIUM, partly inherent to
    file-sync+formatters.
  - Direction: (1) extend `canonicalizeMarkdown` (already normalizes CRLF) with symmetric
    trailing-newline handling before hashing; (2) a short "settling" window after apply before
    hashing; (3) DOC — recommend users sync their formatter settings / disable format-on-save
    for conflicts.
  - Decision: for the 2-person pilot, DOC + trailing-newline is enough; the full fix is deferred.
- [x] **AUD-04** `plugin` Folder rename/delete from another plugin can leave stale mappings
  - Fixed: `1ace877` — `observeFolderRename`/`observeFolderDelete` (segment-exact prefix,
    idempotent across per-child events, reusing per-file machinery). 371 plugin tests.
  - Conditional (depends on whether Obsidian emits per-child TFile events on a folder move).
    If only a TFolder event fires — the child gets a new fileId (fork/duplicate on the peer) until
    `reconcileVaultState` on reconnect heals it (content-match pairing). LOW-MEDIUM,
    eventual-consistency, no permanent loss.
  - Direction: on a TFolder rename/delete event, immediately re-path/tombstone child mappings, or
    verify on a live Obsidian build that per-child TFile events always fire, and document it.
- [x] **AUD-05** `server,sapserver` Rate limiter shares one global bucket behind Tailscale
  - Fixed: `eb4acdc` — bucket keyed by `device:<deviceId>` when a valid bearer session exists,
    falling back to `request.ip` for unauthenticated traffic (brute-force cap preserved).
  - `trustProxy: false` + `request.ip` = loopback under Tailscale serve/funnel → the 120/60s limit
    is global across both devices, not per-client. On the invitee's first bulk download (lots of
    blob GETs + event pages) one device could get 429. The client classifies 429 as transient
    and backs off — no loss, but onboarding a large vault slows down. MINOR/operational.
  - Direction: raise/scope the limit, key per authenticated device when a session exists,
    or exempt blob GET from the limit.
- [x] **AUD-06** `server` Missing paths in the fault matrix (test coverage, not a bug)
  - Closed: row 7 (multi-page catch-up, 120 events across the page-100 boundary, cursor
    exactly 120, zero skip/double-apply) + row 8 (retry idempotency for refresh-token rotation
    after a lost response; generation +1 not +2; reuse → 401). Harness fix: InvitationService
    was not wired into buildApp (pre-auth routes returned 404 in e2e).
- [x] **AUD-08** `server,plugin` Large-backlog catch-up can hit 429 mid-drain
  - Fixed: `c1f7f74` — authenticated, session-verified blob GET no longer consumes the bucket
    (null-key bypass in the limiter; the rest of the traffic is unchanged, blobBelongsToVault
    still guards reads).
- [x] **F9 fragment: cleanup-stale CLI** `server` — `5ae748a`: `havemind.js cleanup-stale`
  (--dry-run, --pending-older-than-hours, RESTRICT-safe, approved devices never touched).
- [x] **F9 fragment: Rejoin (backend + modules)** `server,plugin` — `d0c9b12`: rejoin_grants
  (migration 004), a one-time 15-min grant bound to (membershipId, deviceId), redeem flat-401,
  RejoinController + rejoin-roster. UI wiring in main.ts — separate commit (in progress).
- [x] **AUD-09** `server,security` `/auth/rejoin` outside the auth-routes limiter scope
  - Fixed: `b47ee60` — IP-keyed limiter (reusing createRateLimiter) on POST /auth/rejoin.
- [x] **AUD-03** `plugin` Hash-side canonicalization + settling + one-time rebase
  - `37e609d` — trailing newline + BOM only at hash time (on-disk files untouched),
    1500 ms modify debounce, base-hash rebase on startup (version marker, exactly once).
    Deployment requirement: both plugins swapped in the same window; server unchanged.
- [x] **F9: binary attachments** `protocol,sync-core,plugin,server`
  - `acbf46e` (wire format: kind:'binary', base64, raw-byte hash, backward compatible) +
    `b7c663a` (server limits: 36 MiB payload / 40 MiB body) + `6959e90` (plugin: allowlist
    png/jpg/jpeg/gif/webp/svg/pdf, 25 MB cap, whole-file replace, extension-aware conflict copy,
    rebase skips binaries; fix for a base64-regex crash on files >3 MB → O(n) scan).
  - Deployment requirement: server first (limits), then BOTH plugins together — the old plugin
    doesn't decode kind:'binary'. Restore for binaries: markdown-only (documented).
  - Finding from AUD-06: draining >100 revisions = 1 blob-fetch per revision; with the 120/60s
    per-device limit (after AUD-05), a legitimate catch-up after a longer offline period can hit
    429 in bursts. The client classifies 429 as transient and backs off — self-heals after the
    60s window, no loss; the cost is throttled catch-up (tens of seconds to minutes on a large
    backlog). Doesn't block the 2-person pilot.
  - Direction: batch blob-fetch (multiple hashes in one request), exempt blob GET from the limit
    for authenticated devices, or raise the limit for sessions with a valid bearer.
- [ ] **AUD-07** `plugin` User notes under a dotted path segment or in the `Havemind Conflicts` folder
  - `isEligiblePath` rejects any segment starting with `.` (e.g. `Notes/.drafts/x.md`) and the
    reserved root `Havemind Conflicts/` → such notes do NOT sync (under-sync, safe by
    direction). LOW/usability — just a note in the user documentation.

- [ ] **AUD-10** `server` Minor findings from the pre-pilot audit (2026-07-22, none blocking)
  - (a) `/owner/rejoin-grants` has no limiter (intentional, self-flagged in the code) — add it in
    the next server round; (b) `blobByteHash` in the binary payload is dead metadata
    (the external content-addressed hash already closes integrity) — wire it in as a
    defense-in-depth cross-check or fix the doc comment; (c) no cap on concurrent in-flight
    pushes (~100-150 MiB transient/request at the ceiling) — irrelevant in the 2-person trust
    model, relevant if the trust boundary widens; (d) `#resolveBoundDevice` picks the most
    recently approved device — revisit before multi-device.

## Server hardening (audit iteration 2)

Findings from the second server audit iteration (2026-07-23). Two fixed in this loop
(FIX #1 cursor-from-the-future CURSOR_INVALID on the pull path; FIX #2 removal of the full
re-hash from the blob `read` hot path); below is what was deliberately deferred.

- [ ] **AUD2-01** NIT `server` `auth-routes.ts:129` — the rate-limiter's `windows` map never
  removes entries after `resetAt` (grows with the number of keys). Limited in practice (2 devices).
- [ ] **AUD2-02** NIT `server` `rejoin-routes.ts:157`, `revoke-routes.ts:154` — owner mutation
  endpoints (rejoin/revoke) with no rate limit.
- [ ] **AUD2-03** NIT `server` `rejoin-grants.ts:321-342` — multiple live rejoin grants
  can be redeemed simultaneously per membership.
- [ ] **AUD2-04** NIT (latent, unreachable in single-vault) `server` `membership-revocation.ts:127-132`
  — membership revocation deletes ALL of a user's devices via `WHERE user_id`; becomes a
  real cross-vault bug if multi-vault is enabled.
- [ ] **AUD2-05** NIT `server` `rejoin-grants.ts:254-319` — rejoin ignores vault soft-delete
  (fails fail-closed downstream).
- [ ] **AUD2-06** MINOR `server` `auth-routes.ts:200-203` — blob GET is exempt from the rate limit
  as an amplifier; documented as AUD-08, revisit if abused.

## MERGE-3WAY (user decision 2026-07-22: modeled on Obsidian Sync / obsidian-livesync)

Research: `docs/research-conflicts.md`. Execution order AFTER the conflict-cascade fix.

- [x] **MRG-01** `plugin,sync-core` Automatic three-way merge from a common ancestor
  - `0f32f65` — diff3 in sync-core (LCS, zero dependencies), ancestor = durable baseContents
    (hash-verified, zero server changes), overlap/adjacency → conservative fallback.
  - On divergence: linear 3-way diff (ancestor from revision history, local, remote);
    non-overlapping hunks → merge in place, no copy; overlap → today's fallback
    (conflict copy). Overlap detection is CONSERVATIVE (prose ≠ code; when in doubt → copy,
    never a garbled merge — the documented silent-merge failure mode of Obsidian Sync).
  - Zero-silent-overwrite remains a hard law; merge extends the convergence path,
    it doesn't weaken the conflict guarantee.
- [x] **MRG-02** `plugin` Readable conflict-copy names — `0f32f65`
  - `<note> (conflict <author> <YYYY-MM-DD HHmm>).md`; a revisionId→path map guards against
    duplicates on redelivery.
  - `note name (conflict, <device/author>, <timestamp>).md` instead of `<uuid>-<uuid>.md`.
- [x] **MRG-03** `plugin` In-app conflict-resolution modal — `0f32f65`
  - A Conflicts section in the panel + a modal (colored diff, Keep mine/theirs/both, two-step
    confirmation); legacy UUIDs get a manual hint.
  - Modeled on: ConflictResolveModal from obsidian-livesync — side-by-side/inline diff only for
    genuinely overlapping hunks, pick a side or merge, without leaving Obsidian.
- [x] **MRG-05** `plugin` Auto-repair sweep for existing conflicts — `9fa4305`
  - On plugin startup and after every new copy appears: for each copy in
    `Havemind Conflicts/`, attempt a three-way merge (ancestor from history, the current note,
    the copy's content); non-overlapping hunks → merge into the note + delete the copy (Notice);
    overlap → leave it for the modal (MRG-03). Idempotent, per-item, never loses content.
- [x] **SND-01** `plugin` Send-queue visibility — `9fa4305` (+ `4a59817` failed-to-queue)
  - Panel: "N changes waiting to send" (outbox non-empty >30s) + a "N failed to send"
    section (quarantine) with Retry/Discard per entry; a Notice on first entry into quarantine.
- [x] **SND-02** `audit` Adversarial audit of the full send path — performed 2026-07-22
  - Found 2 MAJOR (keepTheirs on a vanished copy = data loss; silently swallowed pre-enqueue
    errors) + 2 MINOR — all fixed in `4a59817`. The send path now has no silent loss
    points.
- [x] **MRG-04** `docs` CRDT deliberately rejected at this stage (docs/research-conflicts.md) (cost
  of persistent per-file state, no coverage for binaries/rename, "not production-ready" even at
  large vendors) — revisit only if a real need for live concurrent editing arises.

## UI — interface rebuild (plans/007, owner decision 2026-08-20)

The plugin is public, so this interface is now the first thing every new user
meets. E2EE deliberately deferred in favour of this (owner decision). Stages
are sequential; each is independently releasable.

- [ ] **UI-01** `plugin` Split the two entry paths (plans/007 Stage 1)
  - A chooser replaces the unconditional five-step tutorial: "I have an
    invitation" goes straight to the paste form, "I'll host the server" gets
    the tutorial. Both keep a back affordance; a `havemind-join` URI skips the
    chooser.
  - AC: AT1-1…AT1-5 from `plans/007-ui-rebuild.md` green.
  - AC negative: no change to `HavemindOnboardingViewOptions` semantics —
    `main.ts` wiring compiles untouched.
  - Presentation only: no protocol, server or sync change.

- [ ] **UI-02** `plugin` Hierarchy in the connected panel (plans/007 Stage 2)
  - Three tiers: always-visible (status, anything actionable), collapsed
    (roster, idle send queue), behind an affordance (tutorial). A healthy panel
    shows the status row and little else.
  - AC: AT2-1…AT2-4 from `plans/007-ui-rebuild.md` green.
  - AC negative (T3): nothing actionable — a conflict, a quarantined send — is
    ever collapsed out of first paint.

- [ ] **UI-03** `plugin` Explicit view state (plans/007 Stage 3)
  - Replace the ordered `if … return` chain in `render()` with a discriminated
    `ViewState` and one exhaustive `switch`; derive it in a pure, unit-tested
    `resolveViewState`. Invitation composer becomes a modal, not a screen.
  - AC: AT3-1…AT3-4 from `plans/007-ui-rebuild.md` green.
  - AC: `ui/onboarding-view.ts` under 250 lines; no file in `ui/screens/` over 200.
  - AC (regression, structural): opening the composer while connected leaves the
    status row rendered — the 1.1.3 defect becomes impossible, not just fixed.
  - AC: `npm run test:e2e` green **without modifying** the e2e suites.

## GITLAB-IMPORT

- Labels: `foundation`, `server`, `plugin`, `sapserver`, `security`, `user-decision`.
- Milestones: `F0`, `F1`, `F2`, `F3`, `F4`, `F5`, `F6`, `F7`, `F8`, `F9`, `SRV`.
- Import: `glab issue create` per row above (title = `Fx-NN: description`, body = AC), or export
  to CSV (`Title,Labels,Milestone,Description`) and `glab issue import` where available.
- Checkboxes in this file remain the source of truth for progress — the tracker import is a copy
  for team visibility management, it doesn't replace checking things off here.
