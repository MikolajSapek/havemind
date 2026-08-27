# Havemind private-pilot task breakdown

- Status: **Approved for uninterrupted local execution on 2026-07-15**
- Parent plan: `001-technical-plan.md`
- Scope: disposable Markdown vault pilot only; no real vault, public release or E2EE claim

Every behavior task follows red-green-refactor. A task is complete only after its listed verification succeeds and the diff is reviewed.

_Checkbox status for T002, T018–T022 and T025–T031 synced from `plan/11-BACKLOG.md` (source of truth per that file) on 2026-08-07._

## Foundation

- [x] **T001, Create root workspace metadata**
  - Acceptance: Apache-2.0 license, npm workspace metadata, ignore rules and root commands are present; no secret or machine-specific path is tracked.
  - Verify: `npm install --package-lock-only && npm run check:workspace`
  - Files: `package.json`, `package-lock.json`, `.gitignore`, `LICENSE`, `README.md`

- [x] **T002, Configure strict TypeScript, lint and Vitest**
  - Acceptance: all workspaces inherit strict settings; coverage thresholds are 80%; lint rejects unsafe TypeScript basics.
  - Verify: `npm run typecheck && npm run lint && npm test`
  - Files: `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `scripts/check-workspace.mjs`

- [x] **T003, Scaffold the public protocol package**
  - Acceptance: package exports version constants, stable error codes and a typed discovery schema; invalid version ranges fail validation.
  - Verify: first observe a failing test, then `npm test --workspace @havemind/protocol`
  - Files: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`, `packages/protocol/src/version.ts`, `packages/protocol/src/version.test.ts`

## Canonical contracts and sync-core

- [x] **T004, Canonicalize Markdown and paths**
  - Acceptance: LF, NFC, UTF-16 length, reserved paths and collision keys follow the plan; traversal/control/absolute paths are rejected.
  - Verify: `npm test --workspace @havemind/protocol -- canonicalization`
  - Files: `packages/protocol/src/canonicalization.ts`, `packages/protocol/src/canonicalization.test.ts`, `packages/protocol/src/index.ts`

- [x] **T005, Define revision envelope and payload schemas**
  - Acceptance: protected header, opaque blob receipt, inner payload, reconstruction recipe and required semantics validate independently; receipt-only fields cannot enter protected input.
  - Verify: `npm test --workspace @havemind/protocol -- revision-schema`
  - Files: `packages/protocol/src/revision-schema.ts`, `packages/protocol/src/revision-schema.test.ts`, `packages/protocol/src/index.ts`

- [x] **T006, Implement canonical hashing and byte identity**
  - Acceptance: canonical header serialization and SHA-256 vectors are stable across property order and Unicode; blob and plaintext hashes are distinct types.
  - Verify: `npm test --workspace @havemind/protocol -- hashing`
  - Files: `packages/protocol/src/hashing.ts`, `packages/protocol/src/hashing.test.ts`, `packages/protocol/src/index.ts`

- [x] **T007, Scaffold pure sync-core and provenance runs**
  - Acceptance: provenance run invariants reject gaps/zero lengths; initial import exactly covers normalized UTF-16 content.
  - Verify: `npm test --workspace @havemind/sync-core -- provenance`
  - Files: `packages/sync-core/package.json`, `packages/sync-core/tsconfig.json`, `packages/sync-core/src/provenance.ts`, `packages/sync-core/src/provenance.test.ts`, `packages/sync-core/src/index.ts`

- [x] **T008, Build reconstruction recipes**
  - Acceptance: source ranges plus literals reproduce snapshots exactly; invalid parent/range/version is quarantinable; Unicode and repeated-text fixtures are deterministic.
  - Verify: `npm test --workspace @havemind/sync-core -- recipe`
  - Files: `packages/sync-core/src/recipe.ts`, `packages/sync-core/src/recipe.test.ts`, `packages/sync-core/src/fixtures/recipe-fixtures.ts`, `packages/sync-core/src/index.ts`

- [x] **T009, Generate deterministic edit recipes**
  - Acceptance: selected diff implementation produces stable recipes for insert/replace/delete, multiline Markdown and repeated text; generated recipe round-trips before upload.
  - Verify: `npm test --workspace @havemind/sync-core -- diff-recipe`
  - Files: `packages/sync-core/src/diff-recipe.ts`, `packages/sync-core/src/diff-recipe.test.ts`, `packages/sync-core/src/index.ts`

- [x] **T010, Track revision DAG and CAS heads**
  - Acceptance: idempotent replay, ID reuse, stale branches, exact-head reconciliation CAS, cycles and topological batches match protocol invariants.
  - Verify: `npm test --workspace @havemind/sync-core -- revision-dag`
  - Files: `packages/sync-core/src/revision-dag.ts`, `packages/sync-core/src/revision-dag.test.ts`, `packages/sync-core/src/index.ts`

- [x] **T011, Implement clean merge and explicit conflicts**
  - Acceptance: non-overlapping edits merge with source provenance; same-line, edit/delete, rename/rename and path collisions preserve all heads and require resolution.
  - Verify: `npm test --workspace @havemind/sync-core -- merge`
  - Files: `packages/sync-core/src/merge.ts`, `packages/sync-core/src/merge.test.ts`, `packages/sync-core/src/path-ownership.ts`, `packages/sync-core/src/path-ownership.test.ts`, `packages/sync-core/src/index.ts`

- [x] **T012, Model durable two-client synchronization**
  - Acceptance: push retry, durable inbox/outbox, separate download/materialization states and restart recovery converge without losing an accepted revision.
  - Verify: `npm test --workspace @havemind/sync-core -- client-model`
  - Files: `packages/sync-core/src/client-model.ts`, `packages/sync-core/src/client-model.test.ts`, `packages/sync-core/src/index.ts`

- [x] **T013, Add property/model safety tests**
  - Acceptance: randomized Unicode edits, partitions, duplicates and delivery reorder preserve DAG/provenance invariants for two clients.
  - Verify: `npm test --workspace @havemind/sync-core -- model-property`
  - Files: `packages/sync-core/src/model-property.test.ts`, `packages/sync-core/src/model-generators.ts`

## Server vertical slice

- [x] **T014, Scaffold Fastify server and safe configuration**
  - Acceptance: validated config, redacted logger, discovery/readiness routes and bounded JSON defaults work with no public listener assumption.
  - Verify: `npm test --workspace @havemind/server -- app`
  - Files: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/app.ts`, `apps/server/src/config.ts`, `apps/server/src/app.test.ts`

- [x] **T015, Add SQLite schema and controlled migrations**
  - Acceptance: required PRAGMAs, checksum-recorded migrations, single-writer lock and newer-schema refusal pass temporary-database tests.
  - Verify: `npm test --workspace @havemind/server -- migrations`
  - Files: `apps/server/src/db.ts`, `apps/server/src/migrations.ts`, `apps/server/src/migrations/001-initial.sql`, `apps/server/src/migrations.test.ts`

- [x] **T016, Implement durable content-addressed blobs**
  - Acceptance: server hash, same-filesystem temp, fsync/rename/directory-fsync and existing-blob verification survive injected crash points.
  - Verify: `npm test --workspace @havemind/server -- blob-store`
  - Files: `apps/server/src/blob-store.ts`, `apps/server/src/blob-store.test.ts`, `apps/server/src/faults.ts`

- [x] **T017, Persist revisions, events and CAS heads atomically**
  - Acceptance: revision/parent/head/event/idempotency/cursor transaction passes duplicate, ID-reuse, stale-parent, exact-head and missing-blob tests.
  - Verify: `npm test --workspace @havemind/server -- revision-repository`
  - Files: `apps/server/src/revision-repository.ts`, `apps/server/src/revision-repository.test.ts`, `apps/server/src/db.ts`

- [x] **T018, Implement local owner setup and token primitives**
  - Acceptance: local-only initialization, one-time owner pairing, token hashing, crash-safe rotation/retry and family-reuse revocation pass tests.
  - Verify: `npm test --workspace @havemind/server -- auth`
  - Files: `apps/server/src/auth/tokens.ts`, `apps/server/src/auth/setup.ts`, `apps/server/src/auth/tokens.test.ts`, `apps/server/src/auth/setup.test.ts`, `apps/server/src/db.ts`

- [x] **T019, Implement invitations and device approval**
  - Acceptance: 256-bit/15-minute/single-use invites create a data-blind pending device; owner phrase approval is scoped and race-safe; revocation works.
  - Verify: `npm test --workspace @havemind/server -- invitations`
  - Files: `apps/server/src/auth/invitations.ts`, `apps/server/src/auth/invitations.test.ts`, `apps/server/src/auth/verification-phrase.ts`, `apps/server/src/auth/verification-phrase.test.ts`

- [x] **T020, Add deny-by-default auth API**
  - Acceptance: refresh, invitation and device routes validate schemas, ignore spoofed identity headers and block unauthenticated/cross-vault/IDOR requests.
  - Verify: `npm test --workspace @havemind/server -- auth-routes`
  - Files: `apps/server/src/auth/context.ts`, `apps/server/src/auth/routes.ts`, `apps/server/src/auth/routes.test.ts`, `apps/server/src/app.ts`

- [x] **T021, Add versioned sync push/pull API**
  - Acceptance: bounded topological batches, required semantics, CAS errors, cursor pagination and byte-exact blob retrieval pass contract tests.
  - Verify: `npm test --workspace @havemind/server -- sync-routes`
  - Files: `apps/server/src/sync/routes.ts`, `apps/server/src/sync/routes.test.ts`, `apps/server/src/app.ts`, `apps/server/src/revision-repository.ts`

- [x] **T022, Add backup, restore and server epoch**
  - Acceptance: Online Backup snapshot plus blob manifest restores to an empty directory, verifies integrity/hashes and changes epoch so stale clients reconcile.
  - Verify: `npm test --workspace @havemind/server -- backup-restore`
  - Files: `apps/server/src/operations/backup.ts`, `apps/server/src/operations/restore.ts`, `apps/server/src/operations/backup-restore.test.ts`, `apps/server/src/db.ts`

## Obsidian plugin vertical slice

- [x] **T023, Scaffold a loadable desktop plugin**
  - Acceptance: valid manifest, minimal `main.js`, settings/ribbon/status/view/editor/preview registrations and complete unload cleanup build without Node runtime APIs.
  - Verify: `npm run build --workspace @havemind/obsidian-plugin && npm test --workspace @havemind/obsidian-plugin -- lifecycle`
  - Files: `apps/obsidian-plugin/package.json`, `apps/obsidian-plugin/tsconfig.json`, `apps/obsidian-plugin/manifest.json`, `apps/obsidian-plugin/src/main.ts`, `apps/obsidian-plugin/src/main.test.ts`

- [x] **T024, Implement local connection and secret stores**
  - Acceptance: namespaced IndexedDB durable stores and SecretStorage reference lifecycle cover blocked upgrade, quota failure, rotation-pending and disconnect behavior.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- storage`
  - Files: `apps/obsidian-plugin/src/storage/client-store.ts`, `apps/obsidian-plugin/src/storage/client-store.test.ts`, `apps/obsidian-plugin/src/storage/secret-store.ts`, `apps/obsidian-plugin/src/storage/secret-store.test.ts`

- [x] **T025, Implement safe invitation onboarding**
  - Acceptance: fragment-based landing plus secure copy/import envelope, query-secret-free deep-link wizard opening, HTTPS discovery, review, pending-device phrase and resumable bootstrap work without exposing a token in logs/settings.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- onboarding`
  - Files: `apps/obsidian-plugin/src/onboarding/invite.ts`, `apps/obsidian-plugin/src/onboarding/invite.test.ts`, `apps/obsidian-plugin/src/onboarding/controller.ts`, `apps/obsidian-plugin/src/onboarding/controller.test.ts`

- [x] **T026, Observe and reconcile local Vault state**
  - Acceptance: startup scan plus create/modify/rename/delete produce durable deduplicated operations; reserved paths and deleted-content snapshot behavior are correct.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- vault-adapter`
  - Files: `apps/obsidian-plugin/src/obsidian/vault-adapter.ts`, `apps/obsidian-plugin/src/obsidian/vault-adapter.test.ts`, `apps/obsidian-plugin/src/sync/reconciliation.ts`, `apps/obsidian-plugin/src/sync/reconciliation.test.ts`

- [x] **T027, Run durable push/pull and safe remote apply**
  - Acceptance: single-flight/backoff, expected hashes, multiple-open-buffer checks, durable editor confirmation, echo suppression, quarantine and cursor recovery work with fake vault/API.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- sync-runner`
  - Files: `apps/obsidian-plugin/src/sync/sync-runner.ts`, `apps/obsidian-plugin/src/sync/sync-runner.test.ts`, `apps/obsidian-plugin/src/obsidian/remote-apply.ts`, `apps/obsidian-plugin/src/obsidian/remote-apply.test.ts`

- [x] **T028, Implement Activity, diff and restore UI model**
  - Acceptance: local validated payloads and receipts produce safe Activity entries/diffs; restore creates a revision; delete/conflict/device events are accessible.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- activity`
  - Files: `apps/obsidian-plugin/src/activity/model.ts`, `apps/obsidian-plugin/src/activity/model.test.ts`, `apps/obsidian-plugin/src/activity/view.ts`, `apps/obsidian-plugin/src/activity/view.test.ts`

- [x] **T029, Implement author overlay**
  - Acceptance: UTF-16 provenance maps through public CodeMirror state/effects, visible ranges only, hash mismatch hides attribution and Reading View never guesses missing sections.
  - Verify: `npm test --workspace @havemind/obsidian-plugin -- attribution`
  - Files: `apps/obsidian-plugin/src/attribution/editor-extension.ts`, `apps/obsidian-plugin/src/attribution/editor-extension.test.ts`, `apps/obsidian-plugin/src/attribution/reading-view.ts`, `apps/obsidian-plugin/src/attribution/reading-view.test.ts`

## Packaging and private pilot

- [x] **T030, Build hardened local Compose package**
  - Acceptance: non-root/read-only/cap-drop stack, no default public port, file secrets, health checks and pinned image build pass configuration tests.
  - Verify: `npm run compose:smoke`
  - Files: `apps/server/Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example`, `scripts/compose-smoke.mjs`, `.dockerignore`

- [x] **T031, Add end-to-end two-client fault harness**
  - Acceptance: real server plus two simulated clients passes create/update/rename/delete/restore, offline partitions, duplicate delivery, crash recovery, conflicts and epoch reset.
  - Verify: `npm run test:e2e`
  - Files: `tests/e2e/two-client.test.ts`, `tests/e2e/fault-matrix.ts`, `tests/e2e/helpers.ts`, `vitest.e2e.config.ts`

- [x] **T032, Document and execute private disposable-vault pilot**
  _Closed 2026-08-07 (user decision) with recorded deviations, see "Pilot closure" in `docs/pilot/checklist.md`. Backup stays open as the pre-1.0 release gate._
  - Acceptance: server setup, diagnostics, backup/restore and two real Obsidian vaults pass the manual matrix; observed results and known limitations are recorded.
  - Verify: `npm run verify && npm run compose:smoke`, then complete `docs/pilot/checklist.md`
  - Files: `docs/pilot/setup.md`, `docs/pilot/checklist.md`, `docs/operations/backup-restore.md`, `README.md`

## Follow-up gates

- [x] **T033, Prepare separate plans after pilot success**
  _Closed 2026-08-07: all four plans exist. 003 (GitHub/BRAT) executed de facto (distribution repo live); 004 E2EE and 006 encrypted checkpoints de-scoped by user decision (tailnet-only security model); 005 attachments partially executed (binary sync shipped; per-vault quota accounting remains open)._
  - Acceptance: independent reviewed plans exist for GitHub/BRAT alpha, E2EE/recovery, attachments/quota and encrypted checkpoint/retention work.
  - Verify: each plan links its spec, threat model, acceptance tests and rollout/rollback gate.
  - Files: new files under `plans/`; no production code in this task
