# 08 — Sapserver operations

A phase parallel to F7/F8, but with a separate blocker: **the backup must be ready BEFORE
T032**, not in parallel with it (see `01-zasady-i-slownik.md` rule 8-9). The figures below come
from the operator's private setup note (outside this repo) — re-verify them
(`ssh sapserver` plus the commands in that note's "Przydatne polecenia" section) before starting
this phase, since the note may have changed since its last update.

## The building agent is connected to the server and is allowed to modify it

- Connection verified: `ssh sapserver` (Tailscale, the server's tailnet IP) from the MacBook; alias
  `sapserver-lan` (a static LAN address) as a fallback on the home network.
- The agent (Claude Code / Codex, under the same trust model as the "CLI agent access" section
  of the operator's private Sapserver note) MAY independently: connect via SSH, diagnose service
  state, create Compose files in `/srv/compose/havemind/`, run `docker compose up/down` (via
  `sudo`, knowingly, within a single session), configure Tailscale Serve for the Havemind
  service, edit files in `/srv/appdata/havemind` following the service-per-directory convention.
- The agent MAY NOT, without asking the user: perform steps that require the `sudo` password
  (it doesn't know the password — it must ask the user to type it in interactively, or perform
  the step itself), enable Tailscale Funnel, add itself/the user `mikolaj` to the `docker`
  group, delete backups or run `restic forget --prune` without a prior `restic check`, change
  UFW rules beyond what's explicitly in the issue, or expose any port on `0.0.0.0`.
- This is NOT a hypothetical deployment target from a "pick one" list — it's the only server on
  which Havemind will actually run in Phase 7.

## Hardware state and constraints (numbers, not adjectives)

- CPU i5-8600K / 6 cores, 16 GB RAM (15.9 GB in practice), GPU GTX 1070 unused at this stage.
- System disk: 120 GB NVMe, ~109 GB system partition, ~96 GB free at the last check.
  Budget: the Havemind container + SQLite + blob store must fit comfortably within this space;
  if the projected pilot data size exceeds ~20 GB, stop and ask the user before continuing (the
  disk is shared with the system and other experiments).
- Network: Wi-Fi only (`wlp4s0`) currently — the note's Stage 4 plan (Ethernet) is NOT a
  prerequisite for this phase, but note in `DECISIONS.md` if Wi-Fi stability affects the outcome
  of the seven-day pilot.

## This phase's issues (numbered in `11-BACKLOG.md`, prefix `SRV-`)

| Issue | Description | Blocks |
|---|---|---|
| SRV-01 | Update Tailscale on the server to the latest version | F8 (pilot) |
| SRV-02 | Choice of backup location (USB / NAS / Backblaze B2) — user decision | SRV-03 |
| SRV-03 | Deploy Restic: encrypted repo, retention 7 daily / 4 weekly / 6 monthly | T032 (hard blocker) |
| SRV-04 | Single-file restore test from Restic | SRV-03 → T032 |
| SRV-05 | Full-service (Havemind) restore test from Restic onto a clean instance | T032 |
| SRV-06 | Test Docker page on `127.0.0.1:8080` + Tailscale Serve (dry run before the real service) | F7-02 |
| SRV-07 | Confirm/set autostart after a power failure in BIOS | F8 (the 7-day pilot won't survive a power outage without this) |

## Anti-spec (S5)

- No installing Kubernetes/k3s, Portainer, Cockpit, Nginx Proxy Manager, Watchtower, a global
  PostgreSQL/MySQL database "just in case", Samba/NFS without a concrete need, Fail2ban (SSH is
  already restricted by key and Tailscale), an NVIDIA driver/LLM tooling before the AI stage —
  per the "Czego obecnie nie instalujemy" section of the Sapserver note.
- No public port of any kind, except a short, explicitly approved demo via Tailscale Funnel
  (hosting Stage 2, a separate user decision, never private data).
- No adding the user `mikolaj` to the `docker` group.
