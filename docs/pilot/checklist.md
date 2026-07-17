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
  `https://sapserver.tail48b326.ts.net` — `/healthz` and discovery verified
  from a second tailnet machine. Ops notes: fresh named volume needed a
  one-time host-side `chown 1000:1000` on `_data` (cap_drop blocks in-container
  chown); CLI must be invoked via `apps/server/bin/havemind.js` (dist/cli.js is
  a library). Dockerfile fix queued so future deploys skip the chown.

## Daily log (fill during the 7-day pilot)

| Day | Date | `df -h /` | Sync status | Incidents |
|-----|------|-----------|-------------|-----------|
| 1 | 2026-07-16 | /dev/nvme0n1p2  109G  8.5G   95G   9% / | Owner device connected — green Synced; /owner/pair 200, /auth/refresh 200, events polling 200 | F8-02f fixes deployed (rotationId, terminal-401, live panel) |
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
