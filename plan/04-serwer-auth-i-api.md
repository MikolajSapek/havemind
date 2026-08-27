# 04, Server: invites, auth-routes, sync API, backup/epoch

Surface: `apps/server`. Source tasks: T019, T020, T021, T022 from `plans/002-pilot-tasks.md`.
Token primitives: `03-systemy-przekrojowe.md`. Don't duplicate protocol content, cite
`plans/001-technical-plan.md` §7–8 when in doubt.

## Event → reaction table (the API as a "surface" with no UI, events = HTTP requests)

| Event | Reaction |
|---|---|
| POST redemption with a valid, single-use invite | creates a pending device, returns `pending_approval` state |
| POST redemption with an expired invite (>15 min) | `410 Gone`, invite marked consumed, no retry |
| POST redemption with the same token a second time | `409 Conflict`, no second pending device created |
| Owner approves a pending device with the correct phrase | device active, refresh token issued |
| Owner rejects / the phrase doesn't match | pending device deleted, no token issued |
| Request with a header spoofing a different `actor_id` | `403`, logged without the header content in plaintext |
| Request to a vault without membership (IDOR attempt) | `403`, zero leakage of resource existence |
| Batch push with a cycle in `parent_revision_ids` | `422`, batch rejected in full, no partial acceptance |
| Push of an identical `revision_id` + identical bytes | `200`, returns the original result (idempotency) |
| Push of an identical `revision_id` + different bytes | `409` |
| Pull with a cursor outside the server's current range | `409 CURSOR_INVALID` after a restore with a new epoch |
| Server restore into an empty directory | integrity check + blob manifest verification before startup |
| Client with an older epoch connects after a restore | forced reconciliation of revisions/heads before any mutation |
| Rate limit exceeded (before authentication) | `429`, no information about whether the account exists |

## Anti-spec (S5)

- Never accept `actor_id` or `author` from the request body as binding on any endpoint, always
  take it from the session.
- Never return different error codes for "vault doesn't exist" vs "exists, no access", both
  must look identical from the outside (protection against IDOR enumeration).
- Never use a `Cache-Control` value other than `no-store` on endpoints with sensitive data.
- Never expose the `sudo` password or secrets from `/srv/secrets` through any diagnostic
  endpoint.

## Issues → BACKLOG mapping (full AC in `11-BACKLOG.md`)

- F1-01, token primitives and rotation (T018)
- F2-01, invites and device approval (T019)
- F2-02, deny-by-default auth-routes (T020)
- F2-03, sync push/pull API (T021)
- F7-01, backup, restore, server epoch (T022)
