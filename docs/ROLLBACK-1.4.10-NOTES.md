# Rollback to 1.4.10, what was learned between 14 and 19 September

Written on 2026-09-19 at the owner's instruction: revert the plugin and the
server to tag `1.4.10` (2026-09-14), because the versions after it never
reached a state where the phone worked end to end.

This file exists so the work is not lost. Nothing here is a defence of the
rollback decision; it is the map for whoever picks this up next.

## Why the rollback happened

Every release from 1.4.22 to 1.4.28 fixed a real, reproduced defect and
introduced or left another one. The owner ran out of patience after 1.4.28,
which fixed join-time duplication and shipped a one-line defect in its place.
That is the honest summary: the defect rate per release never dropped below
one.

## What was genuinely diagnosed (keep this, it cost the most)

### 1. Hash unit confusion, the conflict storms (fixed in 1.4.24, `85d38ca`)

`acknowledgeOwnEcho` in `runtime/vault-apply.ts` wrote
`event.revision.contentHash` (a hash of the envelope BYTES) into `baseHashes`,
which is a namespace of PLAINTEXT hashes of canonicalised markdown.

Proved numerically on the same note: plaintext `459af7d3…` vs blob `3c7ac8cf…`.

Because the base hash never matched what the next comparison computed, every
subsequent edit looked like a concurrent change and produced a conflict copy.
Those were the empty "Target unknown" files.

The fix is to hash the on-disk text with the same function the comparison
uses:

```ts
if (!contentMatches(onDisk, text)) return;
const baseHash = await this.hashContent(onDisk);
await this.files.recordBaseHash(event.revision.fileId, baseHash);
```

**This is the single most valuable finding in the whole effort.** If conflict
storms come back on 1.4.10, this is the cause, and this is the shape of the
fix.

### 2. Refresh families expired at a fixed 30 days (fixed in `8f6495a`)

The PC went silent for 19 hours with a growing outbox. Root cause: the refresh
token family had a fixed expiry, so a device in daily use still aged out.

Fix: slide the family expiry on every successful refresh
(`apps/server/src/auth/sliding-family-expiry.ts`, 30-day window), applied
BEFORE the successor token is written so it inherits the extension. Verified in
production: the PC token moved to 19 October.

**1.4.10 does not have this.** Expect the PC to fall off roughly 30 days after
pairing, with no visible error. Re-pair when it happens.

### 3. Token failures were invisible (fixed in 1.4.27, `b05286e`)

`getAccessToken` in `runtime/adapters/sync-loop.ts` was:

```ts
async () => { try { ... } catch { return null; } }
```

A swallowed catch. The 401 that stopped the PC for 19 hours never reached a
log. This is why the diagnosis took days rather than minutes.

**1.4.10 has the swallowing catch.** When something stops syncing on 1.4.10 and
the panel says nothing, this is why. First thing to re-apply if debugging gets
hard again.

### 4. Join-time duplication (fixed in 1.4.28, then broken differently)

A device joining a populated vault enumerated the local vault and pushed
everything it had no mapping for, which after a bootstrap is every file. The
phone re-uploaded 31 notes it had just downloaded: same bytes, new file ids,
5.4 MB, every shared note left with two identities.

The adoption logic (`sync/join-adoption.ts`, `sync/registry-server-index.ts`)
was correct and was **verified working in production**: after the clean server
rebuild the phone joined and sent 1 revision instead of 31. File count stayed
at 86.

### 5. The defect that triggered the rollback

`sync/reconciliation.ts:380` called:

```ts
await repository.adoptRemoteMapping?.({...}, fileId);
```

The second parameter is `headRevisionId`, not a file id. Both are `string`, so
the compiler accepted it. The result was `heads[fileId] = fileId`, so the first
edit on the phone sent a parent revision id that is actually a file id. The
server could not find it and rejected with `MISSING_PARENT`, permanently, for
every subsequent edit to that file. That is the "6 changes couldn't be sent"
screen.

The comment three lines above the call says "The head is left unset because
this device has authored no revision for it yet" which is what the code should
have done and did not.

The fix is to not record a head at adoption time at all. It was never applied.

The test that would have caught it did not exist: the adoption tests asserted
`result.adopted` and that nothing was pushed, never the contents of `heads`.

## Server-side findings

- History compaction was deleting superseded revisions that later pulls still
  needed, which produced `MISSING_PARENT` on the server and holes in the event
  log. `compactSupersededRevisions` was replaced by a counting function and the
  destructive entry point made to throw (`apps/server/src/history-compaction.ts`).
- `server_sequence` is stored in THREE places: `vault_events.server_sequence`,
  `revisions.server_sequence`, and inside `event_payload.receipt.serverSequence`.
  Any renumbering must touch all three. The repair script needed three attempts
  in production because the first two passes missed one each. If you ever write
  another repair script, this is the trap.
- Repair scripts that live on: `renumber-event-log.mjs`,
  `resolve-forked-heads.mjs`, `merge-duplicate-files.mjs`, all under
  `apps/server/scripts/`, all with tests that drive the real script.

## Structural finding, never addressed

The plugin keeps three separate notions of file identity, kept in agreement
only by call-site discipline:

- `heads` (fileId to revision id)
- `pathOwners` (path to fileId)
- `locallyAuthored` / base state

`runtime/vault-apply.ts` contains 42 writes to apply-side state against 20
paired producer calls. Every defect in this list is a variation of the same
theme: one of those writes was missed, or written into the wrong namespace, or
given the wrong unit.

`sync/file-registry.ts` was the attempt to collapse this into one record per
file with one writer per event. It landed and worked. It did not on its own
prevent the 1.4.28 defect, because that defect was at the call site passing the
wrong argument, not in the registry.

**If this project is picked up again, this is the thing to fix.** Make the
types distinct so `fileId` cannot be passed where `headRevisionId` is expected.
A branded type on each id would have made 1.4.28 a compile error.

## Production state at the time of the rollback

- Server wiped clean on 2026-09-19, vault `Notatki`
  (`a1c42c66-f211-4c28-9322-5f5204ef69ca`)
- 86 files, 86 revisions, sequences 1..86 contiguous, no duplicates
- Backup of the pre-wipe database:
  `/home/mikolaj/havemind-backup-przed-czyszczeniem-20260919T055727Z`
  (havemind.db 10264576 bytes, WAL 4190072, blobs 38M)
- Two devices approved: `65b3f881` (PC), `957c4de5` (phone)

## Unexplained, still open

The phone repeatedly stopped before finishing its download: 920/934, 89/117,
124/155. Session validity, server data, file sizes and log continuity were all
excluded as causes. No explanation was ever found. This is independent of every
defect listed above and will most likely still be present on 1.4.10.
