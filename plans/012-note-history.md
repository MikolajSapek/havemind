# 012, history of one note (1.8)

- Status: **In progress**, 2026-10-14. Phase 2 of `plans/011-after-1.7.md`.

## Goal

From any synced note, "Show history of this note" lists every accepted version
newest first, who made it and when; picking one shows the difference from the
note as it is now, and Restore puts that version back as a normal edit.

## What the tree already has (read 2026-10-14)

- The client keeps the whole accepted event log: `RevisionHistory`
  (`runtime/revision-history.ts`), persisted by `revision-history-store.ts`,
  `events[i].serverSequence === i + 1`. `graph(fileId)` returns every revision
  of one file.
- Author: `RemoteRevision.authorMembershipId`, from the receipt's `memberId`
  (`runtime/sync-transport.ts`).
- Time: **missing on the client**. The server stamps `serverTime` on every
  receipt (`opaqueBlobReceiptSchema`, required), and the transport drops it.
- Content: `revisionContent(revisionId)` in `runtime/adapters/sync-controller.ts`,
  which Activity Restore uses (`runtime/activity-restore.ts`).
- Diff: `computeLineDiff` in `runtime/conflict-resolution.ts`, client side
  (rule 2).

So this is plugin-only. Every server already sends `serverTime`; nothing to
feature-detect.

## Steps

1. **Data.** The transport keeps `receipt.serverTime` as
   `RemoteRevision.acceptedAt`. The history store format goes 1 → 2, so a log
   stored without times is read again in full once (event metadata only, no
   blobs). Red test: a pulled event carries `acceptedAt`; a format-1 store loads
   as empty.
2. **Model.** `runtime/note-history.ts` turns one file's events plus the roster
   into rows: revision id, author name ("You" for this device's membership),
   time label, newest first; queued revisions not yet accepted are left out.
3. **Window.** A modal lists the rows; choosing one loads its text and shows
   `computeLineDiff(now, then)` with a legend; Restore is two-step and calls the
   existing restore path. A binary or deleted version says so and offers no
   Restore.
4. **Entry points.** Command "Show history of this note" (available when the
   active file has a file id and a connection is live) and the same item in the
   file menu.

## Accept

- Unit tests for each step; `npm run verify`; CI green.
- On Testvault: a note edited on two devices shows both versions with the
  right names and times; Restore of an older version syncs as a new edit.

## Risk and rollback

- The format bump re-reads the event log once per device; on a large vault
  that is one longer first sync after the update. Rollback: release the
  previous version; the store falls back to a full read, which is the
  existing safe path.
