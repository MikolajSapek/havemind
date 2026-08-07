# 03 — Cross-cutting systems

Systems used by ≥2 surfaces. Most of `sync-core` is already built (T004–T013, `[x]` in
`plans/002-pilot-tasks.md`) — this file covers ONLY what's left and cross-cutting: the
authorisation primitives (T018), because they're used by invites (04), routing (04), and plugin
onboarding (05) alike.

## Token and rotation primitives (T018)

Algorithm (from `plans/001-technical-plan.md` §9, translated into numeric constants):

```text
access_token:
  entropy: 256 bit, random, opaque
  ttl: 10–15 min (constant: 12 min)
  storage: client memory only (never SecretStorage)

refresh_token:
  entropy: 256 bit
  ttl: 30 days
  storage_server: hash (argon2id or sha256+pepper — choice made in issue F1-01, don't guess in this file)
  rotation: on every use

rotation_protocol (crash-safe, idempotent):
  1. client generates successor_token + rotation_id, persists it durably BEFORE sending
  2. client sends { current_token, successor_token_hash, rotation_id }
  3. server atomically: consumes hash(current_token), stores hash(successor_token) + rotation_id
  4. retry with the same rotation_id + the same data → success (idempotent)
  5. reuse with a different rotation_id or a different successor_token_hash → revoke the entire token family
```

Budgets/acceptance criteria as numbers:
- Token generation + hashing: no hard time budget in the MVP (not real-time UI), but the
  property test must cover ≥1000 random retry/reuse combinations with no false acceptance.
- Test coverage for this module: 100% of branches on the revocation path (this is the security
  path — the 80% threshold from `02-fundamenty.md` is the MINIMUM here, not the target).

File structure (from `plans/002-pilot-tasks.md` T018):
`apps/server/src/auth/tokens.ts`, `apps/server/src/auth/setup.ts`,
`apps/server/src/auth/tokens.test.ts`, `apps/server/src/auth/setup.test.ts`, `apps/server/src/db.ts`.

Playground: no need for `/dev/*` — the module is purely server-side and fully covered by
unit/property tests, with no UI for manual exploration.

## Anti-spec (S5)

- Never store the raw token anywhere except client memory and the request header.
- Never roll your own encryption/hashing "quickly" — use a verified library (argon2/
  bcrypt/scrypt for password-analogous secrets), per `plans/001-technical-plan.md` §10
  "No custom cryptographic primitive will be invented".
- Never extend the access token TTL "for testing convenience" in production code — tests
  manipulate the clock (`Clock` port), not the real constant.
