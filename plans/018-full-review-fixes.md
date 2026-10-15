# 018, full code review: fixes and refactors

- Status: **Proposed**, 2026-10-15. Owner's ask: review all the code, find
  bugs, refactor, everything must work smoothly and meet the code standards.
- Source: five read-only reviews (agents, server, sync core, UI, deploy),
  about 70 findings. Every item below was traced to the current tree; the
  ones marked (verified) were re-read by the main session.

## Phase 1: data loss and security (release 1.10.4)

Sync core
1. (verified) Apply never checks sync scope on peer paths
   (`runtime/vault-apply.ts`, `packages/sync-core/src/payload-codec.ts`): a
   peer can write `evil.html`, `.git/hooks/x`, hidden folders. Reject any
   path that is neither a syncable note/attachment nor an allowlisted config
   path, for `path` and `previousPath`; park the event.
2. (verified) A failed `.obsidian` listing returns `[]`
   (`sync/config-adapter.ts:83`) and the poller then deletes every config file
   on every peer, permanently. A failed root listing must throw and skip the
   delete phase for that tick.
3. Mass-delete breaker in reconcile (`sync/reconciliation.ts`): 25+ unmatched
   mappings and 30%+ of all: skip deletes, show a Notice.
4. A redelivered conflict revision overwrites an edited conflict copy
   (`vault-file-port.ts writeConflictArtifact`): never modify a differing
   copy; allocate a new name.
5. Delete-vs-edit conflict writes an empty copy and Keep theirs blanks the
   note: write a marker body; Keep theirs on a tombstone trashes the note.
6. Case-insensitive path collision on apply (Linux peer `Note.md` vs local
   `note.md`): conflict copy instead of three failures and a parked event.

Agents
7. (verified) `write_note` without string content empties a note
   (`headless/runner.ts asText`, `mcp.ts`): refuse unless a string.
8. (verified) A failed `sync()` after a run drops the run memory and the
   agent re-runs (and pays) every minute: persist memory before the final
   sync; a sync failure is logged, not thrown.
9. Server accepts the Codex/Cursor providers that can read the whole disk:
   reject them in the route and in `parseBrain` until they run sandboxed.
10. Task-note scope check is case-sensitive (`may_write: [havemind/x]`
    reaches `Havemind/` on macOS peers): compare case-folded, NFC.
11. Two agent names can map to one folder (`Mail Bot`/`Mail-Bot`): suffix on
    collision, never overwrite another agent's identity.
12. One throwing tool aborts the run; JSON parse errors echo model text into
    logs; EPIPE on stdin crashes the service; `ensureClaudeCode` failure kills
    the whole service; agent name not validated before it becomes a path.

Server
13. Agent brain is one file per server: on a multi-vault server one owner can
    replace (and redirect) another vault's agents. Store it per vault.
14. No global error handler: 500s send internal messages (paths, SQLite
    text). Add one that logs and replies `INTERNAL`.
15. Claim drops an enrollment on any error; drop only on invitation errors.
16. A redeemed-but-unapproved device can be approved weeks later: pending TTL.

Installer
17. `HAVEMIND_YES=1` re-run rotates and prints a new owner pairing token.
18. `.env` is world-readable until the late chmod; backups/agents dirs 755:
    `umask 077`, chmod 700.
19. `sh -c "curl … | sh"` hides a failed download; no `docker compose`
    version check (Debian docker.io has none; the file needs 2.24+).

## Phase 2: what the owner hit (same release)

20. Editors see Invite someone and Add agent: gate on the roster role.
21. The code field loses focus (phone keyboard closes) and the pane scrolls
    to the top on every repaint: restore focus, selection and scroll.
22. "Enter <device>'s code" opens the invite form: put the code field and
    Approve in the card itself.
23. Fresh phone vault: "1 file needs conflict resolution" right after join
    (default `.obsidian` config vs the owner's): config adopts the remote on
    first join; the Notice names the paths.
24. Stale pending approvals: filter expired, refresh from the server after
    connect and on sync, clear on disconnect.
25. Add agent: the pasted key/address/model are wiped by a repaint; the AI
    agent role reverts to editor on repaint; error paths report the wrong
    thing; save the brain only after the agent was added.
26. Undo, then the agent redoes the same work; Inbox sorter duplicates tags.

## Phase 3: performance (release 1.10.5)

27. Every state change rewrites all of `data.json` (plus `.bak`): split
    high-churn keys or batch writes per apply.
28. `RevisionHistory` scans the whole log per lookup (O(E²) catch-up): index
    by file id.
29. Quota is a full-vault scan several times per push: index
    `(vault_id, blob_hash, blob_size)` or a running counter.
30. 48 MiB body limit before auth on every route; blob GET reads before
    charging the byte budget.

## Phase 4: structure (pure moves, behaviour unchanged, tests green)

31. `runtime/sync-state.ts` (1699 lines): parse, payload externalizer,
    producer journal, hydrate; facade stays. `applyDecoded` into delete,
    rename, write.
32. `onboarding/controller.ts` (1109): ports, parsers, validators, encoding.
33. `main.ts` (893): view options, restore/undo, lifecycle.
34. Server: `revision-repository.ts`, `invitations.ts`, `sync-routes.ts`,
    `session-repository.ts` over 800 lines; shared UUID/clock helpers; one
    owner-of-vault check.

## Phase 5: release safety

35. The installer's own compose file is never checked by the hardening
    tests: generate it in a test and run `analyzeCompose`.
36. The GitHub release is public before its image and `install.sh` exist:
    draft until the image job finishes.
37. CI never builds the Dockerfile or runs `compose:smoke`.
38. Backups can be skipped forever silently (`mac_reachable`): tell
    unreachable from auth failure; alert when the newest snapshot is old.

## Rules added after review of this plan

- **Item 13 migration:** the agents service looks up the brain by the agent's
  `identity.vaultId` (`agent-secrets/<vaultId>/brain.*`). Legacy root files
  (`brain.json`, `brain.secret`, `model.key`, `model.oauth`): if the server
  has exactly one vault, move them into that vault's folder; otherwise ignore
  them and log a warning. Never fall back to the root. Agent folders (item
  11) and plan 017's mail file use the same per-vault key.
- **Inferred causes are confirmed first:** item 23 logs the blocked paths on
  a fresh vault before any fix; item 3 must still let a confirmed intentional
  bulk delete through and says whether it covers live deletes; item 1 parks
  out-of-scope events already in history without blocking the cursor.
- **Item 27 leaves 1.10.5:** it changes the storage format, and downgrades
  are unsafe since 1.5.0; it gets its own plan with a migration and a
  rollback story.
- **Phase 4 starts only after phases 1-3 are merged.**
- **Live checks run in a throwaway vault** on sapserver (or a local server),
  never first in the owner's "Havemind" or in Testvault (it syncs to Hubert);
  the throwaway vault is deleted afterwards.

## How

- TDD for every behaviour change: a failing test first, then the fix.
- Phases 1-2 are fixed by five workers in their own worktrees, each with an
  explicit list of files it may edit (cross-area items go to one owner:
  `plugin/agents.ts` and `add-agent*` to UI, `bootstrap-identities.ts` to
  sync core, `agent-routes.ts` and `brains.ts` to server). Every worker gets
  the repo's hard rules (no new dependencies, lockfile never on macOS,
  styles.css one selector one declaration, regenerate the class list, no
  vault deploys, no pushes, failing test first with its output, `npm run
  verify` before done). The main session reviews each diff before merge and
  runs `npm run verify` after every merge.
- Phase 4 moves code only, one file per commit, tests unchanged.
- Each release: live check on this Mac and the phone (sapserver vault) before
  push, and the owner's yes before the tag.
