# Concurrent edit conflict handling in note-sync apps, comparative research

Researched 2026-07-22 (web survey, primary sources cited inline). Context: Havemind's
current model is Dropbox/Syncthing-style conflicted copies under `Havemind Conflicts/`
with UUID filenames and no in-app resolution flow, the field pain point that prompted
this survey.

## Comparison table

| App | Strategy | Granularity | Offline | How the user sees & resolves conflicts |
|---|---|---|---|---|
| **Obsidian Sync** (official) | 3-way merge via `diff-match-patch`, configurable fallback | Line/patch for `.md`; whole-file LWW for binary | Yes | Default silently auto-merges (can garble overlapping prose); since v1.9.7 opt-in "Create conflict file" writes `note (Conflicted copy <device> <ts>).md`; no in-app diff UI. |
| **obsidian-livesync** (self-hosted, CouchDB) | Auto-merge non-overlapping edits; interactive modal for overlapping hunks | Chunked document model (not CRDT) | Yes | `ConflictResolveModal` shows a diff-style dialog only for genuinely overlapping hunks; JSON files get a structural diff tree. |
| **Syncthing** | Conflicted copy, no merge | Whole-file | Yes | Older-mtime file renamed `*.sync-conflict-<date>-<device>.*`; both copies propagate; no tooling. |
| **Joplin** | Conflicted copy | Whole-note | Yes | Conflicts notebook; no built-in diff/merge (in-app resolution flow in progress upstream). |
| **Logseq** (DB/RTC, in transition) | CRDT-based RTC layer (experimental) | Block/keystroke | Yes | No conflicts by construction when connected; explicitly not production-ready. |
| **Anytype / AppFlowy** | CRDT (local-first, E2E) | Operation-level | Yes | Silent convergence; no user-facing conflict concept for live edits; doesn't cover file assets. |
| **Notion** | OT, cloud-authoritative | Character | Minimal | No client-visible conflicts; requires the central server, no self-hosting/offline-first. |
| **Obsidian Relay / Peerdraft** | CRDT (Yjs) | Keystroke | Yes | Live cursors; offline edits converge automatically on reconnect. |

## Key patterns

1. **Automatic 3-way merge with conflicted-copy fallback** dominates file-based sync
   (Obsidian Sync, livesync): merge ancestor↔local↔remote; only overlapping hunks
   surface to the user. Caveat from the diff3 literature: prose (unlike code) degrades
   when two edits land near each other, keep overlap detection conservative and fail
   toward a conflict copy rather than auto-resolving overlapping hunks (Obsidian Sync's
   silent-merge mode is documented to garble such cases).
2. **CRDTs** (Yjs/Automerge/Loro) eliminate the conflict concept but require persistent
   per-document CRDT state, don't cover binary files or rename/move conflicts, and even
   well-resourced teams (Logseq) ship them as not-production-ready.
3. **Resolution UX**: silent auto-merge (risky) / opaque conflict files (safe, painful,
   our current state) / in-app diff modal for the residual overlapping hunks
   (livesync, the only file-based pattern combining safety and usability).

## Recommendation for Havemind (ranked by effort)

1. **Automatic 3-way merge using the common ancestor revision** (smallest change,
   highest value). Havemind already stores full revision history, so the ancestor of any
   divergent pair is available with no new infrastructure. On divergence: line-level
   3-way diff (ancestor, local, remote); non-overlapping hunks → merge in place, no
   conflict copy; overlapping hunks → conservative fallback to today's conflict copy.
   Should eliminate the majority of visible conflicts for a 2-person vault.
2. **Fix the fallback UX** (medium): human-readable conflict filenames
   (`notename (conflict, <device>, <timestamp>).md` instead of UUIDs) + a lightweight
   in-app diff modal (livesync's `ConflictResolveModal` as reference) to pick a side or
   hunks without leaving Obsidian.
3. **CRDT retrofit** (high effort, likely not worth it here): removes text conflicts
   entirely but demands persistent per-file CRDT state, an architecture migration, and
   still needs the conflict-copy fallback for binary/rename conflicts. For a 2-person,
   mostly-asynchronous vault, options 1–2 capture nearly all the practical benefit.

## Sources

- https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution
- https://deepwiki.com/vrtmrz/obsidian-livesync/4.2-conflict-resolution
- https://github.com/vrtmrz/obsidian-livesync
- https://docs.syncthing.net/users/syncing.html
- https://joplinapp.org/help/apps/conflict/
- https://discourse.joplinapp.org/t/week-4-update/50250
- https://forum.obsidian.md/t/relay-multiplayer-plugin-for-obsidian-collaborative-editing-and-folder-sharing/87170
- https://www.peerdraft.app/
- https://blog.jcoglan.com/2017/05/08/merging-with-diff3/
- https://www.gnu.org/software/diffutils/manual/html_node/diff3-Merging.html
- https://www.inkandswitch.com/peritext/
