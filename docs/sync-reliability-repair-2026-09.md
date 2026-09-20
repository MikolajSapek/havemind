# Sync reliability repair candidate

Status: draft, not ready to merge or deploy. One active regression test still fails.

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

## Remaining blocking regression

`runtime/producer-recovery.test.ts`: `recovers a queued local create before another scan can mint a duplicate identity`.

A normal local create still has separate queue and producer-mapping saves. If the first succeeds and the second fails, a restarted scan sees no mapping and can mint another identity. The newly introduced apply/reconciliation journal does not yet cover this normal local-commit path.

The concrete remaining change is to use the existing journal when publishing local creates/updates/renames/deletes, saving the envelope and intended mapping together, and replay pending intent before enumeration. No additional server schema, token-policy change, file deletion, or accepted-history rewrite is needed. This extension was blocked by the coding environment's automatic approval review; the failing test remains active and is not skipped or weakened.

## Validation

- Latest aggregate verification: workspace/release metadata checks, lint, and type-checking pass; 2,077 tests pass and 1 fails across 172 files.
- The 21 real HTTP/SQLite onboarding/sync tests pass, including the original three failing convergence cases and populated-vault identity tests.
- A preceding complete verification passed all 2,076 then-existing tests and build. The final edge-case review added the local-create failure above and a passing new-event history test.
- Build passes separately. The coverage command also fails on the same active regression; no passing final coverage result is claimed.
- No live Obsidian desktop/mobile pair, production server, or real vault was exercised.

## Deployment and server handover

Do not deploy this draft. Finish the blocking local-commit test, run `npm run verify` and `npm run test:coverage`, and review the final diff first.

This change needs no server database migration and uses existing event/blob/push APIs. It assumes retained revision ancestry; previously deleted history cannot be recreated by rolling back plugin code. Do not delete heads, renumber events, or edit migration metadata to force convergence.

After the candidate passes, stop sync on all participating devices, retain complete client and server backups, and test matching plugin builds on disposable copies of the vault with the existing server version. Validate offline edits on two computers and a phone, sleep/wake, unsaved background tabs, simultaneous edits, renames, attachments, and a restart while uploads are pending. Confirm one current head for automatically mergeable notes and empty queues, while genuine overlapping edits remain visible conflicts.

Keep the original server database and blobs. Rollback of this client candidate must preserve its plugin state because an older plugin does not understand the new recovery journal. Do not downgrade a client while journal entries are pending.

Session expiry and revocation policy are unchanged. Existing sessions need not be preserved for rollout; a device may reconnect or pair again if necessary. Server access was not required for this code repair and no deployment was performed.
