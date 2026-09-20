# Sync reliability repair candidate

Status: automated verification passes. The previous local-commit blocker is fixed; this follow-up completes restart recovery and startup adoption. Real desktop/mobile rollout validation remains to be done.

This follow-up builds on the merged causal-merge fix. Reverting to the remembered 1.4.10 baseline alone does not address the reproduced failures in that baseline. This repair keeps the existing server protocol and three-way text merging; it does not introduce a CRDT or rewrite accepted server history.

## Behavior repaired

- Live editor protection includes background leaves. Unsaved text defers remote application without advancing the cursor. A second check after downloading and locking, plus an expected-content check inside Obsidian `Vault.process`, protects edits made during a remote fetch or write.
- Accepted revision ancestry is reconstructed from the server event log. Merges use a common revision's actual payload, rather than treating an unversioned last-seen text as proof that both devices shared it. Bootstrap skips obsolete intermediate revisions; later pulls refresh cached history when a new event arrives.
- Three offline branches, identical concurrent edits, and edits descended from a rejected equivalent automatic merge now converge to one accepted head with drained queues in HTTP/SQLite integration tests.
- Reconciliation only replaces a queued lineage when its complete combined content already matches disk and no unsaved editor is present. The replacement references current accepted heads. Overlap, missing ancestry, structural differences, and uncovered queued/quarantined children stop automatic recovery.
- Queue replacement and mapping intent are saved together in a recovery journal. Interrupted remote applies restore producer identity, shared path ownership, and merge bases before another push. Tests cover one-parent automatic merges, failed saves, and restarts at queue/mapping/completion boundaries. Original replaced envelopes remain in recovery backups; there is no automatic backup pruning.
- Producer document updates are serialized across files, preventing simultaneous edits from overwriting each other's identity records.
- Populated-vault startup waits for server identities before its initial scan. Matching notes and attachments adopt the existing identity by path and content. Divergent untracked paths remain local and are held for explicit conflict resolution. Initial connection failures retry through the existing runner backoff.
- Individual renames lock both paths, keep the source until destination creation succeeds, and preserve occupied destinations. Binary deletion checks raw bytes. Remote removals go through Obsidian's local trash.
- Cursor/receipt state is updated in memory only after persistence succeeds; acknowledged external payloads are removed only after durable receipt recording.

## Completing local-commit recovery

Commit `11c1fa7` on main fixes the original queue/identity split by journaling a normal local commit and replaying the mapping before enumeration. Its CI passed with all 2,078 then-existing tests.

The follow-up review reproduced additional interruption boundaries using the real durable state, producer and local-materialization callbacks:

- A create recovered its producer mapping but left shared path ownership and the merge base absent.
- An interrupted rename or delete left old shared ownership behind even after the producer mapping recovered.
- A failure after saving a base hash but before saving its text left that base permanently incomplete.
- A startup adoption saved its producer mapping before its shared metadata; a retry then considered the path complete and skipped the unfinished base write.

Recovery now restores shared ownership and merge metadata before clearing the existing journal. Renames retain the prior common ancestor; local edits never advance it. Deletions clear ownership/base records for the affected file, while other files remain unchanged. Startup saves the producer mapping last so it is a reliable completion marker. A refused journal transaction raises the existing observer-recovery error instead of falling back to separate queue/mapping writes.

These changes do not add a journal format, server endpoint, database migration, or authentication-policy change. The regression tests remain in the normal suite.

## Validation

- `npm run verify`: passes workspace/release checks, lint, type-checking, all **2,083 tests across 173 files**, and the build.
- `npm run test:coverage`: passes all tests and the repository's 80% thresholds for statements, branches, functions and lines.
- All 21 real HTTP/SQLite onboarding/sync cases pass, including the original three convergence failures and populated-vault identity tests.
- Design-token, generated-class and whitespace checks pass.
- No live Obsidian desktop/mobile pair, production server or real vault was exercised.

## Deployment and server handover

Review and merge the follow-up, then validate matching client builds on disposable vault copies before a broader rollout. Passing automated tests is not evidence that a particular live server and phone installation have been upgraded successfully.

This change needs no server database migration and uses existing event/blob/push APIs. It assumes retained revision ancestry; previously deleted history cannot be recreated by rolling back plugin code. Do not delete heads, renumber events, or edit migration metadata to force convergence.

For the device trial, stop sync on all participating devices, retain complete client and server backups, and test matching plugin builds on disposable copies of the vault with the existing server version. Validate offline edits on two computers and a phone, sleep/wake, unsaved background tabs, simultaneous edits, renames, attachments, and a restart while uploads are pending. Confirm one current head for automatically mergeable notes and empty queues, while genuine overlapping edits remain visible conflicts.

Keep the original server database and blobs. Rollback of this client candidate must preserve its plugin state because an older plugin does not understand the new recovery journal. Do not downgrade a client while journal entries are pending.

Session expiry and revocation policy are unchanged. Existing sessions need not be preserved for rollout; a device may reconnect or pair again if necessary. Server access was not required for this code repair and no deployment was performed.
