# 09 — Pilot (Phase 7) and follow-up gates (Phase 8)

## F8 decision gate (question to the user, mandatory despite rule 8 in `01-zasady-i-slownik.md`)

Before T032 starts, the orchestrator STOPS the loop and asks the user about:
1. Confirmation that SRV-03/04/05 (Restic backup + restore tests) have actually passed, not
   just "are planned".
2. The choice of two disposable test vaults (names/locations on two machines).
3. The time window for the seven-day pilot (when the user can respond to `Conflict`/`Offline`).

## T032 — seven-day pilot (acceptance criteria)

- Server setup, diagnostics (`havemind doctor` or equivalent), off-host backup configured and
  verified BEFORE connecting the first vault.
- Two disposable vaults connected via an invite, both working offline and online.
- Forced network outages (disconnect Wi-Fi on one machine for ≥10 min) → convergence on
  return, zero lost revisions.
- Service restart (`docker compose restart`) during normal operation → clients return to
  `Synced` with no manual intervention.
- Client (Obsidian) restart during editing → no loss of unsaved or saved content.
- Clean restore from backup onto a new instance → clients with an older epoch reconcile
  correctly (see `plans/001-technical-plan.md` §8 "Backup, restore and deployment contract").
- Result recorded in `docs/pilot/checklist.md` (a target file in the Havemind repo, not in
  `plan/`).

## Phase 8 — follow-up gates (don't start without closing T032)

Each follow-up plan is a SEPARATE document in `plans/00X-*.md`, executed sequentially:

| Follow-up plan | Gate required before starting (from `specs/003-open-source-release.md`) |
|---|---|
| GitHub/BRAT alpha (public repo) | Stage 2 checklist: SECURITY.md/CONTRIBUTING.md/CODE_OF_CONDUCT.md/CHANGELOG.md, diagnostics with no secret leakage, quick-start documentation |
| E2EE and recovery kit | `plans/001-technical-plan.md` §10 in full; a dedicated threat-model spike BEFORE implementation; zero custom cryptography |
| Attachments/quota | Atomic binary-version tests + a documented quota policy |
| Encrypted checkpoints/retention | Safe new-device bootstrap defined BEFORE deleting any history |

If the backlog needs rebuilding during Phase 8 (e.g. new sub-phases for E2EE), use the
`loopstart` skill again rather than manually tacking things onto `11-BACKLOG.md` (see
`01-zasady-i-slownik.md` rule 10).

## Risks and controls (carried over + expanded from `plans/001-technical-plan.md` §15)

| Risk | Control |
|---|---|
| Restic backup not ready before T032 | SRV-03/04/05 as a hard blocker, checked explicitly at the F8 gate |
| Power outage during the 7-day pilot | SRV-07 (BIOS autostart) as a prerequisite for F8 |
| 120 GB disk filled during the pilot | Data budget from `08-sapserver-operations.md`, monitored via `df -h /` daily during the pilot |
| Agent performs an operation requiring `sudo` without the user's knowledge | Rule 9 from `01-zasady-i-slownik.md` — hard stop, ask the user |
| Public repo opened before E2EE is ready | Stage gates from `specs/003-open-source-release.md`, enforced in the table above |
