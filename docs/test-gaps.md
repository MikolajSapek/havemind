# Test coverage — what is verified, and what only looks verified

Audit date: 2026-08-23, after the pane redesign (plans/007 Phases A–F).

Headline: the test suite is strong — 1760 unit tests, 28 two-device e2e, and
every server module carries tests. The gaps below are not missing tests so much
as **missing measurement**: large parts of the plugin are well covered and
nobody is checking that they stay that way.

---

## 1. The coverage gate measures a third of the plugin

`apps/obsidian-plugin/vitest.config.ts` scopes coverage to:

```
include: ['src/main.ts', 'src/runtime/**', 'src/storage/**']
```

Everything else is invisible to the 80% threshold. Measured directly, those
directories hold:

| Directory | Lines | Measured by the gate? |
|---|---:|---|
| `src/ui/` | 2167 | no |
| `src/sync/` | 1989 | no |
| `src/onboarding/` | 1445 | no |
| `src/attribution/` | 821 | no |
| `src/obsidian/` | 748 | no |
| `src/activity/` | 345 | no |

That is **7515 lines outside the gate** — including the whole pane redesign.

The `include` list dates from the initial commit (`1d97013`), when those
directories did not exist. It was never widened as the plugin grew.

**The code is not untested.** Measured on demand:

- `src/ui/**` → 88.1% statements, 84.9% branches
- `src/onboarding|sync|attribution|activity|obsidian` → 90.9% statements

Both clear the 80% threshold today. The risk is that nothing would notice if
they stopped.

**Fix:** widen `include` to `src/**` with explicit exclusions for the platform
glue already excluded (`runtime/obsidian-adapters.ts`, `runtime/adapters/**`,
`src/test/**`). Do it as its own change, so a threshold failure is attributable.

## 2. CI never runs the coverage gate

`.github/workflows/ci.yml` runs build, typecheck, lint and test. It does not run
`test:coverage`.

The phase Definition of Done in `plan/11-BACKLOG.md` requires "80%+ coverage
threshold maintained", and every phase report cites a coverage number — but the
number is produced by hand, on demand, and nothing enforces it between reports.

**Fix:** add a coverage step to CI. Note it currently fails (see 3), so fix that
first or the step lands red.

## 3. `npm run test:coverage` is red right now

```
FAIL packages/crypto/src/vault-crypto.test.ts
  > round-trips a >1 MB payload (size/perf sanity)
  Test timed out in 10000ms
```

Not a code defect: the same suite passes in 4.07s without instrumentation. V8
coverage instrumentation over libsodium's WASM is simply slow enough to blow the
10s default on a 1.5 MB payload.

**Fix:** give that one test an explicit timeout rather than raising the global
one — the global default is a useful smoke alarm for accidental hangs.

## 4. Modules whose only exercise is indirect

These render correctly in view tests but have no test that names them, so a
regression reports as a failure somewhere else and has to be traced back:

- `ui/pane-header.ts` (72 lines) — overflow menu, new in Phase A
- `ui/pane-footer.ts` (77) — authorship toggle; **50% function coverage**, the
  weakest measured file in `ui/`
- `ui/entry-chooser-section.ts` (118) — the chooser, new in Phase B
- `ui/activity-section.ts` (70) — shared by the pane and the legacy view
- `ui/conflict-modal.ts` (137) — the resolve modal
- `ui/roster-section.ts` (126)
- `ui/send-queue-section.ts` (84)

`pane-footer` is the one worth a direct test first: half its functions are never
called under test, and it carries the authorship toggle — an accessibility
surface (`aria-pressed`) that must not regress silently.

## 5. Things no automated test can settle

Recorded so they are decided rather than forgotten:

- **The dark pass (design 1g).** The 7% → 12% conflict wash is a judgement about
  what the eye reads on a dark surface. Needs looking at, in both themes, at
  258px and at a comfortable width.
- **The handshake, end to end.** Two real devices, one code read aloud. The unit
  tests pin the wording and the grouping; they cannot tell you whether the
  ceremony works between two people in a room.
- **Proof-of-life after a restart.** The calm pane says "Last change 4 min ago",
  but `ActivityLog` is in-memory and rebuilds on every start, so a reloaded pane
  reads "none yet". Either that is acceptable or the log needs a durable tail —
  a product decision, still open (see `design/pane-redesign/IMPLEMENTATION-PLAN.md`).

## Suggested order

1. Give the crypto perf test its own timeout — unblocks everything else.
2. Widen the coverage `include`, on its own commit.
3. Add the coverage step to CI, now that it can pass.
4. Direct test for `pane-footer`, then the other Phase A/B modules.
5. Look at the dark pass by eye; run one real two-device handshake.
