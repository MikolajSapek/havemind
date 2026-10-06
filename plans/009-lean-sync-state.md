# 009, Lean sync state: bounded backups (1.5.9) and one file registry (A1, 1.6.0)

Status: **in progress, 2026-10-06.**

Roles: Opus 5.5 designs and writes the risky code (persistence, migration).
Sonnet subagents do mechanical work (test updates, deletions, docs). Choices
between options go to TypeSafe Jev; its verdict and probability are recorded
here. Every step: branch `fix`, failing test first, `npm run verify`, CI green,
then `dev`. Releases only from `main`, to both repositories.

## Step 1: reconciliation backups stop growing (release 1.5.9)

### Evidence

On the owner's Mac `data.json` is 577 KB. `syncState` is 260 KB and is written
twice (`syncState` and `syncState.bak`); 235 KB of it is
`reconciliationBackups`: two full envelopes (~115 KB each) of
`Reunion Hackathon 2027/Venue.md`, from 2026-10-01 and 2026-10-05. Both come
from `retireEquivalentMerges`: the server accepted the same merge from the
other device (`fileId` and `contentHash` equal, checked by the code), so the
text is on the server (revision `2a06741f` found in the 2026-10-05 server
backup). The field is never pruned and nothing in the UI reads it, so every
concurrent edit of a large note adds ~230 KB that every later save rewrites.

### Decision (Jev, jev-1.13.0)

- Approach: `stop_and_age_prune`, p = 0.86 (stop_only 0.07, externalize 0.04,
  header_only 0.03).
- Retention: 7 days, p = 0.78 (14 days 0.19, 30 days 0.03).

### Changes (`apps/obsidian-plugin/src/runtime/sync-state.ts`)

1. `retireEquivalentMerges` removes the retired entries from the outbox and
   keeps no backup. Their externalized payloads become orphans that the S1
   sweep already deletes on the next load.
2. The two producer-recovery paths stamp each backed-up envelope with
   `backedUpAt: now`. Extra fields pass `parseEnvelope` and the raw carry-over,
   so 1.5.8 still loads a 1.5.9 file.
3. The load (`reconcilePayloads`, part of the shared load every caller awaits)
   drops backup entries whose `backedUpAt ?? enqueuedAt` is older than 7 days
   or missing, drops emptied keys, and re-saves only when something changed.

### Acceptance

- A retired equivalent merge leaves `reconciliationBackups` unchanged.
- A recovery backup carries `backedUpAt`; it survives a load at 6 days and is
  gone after a load at 8 days; a legacy entry with neither timestamp is gone.
- Replaying the Mac's real `data.json` through the load: backups older than
  7 days gone, every other field byte-identical.
- `npm run verify` green.

## Step 2: one file registry (A1, release 1.6.0)

### Today

Two stores hold the same file identity and are written separately:

- `pushProducer` (`ProducerState`: `mappings` path/fileId/contentHash/stat,
  `heads` fileId to last local revision), saved by `OutboxLocalChangeRepository`.
- `syncState` (`pathOwners` path to fileId, `baseHashes`, `baseContents`,
  conflict maps), saved by `DurableSyncState`.

They are kept in step by hooks (`onLocalMaterialized`, `onLocalForgotten`,
`createRemoteApplyProducerSync`, `local-base-lifecycle.ts`) and a recovery
journal (`producerRecovery` with `applyState` snapshots) that closes the crash
window between the two writes. On the Mac they agree fully (105 files, no
difference), so A1 fixes no observed bug: it removes code and a class of
crash-consistency risk.

### Stages

- **2a. Replay harness first.** A script that loads a real `data.json`
  (Testvault) through old and new code and asserts, per file: same path,
  fileId, contentHash, head, base hash. It runs in CI against a scrubbed
  fixture made from the Mac's file.
- **2b. One persisted document.** `ProducerState` moves into
  `PersistedSyncState` (`producer: { mappings, heads }`), so a producer write
  and the apply-side write it implies happen in one `mutate`. Migration on
  load: when `syncState` has no `producer`, read the `pushProducer` key once
  and import it. The old key is left in `data.json` for one release.
- **2c. One identity map.** `pathOwners` is derived from `producer.mappings`
  instead of stored; `fileIdAtPath` and `pathForFileId` read the mappings.
- **2d. Remove the glue.** The `applyState` snapshot and the cross-store
  replay in `recoverProducerQueue`, the materialize/forget seams and
  `local-base-lifecycle.ts` collapse into single-store mutations.
- **2e. Release 1.6.0.** Mac first (replay its real file before installing),
  then the phone, then Hubert.

Open decisions for Jev when stage 2 starts: whether 2c keeps `pathOwners` for
paths that have a base but no mapping (conflict copies, received-only files),
and whether the old `pushProducer` key is deleted in 1.6.0 or 1.6.1.
