# Repository cleanup plan

Findings from a sweep of the source repository: 512 tracked files, 43k lines of
non-test TypeScript, a 16 MB `.git`.

## What is already clean

Worth stating, because it narrows the work:

- **Zero** TODO, FIXME, HACK or XXX markers.
- **Zero** `console.log` in production code.
- **Zero** `@ts-ignore` / `@ts-expect-error`.
- **Zero** unused dependencies.
- **Zero** duplicate image files.
- One `it.skip`, and it is correct: the obsidian-typings drift guard skips
  itself when the package is absent, and says so in its own name.

The problems are dead weight and dead exports, not rot.

## A. Orphaned images, ~2.8 MB

Fourteen tracked images that **nothing** references, in any Markdown, HTML or
TypeScript file in the repo:

| Path | Why it is here |
|---|---|
| `design/brand/havemind-devices.{png,svg}` | the drawn mockup the hero GIF replaced |
| `design/brand/havemind-phone.gif` | phone-only cut, exported for the catalogue, never linked |
| `design/brand/havemind-banner.{png,svg}` | superseded by `havemind-banner-white.png` |
| `design/brand/havemind-mark.{png,svg}` | the mark alone, unused since the banner carries it |
| `docs/images/0*.png` (7 files) | screenshots, used by the DISTRIBUTION repo, which keeps its own copies in `assets/` |

**Action.** Delete `havemind-devices.*` outright: it is superseded work.
Keep the rest but say what they are for, because "unreferenced" and "unwanted"
are not the same thing: the brand marks and the screenshots are source assets
that other repos and future READMEs consume. Add `design/brand/README.md` and
`docs/images/README.md`, one paragraph each, naming what consumes them. An
asset nobody can explain is the one that gets deleted by mistake later.

## B. `obsidian-adapters.ts`, a barrel of 19 re-exports

140 lines that re-export from other modules. Knip flags 8 unused values and
11 unused types in it, which is what a barrel looks like when its consumers
import from source instead.

**Action.** Check each of the 19 for a real importer. Delete the ones nobody
imports; leave the rest. A barrel that exists only for a test's convenience is
worth keeping if a test imports it, and worth deleting otherwise.

## C. 45 unused exports, 60 unused exported types

Knip's full list. These fall into three groups, and only one is worth acting on:

1. **Error classes never caught by name** (`AccessTokenError`,
   `BlobFetchError`, `CreateInvitationError`, `OwnerPairError`,
   `RequestTimeoutError`, `SecretStoreError`, `MigrationError`,
   `ListPendingApprovalsError`). Exported for `instanceof` checks that no
   caller makes. **Narrow to non-exported** where the module throws them
   internally; deleting the class would lose the error type.
2. **Constants exported for tests only** (`REPAINT_WINDOW_MS`,
   `MAX_APPROVAL_ATTEMPTS`, `INVITATION_TTL_SECONDS`,
   `DEFAULT_BUSY_TIMEOUT_MS`, and ~15 more). **Keep.** A test that pins a
   constant is the reason the constant is exported, and knip cannot see that
   as a use. Deleting these would break the tests that guard them.
3. **Genuinely dead** (`pathForEditorView`, `serverNameFromUrl`,
   `decideRemoteApply`, `verifyCheckpointStructure`, `configureDatabase`,
   `gateOwnerConnection`, `renderPaneChrome`). **Delete**, after confirming
   each has no importer and no test.

**Action.** Work group 3 first, one commit, with `npm run verify` between each
deletion. Group 1 second. Group 2 not at all.

## D. 114 `eslint-disable`, all one rule

Every single one is `@typescript-eslint/no-explicit-any`. That is not 114
separate judgements; it is one unmade decision repeated.

**Action.** Sample twenty. If most sit at the same kind of boundary (JSON
parsing, Obsidian's untyped API, SQLite rows), replace the rule with a typed
helper at that boundary and delete the disables it makes unnecessary. If they
are genuinely varied, leave them and stop counting them as debt.

## E. Files knip flagged that are NOT dead

Recorded so a later pass does not delete them:

- `apps/server/healthcheck.js` is the Docker healthcheck
  (`apps/server/Dockerfile:72`, `deploy/compose.yaml:75`).
- `apps/obsidian-plugin/preview/*.ts` back `npm run dev:preview`.
- `design/support.js` is loaded by the two Claude Design handoff HTML files.

Only `scripts/render-attribution-fixture.mjs` has no caller anywhere: no
package script, no workflow, no docs. **Delete it.**

## F. Large source files

Five files over 1000 lines, against a 200-line ceiling this project has held
elsewhere:

| File | Lines |
|---|---|
| `apps/obsidian-plugin/src/main.ts` | 1900 |
| `apps/obsidian-plugin/src/runtime/sync-state.ts` | 1466 |
| `apps/obsidian-plugin/src/onboarding/controller.ts` | 1239 |
| `apps/server/src/auth/invitations.ts` | 1197 |
| `apps/server/src/revision-repository.ts` | 1147 |

**Action.** Not in this pass. Splitting a 1900-line file is a refactor with
real regression risk, and it earns nothing a reader can see today. Note it,
schedule it separately, and do it behind the existing tests.

## G. Three overlapping screenshot documents, 280 lines

`docs/readme-screenshots.md` (108), `docs/screenshot-brief.md` (102) and
`docs/hero-recording.md` (70) all describe the same job: what to capture for
the README. The hero GIF is shot, the stills are shot, and the distribution
README now carries them. The plans outlived the work.

**Action.** Fold the parts still worth keeping (the capture rules: throwaway
vault, dark theme, relative paths, blur the 6-digit code) into a single
`docs/screenshots.md`, and delete the other two. A rule that survives is worth
one page; three pages of superseded planning is worth none.

## H. `docs/multi-vault-plan.md`, status "proposed"

220 lines of a plan whose first line says it is awaiting a decision. The
server already ships multi-vault isolation
(`apps/server/src/auth/multi-vault-isolation.test.ts`).

**Action.** Read it against the code. If it is implemented, replace the file
with a short note saying so and pointing at the tests. If it is genuinely
still proposed, say why it is parked. A plan with no decision attached decays
into noise either way.

## I. What a deeper sweep found clean

Checked and clean, recorded so nobody re-checks:

- **No secrets, anywhere.** `ops/sapserver/restic/restic.env` is tracked but
  holds no credential; it says so in its own header, and the password lives in
  a 0600 file outside the repo.
- **No tailnet hostname** in any tracked file.
- **No broken internal links** across all 65 Markdown files.
- **No empty or zero-byte tracked files.**
- **No test file without assertions.**
- **`.gitignore` is thorough**: build output, databases, env files, keys,
  vault artefacts, and the built `main.js`.
- **Coverage is 90.21% of statements, 92.04% of functions.** The
  `runtime/adapters/` directory has no sibling test files, which first looked
  like a gap; coverage shows it is exercised through `main.*.test.ts`. Not
  debt.
- **The 12 `main.*.test.ts` files** are a deliberate split of one 1900-line
  module's tests, not orphans.

## Order

1. **E** delete `render-attribution-fixture.mjs` (1 file, no risk)
2. **A** delete `havemind-devices.*`, document the rest (2 READMEs)
3. **G** merge three screenshot documents into one
4. **H** resolve or retire the multi-vault plan
5. **C group 3** delete the seven genuinely dead exports
6. **C group 1** narrow the eight error classes
7. **B** prune the barrel
8. **D** sample the disables and decide

Steps 1 to 4 touch no code and are safe. Steps 5 to 7 each run
`npm run verify` before the next. Step 8 may end in "leave it", which is a
valid outcome.

## Not doing

- Splitting the large files (F): separate work, real risk, no visible gain now.
- Deleting constants exported for tests (C group 2): they are used, by tests.
- Rewriting `plan/`: filenames are Polish but every file's content is English,
  which is what rule 7 asks for.
