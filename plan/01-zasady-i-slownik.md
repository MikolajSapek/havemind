# 01 — Hard rules and glossary

This package (`plan/`) closes out Havemind, from the current implementation state (see
`plans/002-pilot-tasks.md`) to a successful seven-day pilot on `sapserver` (Phase 7 of
`plans/001-technical-plan.md`) and the Phase 8 gates. The package is self-contained: the building
agent reads ONLY this folder plus the canonical files listed in `02-fundamenty.md`.

## Hard rules (numbered, enforceable — breaking one = rejected commit/PR)

1. **Canonical data always wins.** Functional requirements live in `specs/00X-*.md`,
   architecture and the technical contract in `plans/001-technical-plan.md`, task status in
   `plans/002-pilot-tasks.md`. This package (`plan/*`) does NOT duplicate their content — it only
   translates them into phases F0–F9 and Fx-NN issues. A conflict between `plan/` and
   `specs/`/`plans/` → `specs/`/`plans/` wins; report it in `DECISIONS.md`.
2. **Red-green-refactor, no exceptions.** A test must fail before the production behaviour exists.
   No issue is done without a test that would genuinely catch it if the behaviour disappeared.
3. **The server is opaque.** `sapserver` (the Havemind process) never computes diff, provenance,
   or content merge — only the client (`sync-core`) does. Don't break this boundary for convenience.
4. **Zero silent overwrites.** No incoming revision/file erases divergent work without an explicit
   conflict visible in `Havemind Conflicts/` and in Activity.
5. **Identity is trusted only from the server session.** `actor_id`/`device_id` never come from
   client request data or proxy headers.
6. **Secrets never go in the repo/logs.** Tokens, invites, private keys, the `sudo` password on
   `sapserver` — never in Markdown, commits, application logs, or in a subagent report's content.
7. **Sapserver: real hardware constraints apply literally.** 16 GB RAM, ~96 GB free disk, no
   `docker` group for the user, no public container ports (see `08-sapserver-operations.md`). No
   architecture proposal may assume these constraints have gone away.
8. **The building agent IS connected to `sapserver` and IS ALLOWED to modify it — a deliberate
   user departure from `plans/001-technical-plan.md` §14 "Ask first: deploy or change
   privileged configuration on sapserver".** This item from the canonical contract is EXPLICITLY
   NARROWED HERE BY THE USER (decision recorded in this package's `README.md` "Open decisions"),
   not revoked outright: in this package's practice, "privileged configuration" means EXCLUSIVELY
   the items listed in rule 9, not every config change. The `ssh sapserver` connection (Tailscale,
   a verified tailnet IP) is verified and stands open — this is not a hypothetical deployment target,
   but a real machine on which the agent can independently install, configure and run Havemind
   services within the rules from `08-sapserver-operations.md` (no passwordless sudo configuration, no adding
   itself to the `docker` group, no publicly exposing ports). There is no need to ask the user
   before every `docker compose up` on `sapserver`. The exceptions that still require asking the
   user are listed in rule 9 — if any of them arises, rule 9 overrides rule 8.
9. **Gates that, despite rule 8, always require asking the user:** connecting a real
   (non-disposable) vault; any operation requiring the `sudo` password on `sapserver` (the agent
   does not know this password and cannot obtain it — it must ask the user to perform the step
   manually); enabling Tailscale Funnel or any other public exposure; changing the approved
   encryption/trust model; opening the repository publicly / a GitHub Release / submitting to
   Obsidian; irreversible operations (deleting a backup, `docker compose down --volumes`,
   `restic forget --prune` without a prior `restic check`); PUSH to a remote repository
   (`git push`, `gh pr create`, anything visible outside the local clone).
   **A local `git commit` in the Havemind repo IS AN EXCEPTION to the default global rule
   "don't commit without asking" — the user explicitly lifted this requirement for this
   package's `/loop` loop (one commit per issue, per `10-MASTER-PROMPT.md` rule 1-2), because
   without it the orchestrator+subagent architecture from `loopstart` would be unworkable. This
   exception does NOT cover push or any other operation visible outside the local repo — those
   still require asking as above. If a fresh session inherits a global CLAUDE.md with a "don't
   commit without asking" rule, this paragraph is its explicit, documented override for THIS
   repository.**
10. **This package's build methodology = the `loopstart` skill.** This folder, `MASTER-PROMPT.md`
    and `BACKLOG.md` were produced using the `loopstart` skill (sent over by a friend,
    `~/Downloads/SKILL (1).md`). If the backlog needs rebuilding during the build, the phases need
    re-cutting, or Phase 8 needs planning (follow-up plans after the pilot), use `/loopstart`
    again rather than manually tacking tasks onto the existing `BACKLOG.md`.

## Glossary of terms (use ONLY these names throughout the rest of the package's files)

- **`revision envelope`** — the three-part revision envelope: `client_protected_header` (plain),
  `opaque_payload` (plaintext during the pilot, ciphertext after E2EE), `server_receipt` (issued
  once durably accepted). Full definition: `plans/001-technical-plan.md` §7.
- **`sync-core`** — a pure TypeScript package with no dependency on Obsidian/DOM/SQLite/HTTP;
  computes canonicalisation, hashes, provenance, recipes, the revision DAG, and merges.
- **`disposable pilot vault`** — one of the two disposable test vaults used for Phases 5–7; never
  real notes.
- **`Havemind Conflicts/`** — a reserved, visible folder holding conflict artefacts, generated
  locally, not editable as a source of truth.
- **`sapserver`** — the physical homelab machine (Ubuntu 24.04.4, i5-8600K, 16 GB RAM, 120 GB
  NVMe), the only deployment target for the Havemind server in this package. Reachable via
  `ssh sapserver`.
- **`orchestrator`** — the main session driving `BACKLOG.md`; does not implement issues itself.
- **`executing subagent`** — a fresh agent spawned for a single Fx-NN issue, returning a short
  report per the contract in `10-MASTER-PROMPT.md`.
- **`Fx-NN`** — issue identifier: `x` = phase number (0–n), `NN` = number within the phase.
- **`decision gate` (F8)** — a phase before which the loop ALWAYS stops and asks the user,
  regardless of rule 8 (see rule 9).

## Honesty as a feature

- The absence of E2EE in the pilot is explicitly flagged on every UI surface (`Synced` on
  disposable data, never a suggestion of real-vault-grade security).
- Backup on `sapserver` currently does NOT exist (per the state of the "Sapserver — dostęp i
  konfiguracja" note, "Następne kroki" section) — treated as missing work blocking Phase 7, not
  an oversight.
- Hardware constraints (120 GB, no GPU drivers) are stated explicitly in
  `08-sapserver-operations.md`, not hidden behind "sufficient resources".
