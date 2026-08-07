# 05 — Plugin: onboarding, vault observation, sync runner

Surface: `apps/obsidian-plugin`. Source tasks: T025, T026, T027.

## Event → reaction table

| Event | Reaction |
|---|---|
| Opening `obsidian://havemind-join` | opens the wizard, WITHOUT a secret in the query |
| Pasting a copied invite envelope | plugin discovers the server, shows hostname/vault/inviter, requires confirmation |
| Confirming the connection | pending device, verification-phrase comparison screen |
| Owner approves the phrase on the other side | refresh token stored in SecretStorage, initial download starts |
| Hover on the status bar (`Synced`/`Syncing`/`Offline`/`Conflict`) | tooltip with the time of the last sync |
| Click on the connection card in settings | shows hostname, vault, device, owner-only actions |
| Keyboard: Tab through the wizard | full navigation without a mouse, focus visible |
| Create/edit/rename/delete a `.md` file | operation deduplicated by hash, goes into the outbox |
| Write to `.obsidian/**` or trash | ignored, never reaches the outbox |
| Loss of network connection during editing | the edit is saved locally as normal, `Offline` shown in status, queued |
| Coming back online | single-flight sync with jittered backoff, no duplicates |
| Remote event for a file with an open, diverging buffer | deferred or conflict, never a silent overwrite of the active editor |
| Reduced motion (system) | no animated transitions in the wizard/status, immediate states |
| Mobile (Obsidian iOS/Android) | plugin builds without the Node/Electron API; background sync paused, no guarantee of sync while backgrounded |

## Edge cases at definition time (S4)

- Onboarding: server incompatible with the protocol → a clear message in the user's language
  (Polish/English, per Obsidian's settings), zero connection attempt.
- Vault-adapter: file deleted offline → a tombstone built from the last known local snapshot,
  because Obsidian doesn't deliver the deleted file's content in the event.
- Sync-runner: Obsidian restarts during a push → retry with the same `revision_id`
  (idempotent), no revision duplication on the server side.

## Anti-spec (S5)

- Never put the invite secret in the `obsidian://` query string — only in the URL fragment and
  via manual paste of the envelope (see `specs/002-public-access.md`).
- Never auto-merge two existing vaults during onboarding.
- Never overwrite the active (open, diverging) editor buffer without a conflict/defer path.
- Never introduce any Node.js/Electron-only dependency in the plugin code — it breaks mobile
  compatibility.

## Issues → BACKLOG mapping

- F2-04 — vault-adapter and reconciliation (T026, skeleton portion)
- F3-01 — invite onboarding (T025)
- F4-01 — sync runner and safe remote apply (T027)
