# 008, Apply safety and author attribution

Status: **done, 2026-09-10**, shipped in `96ab775`. Four defects found in review
of `1044617`, verified against the tree at `26ae8be`. Two risked local data, two
left the UI wrong. `npm run verify` green at the time of the commit.

Two things this plan got wrong, corrected during the work:

- P4 named `sync-controller.ts` as a place to change. It was not: the controller
  already forwards the whole event. The field was being dropped one step
  earlier, in the pull parser in `sync-transport.ts`, and the server had been
  returning `memberId` on the receipt all along.
- P4 says three `onRemoteApplied` call sites. There are four; the three-way
  merge branch was missed. Attribution would have worked for some operations
  and not others.

Also found while fixing P4 and outside the plan: `activity-log.ts` guessed the
author whenever a vault held exactly one other member, which is what P4's own AC
forbids. Removed, along with the test that pinned the behaviour.

## Why these four sit in one plan

P1 and P2 are the same omission twice: a destructive step that runs before the
check that would have stopped it. The rename branch already models the correct
shape (compare on-disk content to the recorded base, divert to a conflict copy),
so P1 is that guard applied to the branch that lacks it. P3 and P4 are two halves
of one shipped-but-unwired feature: the server serves the roster and the activity
log accepts an author, and nothing calls either.

## P1, a remote delete discards local edits (highest, data loss)

`apps/obsidian-plugin/src/runtime/vault-apply.ts:343`

The delete branch checks only that the revision owns the path
(`fileIdAtPath(path) === fileId`), then deletes. It never compares the on-disk
content to the recorded base. A file edited while closed, by an external editor
or an agent, has an unsent local change; a remote delete removes it with no
conflict copy and no warning.

The rename branch, thirty lines below, already does this correctly at line 397:
read the old path, hash it, compare to `baseHashFor(fileId)`, and write a
conflict artifact when they diverge.

Fix: before `deleteByPath`, read the path and compare its hash to the base. On
divergence write the conflict artifact and return `'conflict'` instead of
deleting. Honour `resolvesLastWriterWins(path)` exactly as rename does, so
allowlisted `.obsidian/` settings keep resolving by recency.

AC: a remote delete of a file whose on-disk content differs from the base leaves
the file in place and produces a conflict copy. A remote delete of an unmodified
file still deletes. An allowlisted settings file still deletes.

## P2, a rename deletes the source before checking the destination

`apps/obsidian-plugin/src/runtime/vault-apply.ts:421`

The rename branch deletes `previousPath` at line 421. Ownership of the
destination is not tested until line 428 (`fileIdAtPath(decoded.path)`). When
`b.md` is held by a different fileId, the operation correctly reports a conflict,
but `a.md` is already gone: the content survives only as a conflict copy, and the
user's original file has vanished from where they left it.

Note the source-divergence guard at line 397 is correct and stays. The gap is
destination collision only.

Fix: hoist the destination-ownership read above the delete. When the destination
is owned by another fileId and the content does not match, divert to the conflict
artifact with `previousPath` untouched.

AC: renaming `a.md` to an occupied `b.md` leaves `a.md` on disk and writes a
conflict copy. A rename to a free path still moves the file. The F3 adopt path
(identical content at the destination) still converges with no artifact.

## P3, the roster is still read locally

`apps/obsidian-plugin/src/main.ts:969`

`GET /members` shipped in `1044617`
(`apps/server/src/auth/member-roster-routes.ts`) and no client calls it. The
plugin still builds People from `data.json`, so a guest and the owner can see
different member lists, which is the bug the endpoint was written to close.

Fix: fetch the roster on connect and on reconnect, render People from the
response, and fall back to the local list when the request fails, so an offline
device keeps showing what it last knew.

AC: a guest sees every active member of the vault. A failed roster request leaves
the previous list rendered, never an empty pane.

## P4, the author of a remote change never reaches Activity

`apps/obsidian-plugin/src/runtime/activity-log.ts:161`

`RemoteAppliedInfo.authorMembershipId` exists and is honoured, but nothing
populates it: `vault-apply.ts` does not read the field from the pull payload and
`sync-controller.ts` does not pass it into `RemoteAppliedEvent`. Every remote
change is recorded as `{ kind: 'remote' }` and Activity reads "Remote edit".

Fix: carry the membership id from the pull payload through
`RemoteAppliedEvent` into the existing `onRemoteApplied` call sites in
`vault-apply.ts` (there is one per branch: delete, write, rename).

AC: a change made by another member is attributed by name in Activity, with the
member's stable colour. An author the roster does not know still renders as a
remote edit rather than a blank or a guess.

## Order

P1 first, it is the only one that loses data with no artifact left behind. Then
P2. P3 and P4 are independent of both and of each other.

Every fix is TDD: the failing test lands first, and the P1/P2 probes must be
confirmed to fail against the current tree before the fix is written.
