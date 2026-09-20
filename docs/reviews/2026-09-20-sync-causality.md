# Review of the September 20 sync fixes

Sync changes reviewed: `538a906` on top of `2594866` and the `8b03160` rollback.
The final branch incorporates upstream `98097b5`, including backup fix `a4799cf`.
This review used the actual producer, durable queue, apply adapter, HTTP
transport, Fastify server and SQLite database, with simulated Obsidian APIs.
No production server or vault was accessed. The attached server reports are
operator-provided evidence, not measurements made during this review.

## Findings in the submitted fix

1. **Own-echo acknowledgement can silently replace a concurrent edit.** Server
   acceptance proves storage, not that an offline peer observed the revision.
   Setting the three-way ancestor to the accepted local content makes
   `local == ancestor`; a concurrent incoming change can then replace it as a
   clean merge. At the reviewed commit, the real-server test changed `base` to
   `owner edit` and `invitee edit` concurrently. The owner ended up with
   `invitee edit` instead of retaining its own version and a conflict copy.
   A different-lines case also lost the owner's changed first line.
2. **Adopting a merge as the peer revision does not publish a merge revision.**
   Updating the producer mapping to the merged bytes deduplicates the reflected
   file event. The producer still generates only a single parent for ordinary
   changes. The reviewed code therefore did not satisfy the one-head assertion
   in the real-server reproduction, even though the hand-relayed test passed.
3. **The binary gap is real.** A sequential attachment handoff produced a
   conflict after an owner-only update. The solution is causal proof tied to
   the current raw-byte hash, not changing a Markdown ancestor on an echo.
4. **Scheduled backups can starve across restarts.** A timer that first fires
   after 24 hours never runs on a server restarted more frequently. Startup
   tests for missing and overdue artifacts failed before the scheduler change.

## Changes

### Revision-aware causal apply

`OutboxLocalChangeRepository.versionFor` reads a revision ID and its content
hash from the same producer snapshot. The apply adapter can fast-forward a
received direct child when the disk still matches that exact local revision,
regardless of an older three-way ancestor. It rechecks the hash before the write.
Markdown uses canonical text hashes; attachments use raw-byte hashes.

The unsafe own-echo ancestor hook is removed. Echo suppression remains. Ordinary
sequential Markdown and attachment handoffs now pass, as do causal renames and
deletions after an owner-only update. Different concurrent same-line edits still
produce a conflict copy and preserve the active local note.

### Explicit merge publication

`commitMergedChange` builds and queues a full merge payload before updating the
producer mapping or writing the merged file. A concurrent merge names both the
local revision and the incoming revision. If the incoming revision already
parents the local revision, only the incoming head is needed. The reflected
file event is intentionally deduplicated, since the merge is already queued.
The previous three-way ancestor is retained while the branches are concurrent.

Automatic publication requires evidence that the local head was authored on
this device, either queued or accepted. A joining device replaying somebody
else's old fork must not publish a new branch from historical intermediate
content. Its later accepted resolution can still materialize normally. This is
a conservative guard, not a complete snapshot-bootstrap redesign; replay can
still preserve an intermediate conflict artifact.

Two devices may independently compute the same merge. Once an accepted remote
merge has been applied, `retireEquivalentMerges` can remove a redundant queued
leaf only when its file ID and full payload hash match and its merge parents
are covered by the accepted revision. Pending or quarantined descendants block
retirement. The rejected local ID is never marked as server-accepted. The queue
change persists before externalized payload cleanup.

### Backup scheduling: already fixed upstream

While this review was in progress, `a4799cf` added an overdue-backup check at
startup, and `98097b5` removed a dead owner-connection re-export. This branch
retains those changes. An independently tested backup implementation from this
review was discarded to avoid duplicating or replacing the owner's work.

The upstream age check addresses restart starvation without taking a backup on
every fresh restart. It affects on-server scheduling only; it does not repair
an unavailable off-site destination or replace off-site backup monitoring.

## Verification

The new real-server scenarios cover:

- first-authorship ancestor seeding;
- sequential Markdown handoff after an additional owner update;
- non-overlapping concurrent edits in both device orders;
- one accepted two-parent merge, one remaining server head, empty upload queues,
  subsequent editing, and a third device replaying the resulting history;
- overlapping edits after the owner's server echo, preserving both texts;
- sequential binary handoff;
- causal rename and delete after an owner-only update.

The failing-before-fix cases were executed against the reviewed commit. Further
red tests caught a redundant queued merge, historical replay publishing a new
merge, and stale-base rename/delete handling during implementation.

Queue tests check persistence across reload, hash/parent mismatches, single-parent
revisions, and pending/quarantined descendants. The upstream scheduler tests are
retained and run with the full suite.

The old echo test manually imitated one runner branch and asserted the unsafe
ancestor advancement. It was replaced by real-runner scenarios. The randomized
wire harness now harvests actual outbox envelopes, including explicit merges,
and relays their parent IDs, rather than reconstructing sends from local UI
activity. It remains a lightweight wire harness, not a substitute for server CAS
checks; those are covered by the HTTP/SQLite tests.

Run `npm run verify` and `npm run test:coverage`. CI is also required on the
pushed commit. Exact run results are recorded in the pull request.

## Server recovery implications

No schema or wire-format migration is introduced. The current server already
supports multi-parent revisions and validates the exact current head set.
Client changes can be tested against schema 7. The separately landed upstream backup-scheduler change takes effect only after
deploying an updated server build. The sync changes here are client-side.

An approved editor can resolve a branch authored by a now-revoked device.
Parent validity depends on the revision's vault/file, not whether its original
author still has an active session. The revoked device does not need to reconnect.
The resolving client must inspect and reconcile all current heads, then publish
one valid resolution. This patch does not automatically repair the existing
production fork. Do not delete head rows or rewrite accepted history.

Matching historical blob hashes and a fork are evidence about stored identities
and branches; they do not prove the precise UI event sequence or current client
mappings. Re-pairing remains a plausible alternative origin for duplicate file
identities. A real-device capture should validate the repaired candidate on
copies, without deliberately risking the production vault.

## Remaining fundamental work and release limits

This is an incremental repair, not a declaration that synchronization is solved.
The next architectural step remains a single revision-aware transition boundary
covering identity, materialization, pending work, accepted revisions and remote
heads, with ancestor snapshots bound to revision IDs and journaled recovery.

In particular:

- General `HEAD_SET_CHANGED` recovery is not implemented. Non-equivalent merges,
  changed head sets and queued descendants are retained, not silently discarded;
  they can still need reconciliation. The new retirement path handles only
  provably equivalent leaf merges.
- Concurrent identical ordinary revisions can still leave historical forks;
  populated-vault adoption, delete/rejoin identity and arbitrary three-device
  ancestry need the broader state model. No content-only duplicate cleanup is
  authorized by these changes.
- Queue, producer mapping and filesystem updates still span separate durable
  operations. Queuing before materialization preserves the merge payload, but
  does not make every crash boundary atomic.
- A single historical ancestor is insufficient for arbitrary offline branches.
  Broad replay, unsaved-buffer behavior and the reported iPhone stalls remain
  outside the demonstrated fixes. The fixed session-family lifetime also remains.
- No release tag or distribution artifact is published here. A PC/phone trial
  on disposable copies, including restarts and offline edits, is required before
  promoting a release. The production database and off-site backup setup were
  not changed.
