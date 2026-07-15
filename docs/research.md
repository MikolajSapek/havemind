# Existing-solutions research

Status: completed on 2026-07-15.

## Conclusion

No mature product currently combines all of the following:

- self-hosting on our Ubuntu server;
- ordinary local Obsidian vaults and offline work;
- reliable synchronization without silent data loss;
- authenticated, durable attribution of document edits;
- an activity inbox and notifications;
- optional real-time co-editing and end-to-end encryption.

## Closest options

### Obsidian Sync shared vaults

Official Sync supports shared vaults, offline work, version history and the last editor of a file. It is not self-hosted and does not provide live co-editing.

Sources:

- <https://obsidian.md/help/teams/sync>
- <https://obsidian.md/help/sync/version-history>

### Relay (System 3)

Relay provides Yjs-based CRDT synchronization, offline work and live cursors. Self-hosting stores synchronized content on one's own relay, but durable change attribution, notifications and end-to-end encryption are still listed on its roadmap.

Sources:

- <https://github.com/No-Instructions/Relay>
- <https://relay.md/roadmap>

### Self-hosted LiveSync

Self-hosted LiveSync is a mature self-hosted synchronization option with CouchDB-compatible storage and optional encryption. Its data model does not provide authenticated people, a durable author-per-change history or Google-Docs-style co-editing.

Source: <https://github.com/vrtmrz/obsidian-livesync>

### Obsidian Git

Git provides excellent commit history, diffs and authorship, but its merge conflicts and commit workflow are a poor default experience for non-technical collaborators and it is not real-time.

Source: <https://github.com/Vinzent03/obsidian-git>

### EVC Team Relay

EVC Team Relay is an open self-hosted Yjs stack and is the closest experimental foundation. Its current audit log records account, login, invitation and share-management events, not document writes. The code explicitly notes that `DOCUMENT_WRITE` does not exist yet. Source inspection also found that the current relay-token issuer does not include the user subject required for trustworthy per-update attribution.

Sources:

- <https://github.com/entire-vc/evc-team-relay>
- <https://github.com/entire-vc/evc-team-relay/blob/main/apps/control-plane/app/db/models.py#L33>
- <https://github.com/entire-vc/evc-team-relay/blob/main/apps/control-plane/app/services/lifecycle_service.py#L220>

## Decision

For the first usable release, build a small purpose-specific Havemind plugin and server around an append-only revision log. This directly delivers the requested attribution, activity feed and no-silent-overwrite guarantee with much less operational risk than adopting the entire young EVC stack.

Yjs/CRDT live co-editing remains a later, isolated phase. It should only be added if two people truly need to type in the same note simultaneously.

