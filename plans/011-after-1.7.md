# 011, after 1.7: phased roadmap

- Status: **Proposed**, 2026-10-14. Replaces the loose list in the vault note
  "Havemind - plan na dalej".
- Scope: everything we intend to do after 1.7.3, in phases that each ship on
  their own. Phases 0 and 1 are concrete; every later feature gets its own
  `plans/0NN` when it starts, after its spike, never before.

## Corrections to the earlier note

- **There is no crypto code.** `packages/crypto` was removed in `2841790`
  ("remove the unscheduled plans/004 vault-key crypto"); `plans/004` says
  "not built, not scheduled". End-to-end encryption starts from zero, on
  libsodium (rule 6: no home-grown cryptography).
- The catalogue screenshots are done (live on community.obsidian.md since
  2026-10-14).

## Hard rules for every phase

1. **Old servers.** The catalogue counts 279 downloads; their servers are not
   ours and will not upgrade in step. A plugin feature that needs a new server field or
   route must feature-detect it (`/.well-known/havemind` capabilities, or the
   field treated as optional) and hide quietly when it is missing.
2. **Server first, plugin second.** A server change ships and is deployed on
   sapserver (the user runs the sudo step) before the plugin release that uses
   it.
3. **Rule 2 stands.** The server never computes diffs, merges or provenance;
   anything like that runs on the client.
4. **TDD**, one item per commit, `npm run verify` and green CI before every
   push, the vault release log after every push.
5. **Small releases.** 1.7.x for polish, one feature per minor version.

## Item template

Every item below, and every later `plans/0NN`, states:

| Field | Meaning |
|---|---|
| Goal | what the user sees when it is done |
| Touches | files, read in the current tree, not guessed |
| Red test | the test written first, and what it asserts |
| Accept | the check that closes it |
| Server | none / new field / new route; deploy needed |
| Ships in | release |
| Risk / rollback | what can go wrong, how to undo |

## Phase 0, verify and reconcile (no new code)

1. **Overdue post-release checks.** These test the sync core, which matters
   more than any feature.
   - 7.10: in a copy of the server database, the phone and Hubert's device
     still send revisions after 1.6.0 (revisions per device since 2026-10-06).
   - ~12.10: `data.json` on the Mac fell to about 140 KB (1.5.9 backup expiry).
2. **Reconcile every open list against the tree**: "Havemind - do zrobienia"
   (the 6.10 review list), "Havemind - roadmapa" stages 1 to 5, "Havemind - 10
   otwartych pozycji". Each item ends as exactly one of:
   - open, with a file:line read in the current tree;
   - fixed by 1.7.x, with the commit;
   - superseded by plan 010 (UI-00, UI-02, UI-03 are the likely ones), closed
     with the reason.
   Nothing is checked off without evidence (repo CLAUDE.md).
3. Output: the vault notes updated, and the Phase 1 list below confirmed or
   trimmed. Ships: nothing.

## Phase 1, polish (1.7.4, 1.7.5)

Plugin-only, no server change. Each is small; group two or three per release.

| # | Goal | Red test | Accept |
|---|---|---|---|
| 1.1 | Activity survives an Obsidian restart | a reloaded plugin shows the entries written before reload | restart Testvault, rows still there |
| 1.2 | Connect commands hidden while connected; "Open activity" opens the Activity tab | command `checkCallback` false when connected; command selects the tab | palette on a connected vault |
| 1.3 | "Retrying..." offers Retry now | hero in `retrying` renders the button | force a retry on Testvault |
| 1.4 | Invitation expiry in words, "Expires in" shown to the guest | expiry label for owner card and guest screen | invite a test device |
| 1.5 | Getting started never points at a form that is not there | connected help copy has no "below" | read on a connected vault |
| 1.6 | Rejoin, Remove, Retry, Discard 44px on touch | stylesheet test on the coarse-pointer block | phone |

Notes:
- 1.1 stores the feed in the plugin's IndexedDB client store
  (`storage/client-store.ts`, introduced in 1.6.0), never in `data.json`,
  which 1.5.9 just stopped from growing. Cap it (200 entries, as today) and
  drop entries for files that no longer exist on read.
- Server cleanups AUD2-01, AUD2-03, AUD2-05 ride along as one server-only
  release with its own sapserver deploy; they change no API.

## Phase 2, history of one note (1.8)

- Goal: a command and a button "History of this note": who changed it and
  when, the difference between two versions, Restore.
- Likely plugin-only. The client keeps the vault's revision history locally:
  `history.event(revisionId)`, `history.heads(fileId)` and `history.payload`
  in `runtime/adapters/sync-controller.ts`, which Activity Restore already
  uses (`runtime/activity-restore.ts`). The first task is to confirm the
  local history holds every revision of a file, not only heads; if it does
  not, a per-file listing route is needed and rule 1 applies.
- The diff is the line diff the conflict modal already computes, on the
  client.
- Own plan: `plans/012` after that check.

## Phase 3, presence on the flower (1.9)

**Decision first.** Showing who is online is a privacy change, and the flower
model and the design notes currently promise it shows no presence
(`runtime/flower-model.ts` header). The owner decides whether it exists, and
whether it is on by default; then the spec and that header change.

- Design direction, to confirm in its plan: derive "online" in memory from
  the devices currently holding a `/vaults/:vaultId/wait` long poll
  (`sync/vault-wake-registry.ts`), no migration. A restart forgets it, which
  is correct for presence.
- The roster gains an optional `online` field; old servers omit it and the
  flower keeps today's look (rule 1).

## Phase 4, decision gate: AI as a member, or end-to-end encryption

Two large directions; doing both at once does neither well. The user chooses.

**AI as a member (spike first).**
- Today an agent writes files on a paired machine, so the server sees that
  machine's owner (`docs/using-with-ai-agents.md`: the agent "never talks to
  the Havemind server"). Its own seat in the flower needs its own device
  identity, which means a headless client built on `packages/sync-core` and
  `packages/protocol`.
- Spike, time-boxed: can a headless client pair, push one revision and show
  as its own member? Kill criteria: it needs server changes beyond a new
  device kind, or it duplicates the plugin's sync engine.
- Do not claim nobody else has this until it is checked.

**End-to-end encryption.**
- From zero (see Corrections). Needs a revised `plans/004` with an updated
  threat model, libsodium only, new vaults encrypted from their first
  revision, no in-place migration.

## Phase 5, lower the entry bar

- One-command server install that checks Tailscale and prints the token;
  `doctor` explains each failure in words.
- Folder excluded from sync (`.havemindignore` or a setting).
- Three to five testers outside the pilot; an issue template on GitHub.

## Order

0 → 1 → 2 → 3 (after the presence decision) → decision gate → 5 can run in
parallel with 4, it touches the server setup only.
