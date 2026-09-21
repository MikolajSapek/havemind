# Client state growth and measured anomalies

Investigated on `fix`, based on `0e736ed` (1.5.0). The supplied desktop brief is
the source of the live measurements. This work does not change the server,
publish a release, or merge `fix` into `dev` or `main`.

## 1. Producer mappings can lose their payloads, but recovery cannot

Implemented a metadata-only `LocalFileMapping`: identity, path, collision key,
hash, and optional content kind. The producer parser accepts old and new
documents. Valid legacy mappings are compacted through the plugin data mutex
on load, including on an unchanged vault. Malformed mapping documents are not
compacted by this migration. Repository saves strip transient snapshot fields,
including when replaying a legacy recovery record.

Answers to the brief's questions:

1. `previousContent` has no production consumer. Removed it. The repository
   cannot establish whether someone intended a future feature, but no current
   contract requires retaining this unused hook.
2. Recovery must use the exact committed snapshot in its durable transaction
   journal when seeding a missing base. Current disk contents may be newer or
   gone; `baseContents` itself may not yet have been written. Neither is a
   sufficient replacement for that journal snapshot.
3. The snapshot is load-bearing while a commit is unfinished, not as a permanent
   copy in every producer mapping. New forward-commit journals explicitly retain
   the operation's markdown text. Replay still preserves an existing ancestor,
   finishes an interrupted hash/content pair, and restores ownership before
   clearing the journal. Apply rollback still uses its saved `applyState`.
   Binary recovery needs identity and hash, not a text ancestor.

The original usage inventory missed startup reconciliation: both its unchanged
comparison and offline rename matching read mapping content. These now compare
hashes, with a content-kind discriminator for rename matching. Binary hashes
are over raw bytes; markdown/config uses the existing normalization rules.

Head reconciliation now reads disk text only when its hash matches the recorded
mapping, computes the same revision-bound merge, and retains the final disk and
editor rechecks. Merge-envelope construction gets an explicit transient text
snapshot. It does not recover an ancestor from disk.

Scope of the reduction: permanent `pushProducer.mappings` no longer scales with
file payload size. Existing `baseContents`, outbox payloads, recovery journals,
backups, and the in-memory revision history retain their existing purposes.
The supplied 8.4 MB figure was not remeasured against a deployed plugin.

Compatibility: upgrade and interrupted legacy-journal replay are supported.
An old 1.5.0 client requires `mapping.content` and cannot read compacted mappings.
Do not downgrade a migrated data document in place; preserve the pre-upgrade
plugin state when validating a release and account for edits made after it.

## 2. The fixed triple is three sequential consumers in one cycle

Confirmed through the production `buildSyncController` wiring with empty
responses and no scheduler, wake subscription, retries, or overlapping trigger:
each invocation of `controller.syncNow()` issues exactly three `/events` calls.

| Order | Caller | Purpose |
| --- | --- | --- |
| 1 | `beforePull -> history.refresh()` | Refresh the revision graph |
| 2 | `SyncRunner.runPull()` | Read and apply events at the materialization cursor |
| 3 | `afterPull -> reconcileHeads -> history.refresh()` | Refresh heads before reconciliation |

`RevisionHistory.refresh()` uses a do/while, so even a caught-up graph makes one
request. Its cursor is separate from the runner's apply cursor. The three calls
are sequential, so `loading` only coalescing overlapping refreshes does not help.
This explains the observed triple without any of the proposed retry/rerun
hypotheses. Pagination and newly arriving events can add further requests; three
is not a hard maximum. The supplied 200 ms gaps are consistent with sequential
round trips, not a 200 ms sleep in the loop.

No polling optimization is included: the requested outcome here was root cause.
A follow-up can share an event page between history and apply while preserving
their distinct progress and validation rules. Removing refreshes blindly can
lose the ancestry needed to handle events arriving during a cycle.

Three HTTP requests do not establish three cellular radio wakeups; that requires
device-level measurement. The supplied 0.9-second delivery observation stands,
and the withdrawn 15-second diagnosis was not reopened.

## 3. Deferred views do not establish a hidden unsaved editor

The [official Obsidian deferred-view guide](https://docs.obsidian.md/plugins/guides/defer-views)
describes a placeholder view that becomes the real view when visible. A deferred
leaf is not, by that description, an editable buffer holding user typing. The
guide also cautions that a matching view-type string alone does not prove the
concrete view class, and that force-loading all leaves defeats the optimization.

`editorTexts` inspects all leaves, including background and popout editors, but
only source-mode markdown buffers with the requested file. Reading view has no
editable buffer. `openBufferStates` compares those texts to disk. Additionally,
the existing-note write rechecks editors synchronously inside `vault.process`,
after earlier asynchronous work. A test materializes an unsaved editor after
the initial empty buffer check and proves this final guard refuses the write.

Conclusion: no demonstrated mobile overwrite defect follows from deferred
leaves alone. The test models the transition; it is not a physical-phone test
or proof about undocumented mobile editor persistence. A real remote-write race
and concurrent offline editing on both physical devices remain unverified here.

## Verification

`npm run verify` passed: workspace/release checks, lint, all workspace typechecks,
2090 tests in 175 files, and all builds. No deployment or live-phone test ran.

The first regression run failed in four intended places before the mapping
change: legacy parser retained payloads, markdown and binary mappings retained
payloads, and metadata-only commits failed to journal their recovery text.

Added coverage exercises legacy parsing, idle-vault compaction, unchanged files,
offline renames, restart recovery without a disk reader, the production triple
request sequence, and a late-materialized unsaved editor. Existing crash tests
cover create/rename/delete, partial base persistence, interrupted apply rollback,
legacy journals, and retention of unrelated files.

The debugging-and-error-recovery workflow was used to separate the reproduced
request count and persistence failures from the unconfirmed mobile hypothesis.
