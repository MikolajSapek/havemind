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
- [ ] **T032 gate**: two disposable vault names + machines + 7-day window —
  awaiting user decision.

## Daily log (fill during the 7-day pilot)

| Day | Date | `df -h /` | Sync status | Incidents |
|-----|------|-----------|-------------|-----------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
