# 02 — Shared foundations

## Canonical data (single source of truth — do not duplicate content)

| Data | Canonical file | Do not duplicate in |
|---|---|---|
| MVP product requirements | `specs/001-mvp.md` | any `plan/*` file |
| Zero-config connection | `specs/002-public-access.md` | " |
| Open-source gates / stage gates | `specs/003-open-source-release.md` | " |
| Architecture, protocol, engineering contract | `plans/001-technical-plan.md` | " |
| T001–T033 task status | `plans/002-pilot-tasks.md` | `11-BACKLOG.md` only MAPS Txxx → Fx-NN, doesn't rewrite the content |
| Research on existing solutions | `docs/research.md` | — |
| Sapserver access, hardware, network, Docker, backup | the operator's private setup note (outside this repo) | `08-sapserver-operations.md` cites the numbers, doesn't guess |

The building agent reads the files above BEFORE each phase they concern — not from the planning
session's memory.

## Workspace conventions (from `plans/001-technical-plan.md` §5–6, unchanged)

- Node.js 22 LTS, npm workspaces (npm 10), TypeScript 6.0 strict.
- Vitest 4.1, 80% coverage threshold (statements/branches/functions/lines) in production packages.
- Root commands: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:coverage`, `npm run dev:server`, `npm run dev:plugin`,
  `npm run compose:smoke`. (`npm run test:integration` removed from `package.json` as dead code —
  `tests/integration/` never existed, so it always silently passed; CI hardening, roadmap P1 #6.)
- Dependencies flow one way only: `protocol <- sync-core <- obsidian-plugin`, `protocol <- server`.
  The plugin and server never import each other.
- No React, Redis, PostgreSQL, message broker, or ORM in the MVP.

## Sapserver conventions as canonical data (not architecture — physical fact)

- Service directories: `/srv/compose/<service>/compose.yaml`, `/srv/appdata/<service>/`,
  secrets only in `/srv/secrets` or `0600` files.
- Application port: only `127.0.0.1:8787` (never `0.0.0.0`), access via Tailscale Serve.
- User `mikolaj` is NOT in the `docker` group — administrative commands go through `sudo`,
  performed knowingly by the user when a password is required (see `01-zasady-i-slownik.md`
  rule 9).
- UFW: `22/tcp` only from `192.168.254.0/24` and the `tailscale0` interface; no rules for other
  ports until they are explicitly added as part of a specific issue.

## Hidden work (S8) added to the input — without this the backlog stalls halfway

1. Sapserver backup (Restic) — doesn't exist, blocks T032 (see `08-sapserver-operations.md`).
2. Bootstrap of orchestrator context measurement (`~/.claude/context-usage.txt`) — see
   `10-MASTER-PROMPT.md`.
3. `.env.example` with no working secrets + a strong-secret generator on `havemind setup`.
4. `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` — required before the
   public alpha (`specs/003-open-source-release.md`), not required before the private pilot —
   added to Phase 8, not Phase 0-7, so as not to block the pilot.
5. Diagnostics with no secret leakage (`havemind doctor` or an equivalent command) — required
   before T032.
6. Backup-recovery test on a clean machine (not just documentation) — required before T032.
7. Tailscale update on the server (Sapserver checklist, "Następne kroki") — minor, but blocks
   the pilot if the new version fixes a CVE; check before the pilot.
8. Autostart after a power failure in BIOS — without this the 7-day pilot won't survive a power
   outage.

## Verification of external facts

- SSH addresses/fingerprints, ports, package versions from `plans/001-technical-plan.md` §5 —
  treated as locked as of the approval date (2026-07-15); before T030, check `npm outdated` and
  dependency security (`npm audit` / a container scan) — don't assume the versions haven't
  changed.
- The state of the Sapserver checklist in the Obsidian note may be stale relative to the build
  date — before the "Sapserver operations" phase, the agent must re-read the note (`ssh sapserver`
  plus the commands in its "Przydatne polecenia" section), not rely solely on this package.
