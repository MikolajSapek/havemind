# Pilot checklist (T032 / F8-02)

Pre-pilot confirmations and the daily 7-day pilot log live here
(see `plan/09-pilotaz-i-decyzje.md` for the acceptance criteria).

## Pre-pilot confirmations

- [x] **SRV-07 — BIOS power-loss autostart** (2026-07-16): user physically set
  Advanced → Chipset Configuration → Restore on AC/Power Loss → **Power On**
  on the ASRock Fatal1ty Z370 Gaming-ITX/ac and rebooted; server came back up
  (verified via `ssh sapserver uptime` right after the reboot, Tailscale 1.98.9 alive).
- [x] **SRV-01 — Tailscale updated** (2026-07-16): 1.98.8 → 1.98.9.
- [x] **Password rotation** (2026-07-16): sapserver password rotated after chat
  disclosure (see DECISIONS.md).
- [ ] **Backup**: deferred entirely for the pilot by explicit user decision
  (files only on user's own hardware; see DECISIONS.md). The pilot's
  "restore from backup onto a clean instance" step will use the app-level
  backup CLI (F7-01) locally on the server — this is NOT a full off-host
  backup round-trip and is marked as such.
- [x] **T032 gate — user decision recorded (2026-07-16)**:
  - Vault A: `~/HavemindPilotA` on the user's MacBook (created, 3 test notes).
  - Vault B: `HavemindPilotB` on a friend's MacBook (friend installs Obsidian +
    plugin + Tailscale; will test together with the user).
  - Window: 7 days starting at server deploy; user available to react to
    `Conflict`/`Offline` throughout.
  - Prerequisite for Vault B: friend's device joins the user's tailnet (Tailscale
    device invite / node share) — server is tailnet-only, never public.

- [x] **Server deployed** (2026-07-16): image built on sapserver, container
  `Up (healthy)` (non-root, read-only, cap-dropped), owner initialised,
  `tailscale serve` fronting `127.0.0.1:8787` at
  `https://<server>.<tailnet>.ts.net` — `/healthz` and discovery verified
  from a second tailnet machine. Ops notes: fresh named volume needed a
  one-time host-side `chown 1000:1000` on `_data` (cap_drop blocks in-container
  chown); CLI must be invoked via `apps/server/bin/havemind.js` (dist/cli.js is
  a library). Dockerfile fix queued so future deploys skip the chown.

## Daily log — first attempt (2026-07-16, superseded)

The first window surfaced a cluster of real defects (that is what a pilot is
for): the rename→conflict-cascade bug (fe280d9), 5-min→15 s live sync, the
cold-cache dropped-push race and data.json write-clobber (c31603f), plus the
server cursor-guard and blob read-path perf (fcefe25). Because the build changed
materially, the clean append-only observation window is **restarted** below on
the stabilised build.

| Day | Date | `df -h /` | Sync status | Incidents |
|-----|------|-----------|-------------|-----------|
| 1 | 2026-07-16 | /dev/nvme0n1p2  109G  8.5G   95G   9% / | Owner device connected — green Synced; /owner/pair 200, /auth/refresh 200, events polling 200 | F8-02f fixes deployed (rotationId, terminal-401, live panel) |

## Daily log — clean 7-day window (restart 2026-07-24)

Build under test: plugin `main.js` 864659 B (fe280d9 rename fix + 15 s live
sync + c31603f lifecycle fixes); server = fcefe25 (cursor guard + blob perf),
healthz/readyz OK. Quota (005) and checkpoints (006) are committed but
deliberately NOT deployed — the pilot exercises the stable core only.

| Day | Date | `df -h /` | Sync status | Incidents |
|-----|------|-----------|-------------|-----------|
| 1 | 2026-07-24 | | | | (superseded — real-time push build below) |
| 2 | | | | |
| 3 | | | | |

## Daily log — clean 7-day window (restart 2026-07-25, real-time push)

The 2026-07-24 window was superseded: real-time push (1 s sync) was added,
regressed the owner-connect path, was root-caused and reintroduced cleanly on a
fresh branch, and the whole sync layer was hardened (resilience audit + /loop
bug-hunt to a clean iteration). This is the clean window on the hardened build.

Build under test: plugin `main.js` **889022 B** — real-time push (long-poll
`/wait`, ~1 s) + single-flight refresh rotation + GAP-1 (fail-closed durable
state, no outbox loss) + GAP-3 (fail-closed producer mappings) + GAP-4 (`/wait`
rate-limit exempt) + GAP-5 (durable in-flight rotation) + SecretStorage key
64-char fix. IndexedDB payload store (`db37e96`) is committed but **deliberately
NOT in the pilot build** — deploy after this window with a smoke test.
Server = sapserver image rebuilt from `main` (fc2c21b..a231697): `/wait`
endpoint + wake registry + GAP-4 exemption + prefix-notify + Dockerfile crypto;
005 quota active; healthz OK. Full suite 1245 green; CI green through fc2c21b.

| Day | Date | `df -h /` | Sync status | Incidents |
|-----|------|-----------|-------------|-----------|
| 1 | 2026-07-25 | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |

- [x] **Owner device connected (2026-07-16, day 1)**: Vault A paired over HTTP,
  live sync loop green (server logs: pair 200 -> refresh 200 -> events 200).
- [x] **Vault B (Magda) connected (2026-07-17)**: second device onboarded and
  approved through the unified "Create connection (owner)" panel; Magda's
  status settled on Synced. Onboarding blocker closed — both vaults live.
  Pre-connect DB reset cleared 15 stale invitations + 5 hanging pending
  devices (approved owner devices untouched).
- [x] **Push path fixed and verified live (2026-07-17)**: earlier the client
  never issued POST /revisions (server FILES=REVISIONS=events=0) — root cause
  was the push producer (VaultChangeObserver + reconcileVaultState) never being
  wired into the runtime, plus /owner/pair not returning the owner membershipId.
  Fixed in commit 8796d2c; server rebuilt on sapserver, DB re-onboarded clean,
  owner re-paired. After a save in Vault A the server shows FILES 8 / REVISIONS
  18 / EVENTS 18 — owner push and pre-existing-file enumeration both confirmed.
- [x] **Sync-correctness hardening round (2026-07-17)** — read-only audit found a
  cluster of same-class defects; all fixed (TDD, 648 tests):
  - F1 (5af3506): remote revisions never materialised on the receiver — the prod
    `createRequestUrlFn` dropped `response.text`, so the blob decoder got `''`.
  - F2 (681443c): on-disk overwrite guard (durable per-file base hash) — a remote
    apply to a locally-diverged, closed file now routes to a conflict artifact,
    never a silent overwrite (plan/01 rule 3). Base advances on remote apply /
    convergence, never on push.
  - B (4bf2b46): one oversized/poison revision no longer wedges the whole outbox
    — transport permanent/transient classification, per-item drain, quarantine,
    server per-revision results, client pre-enqueue size guard.
  - F3 (4fd4f8a): content-addressed reconciliation — shared identical files adopt
    the remote fileId and update in place instead of flooding Havemind Conflicts/;
    reconcile scan resilient to one bad file.
  - CLI PIN hardening + owner "device connected" notice (5af3506); A-MVP (9a4cb57):
    non-markdown attachments surfaced as "N not synced (markdown only)" — full
    binary support deferred to F9.
  - ⏭ Requires: server rebuild on sapserver (B changed sync-routes) + plugin swap
    on both devices + clean two-way live test.
- [x] **403 push loop fixed and verified live (2026-07-17, fc1cf9e)**: after the
  hardening round the owner push looped on a mix of 200/403. Root cause: a leaked
  vault-change observer — `ConnectionHandle.stop()` stopped the sync loop but never
  detached the plugin-lifetime vault listeners, so every re-pair left the previous
  producer attached, bound to the OLD memberId/deviceId. Each edit enqueued twice
  (current identity → 200, stale identity → whole-request 403), and 403 was
  classified transient so the runner looped forever. Fix: stop() disposes the
  producer's listeners; transport re-stamps the current identity onto every
  outbound header; 403 is now permanent (quarantine, no loop). After rebuild +
  plugin reload the owner shows clean POST /revisions 200s, no 403.
- [x] **Two-way sync working, verified live (2026-07-17)**: invitee (Magda) push
  (B→A) had never worked because her connection carried users.id as memberId, not
  her active memberships.id (fix 6bfb3fc surfaces membershipId via the approval
  poll). After a clean invitee re-onboard (fresh data.json + latest server build)
  the server shows THREE distinct pushing devices — owner 6d0324f6, old owner
  86acd3c2, and Magda's device 9a798b61 (revs>0). A→B (owner→invitee) was already
  confirmed. Full append-only two-way sync is live. Note: the invitee MUST
  re-onboard from clean state for the fix to take effect — a stale pre-fix
  data.json keeps the old memberId and blocks push.

## Pilot closure (2026-08-07) — T032 closed with recorded deviations

- [x] **Pilot outcome: PASSED (user decision, 2026-08-07).** Real-world usage from
  2026-07-25 to 2026-08-07 across two devices (owner laptop + second computer,
  plus invitee testing in July). Zero data loss throughout — including during
  three real incidents, which are exactly what the pilot existed to catch:
  1. Real-time push regression (2026-07-24) — rolled back to build 864652,
     re-landed fixed.
  2. Activity-feed flood on fresh-device bootstrap — fixed (fef6a2e).
  3. Corrupt data.json on the second computer (2026-08-04) — recovered manually;
     connect-time detection + reset UI shipped in f55d140.
- **Recorded deviations from the formal AC:**
  - Daily `df -h` log holds 4/7 entries — the window restarted with each redeploy
    (07-16, 07-24, 07-25) and the server was rebuilt fresh on 2026-08-04 during
    audit remediation. Disk pressure was never observed; the disk-pressure guard
    shipped in the meantime.
  - Backup remains deliberately deferred (user decision) — release gate before
    1.0, tracked in known-limitations (AUD-10).
- Post-pilot state: server healthy (healthz ok, 2026-08-07), `main` at 741ad72
  with the P1/P2 hardening batch. The project exits pilot mode into normal
  operation.
