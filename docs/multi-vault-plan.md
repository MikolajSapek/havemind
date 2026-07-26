# Multi-vault support — implementation plan

Status: proposed (awaiting go). Owner: Mikolaj. Date: 2026-07-26.

## Goal

One Havemind server hosts several **independent, isolated vaults** on a single
container. Example: Mikolaj + Hubert share vault A; Janek + Maciek share vault B;
neither team can see, wake, or write the other's data.

## Key finding — this is additive, not a rewrite

The server is already vault-scoped end to end. Every sync path keys on `vault_id`:

- `memberships (vault_id, user_id, role, status)` with `UNIQUE (vault_id, user_id)`.
- Sync routes: `/vaults/:vaultId/revisions|wait|blobs`, each does
  `loadActiveMembership(user, vaultId)` before doing anything.
- Invitations already per vault: `/vaults/:vaultId/invitations[...]`, approval
  mints a membership scoped to `invitation.vault_id`.
- Blob presence, storage quota, and the wake registry are all per `vault_id`.

So **data isolation between vaults already holds.** What blocks running two teams
today is only:

1. **No way to create a second vault.** `setup` creates exactly one owner + one
   vault and then refuses (`ALREADY_INITIALIZED`); there is no `create-vault`.
2. **Two "first/only vault" shortcuts** in `onboarding-routes.ts`:
   `loadFirstActiveVault(userId)` is used (a) right after owner pairing and
   (b) in the events bootstrap. A user who belongs to two vaults would always be
   pinned to the older one.
3. Owner pairing tokens (`owner_pairings`) are minted only at `setup`, for the
   single vault.

Nothing else in the model needs to change. No sessions table exists (auth is
per-request via tokens + membership check), so there is no global session state
to leak across vaults.

## Design decision — Model B (independent owners per vault)  ✅ chosen

Every vault has its **own owner**, independent of the others. Janek owns vault B
and administers it (invites/approves/revokes his own members) without any relation
to Mikolaj's vault A. One server, several self-governing vaults.

- Vault A: owner = Mikolaj; members = Mikolaj, Hubert.
- Vault B: owner = Janek; members = Janek, Maciek.

How this maps onto the existing model:

- Owner-ness is already **per vault** via `memberships.role = 'owner'`, and every
  owner-only route already checks `requireOwnerMembership(membershipId, vaultId)`.
  So "different owner per vault" is natively supported at the authorization layer.
- The only true singleton is `users.is_instance_owner = 1` (unique index
  `one_active_instance_owner`). We keep **exactly one instance owner** — the person
  who bootstrapped the server (Mikolaj) — purely as the server bootstrap admin.
  **Additional vault owners are ordinary users** (`is_instance_owner = 0`) that
  hold an `owner`-role membership in their own vault. No schema change, no conflict
  with the unique index.
- Practical consequence vs Model A: `create-vault` must be able to mint a **new
  owner user** (not reuse the instance owner), and every place that resolves "the
  owner" via the `is_instance_owner = 1` singleton must instead resolve the owner
  **per vault**. That audit is the extra work Model B adds over Model A.

Future note: if we ever want the instance owner to have zero special status, drop
the `is_instance_owner` flag entirely and make bootstrap just "create the first
owner + vault". Not required now.

## Client model — no client change needed

One Havemind connection = one vault = one Obsidian vault, which is already how the
plugin works (it stores a single `vaultId` per connection and sends it in every
request). A person in two teams simply opens **two Obsidian vaults**, each paired
to its own server vault. Mikolaj runs vault A and vault B as two local Obsidian
vaults. No plugin code changes required.

## Work items

### 1. `create-vault` CLI  (server)
New command: `havemind create-vault --vault <name>`.
- Require an initialized instance owner (else `NOT_INITIALIZED`).
- In one transaction: insert `vaults` row; insert an `owner`-role, `active`
  membership for the instance owner into that vault; mint a fresh single-use
  `owner_pairings` token bound to the new `vault_id` + owner membership.
- Print `vaultId` + the pairing token (same channel as `setup`).
- Files: `src/setup/cli.ts` (command + usage), `src/auth/setup.ts` (a
  `createVault` method next to the existing owner-setup logic).
- Tests: creates isolated vault; second vault does not touch the first; requires
  initialized owner; token is single-use.

### 2. Bind owner pairing to the token's vault  (server)
In `onboarding-routes.ts` owner-pair handler, use the `vault_id` carried by the
consumed `owner_pairing` (already available from `pairOwnerDevice`) instead of
`loadFirstActiveVault`. Return that `vaultId` to the client.
- Tests: owner with two vaults, two pairing tokens → each token pairs the device
  into exactly its own vault.

### 3. Explicit vault in events bootstrap  (server)
The events bootstrap currently calls `loadFirstActiveVault(context.userId)`.
Change it to scope to an explicit `vaultId` (the client already holds one) and
verify membership for that `vaultId` before returning events.
- Tests: member of A and B bootstraps each vault independently; requesting a
  vault you are not a member of → 403, no events leaked.

### 4. Cross-vault isolation hardening + tests  ("zabezpiecz")
No new mechanism — prove and lock the existing isolation with adversarial tests,
and audit that every vault route enforces membership.
- Add tests: a member of vault A receives 401/403 (never data) on vault B's
  `/revisions`, `/wait`, `/events`, `/blobs/:hash`, and invitation approve/reject.
- Wake isolation: a commit in vault A must never release a `/wait` waiter parked
  on vault B (assert the wake registry is strictly per `vault_id`).
- Invitation isolation: an invitation created for vault A cannot be approved into
  vault B; approval mints a membership only in `invitation.vault_id`.
- Blob isolation: `/vaults/B/blobs/:hash` returns 404/403 for a hash that exists
  only because vault A stored it (content-addressed store is shared for dedup, but
  read requires B to actually reference the hash).
- Quota/rate-limit: confirm both are counted per `vault_id`, so one team can't
  exhaust the other's budget.
- Audit: grep every `instance.<method>('/vaults/:vaultId/...')` route and confirm
  each calls `loadActiveMembership` (or `requireOwner`) before side effects.

### 5. Migrations
Expected: **none** (schema is already vault-scoped and supports N vault rows).
If step 3/4 needs an index for lookup performance, add one forward-only,
checksummed migration. Confirm `PRAGMA foreign_keys` + existing indexes cover the
new query paths.

### 6. Docs
- Operator note: how to create and hand out a second vault
  (`create-vault` → give the token to the second team, they onboard as usual).
- State the isolation guarantee explicitly in `docs/`.

## TDD order (red → green → refactor, per item)

1. Isolation tests first (item 4) against the CURRENT code — they should already
   pass for sync routes (proves the base is sound) and FAIL where the
   single-vault shortcuts leak (items 2–3). This is our safety net before any change.
2. `create-vault` (item 1): red test for a second isolated vault → implement.
3. Owner-pair vault binding (item 2): red test → fix.
4. Events bootstrap vault selection (item 3): red test → fix.
5. Re-run full isolation suite (item 4) green.
6. Full gate: `npm run build && npm run typecheck && npm run lint && npm test`.

## Safety / rollout (mid-pilot)

- **Do the work on a branch `feat/multi-vault`. Do NOT deploy to the live pilot
  server during the current 7-day window.** Lesson already learned: no big
  mid-pilot server changes.
- Verify on a throwaway local server instance (create vault A + vault B, run the
  isolation suite, do a real two-vault onboarding end to end).
- Server rebuild/redeploy on `sapserver` is a `sudo`/`docker` step → **done by
  the user**, not the agent. Agent prepares source + exact commands.
- Rollout after the pilot window (or on a second fresh instance):
  1. deploy new image, 2. `create-vault --vault TeamB`, 3. hand the token to the
  second team, 4. they onboard into vault B; vault A is untouched.

## Workstream 2 — run Havemind on any server (portable deploy)

Goal: stand up a Havemind instance on a rented VPS or a friend's box, not only the
home server, with a clean one-command deploy.

What this actually needs (it is mostly packaging, not new server logic):

- **No hardcoded host.** Audit for any baked-in home-server hostname / IP / paths;
  everything host-specific must come from env/config (`PORT`, data dir, instance
  name). (A private hostname once leaked into a plugin placeholder — re-grep to be
  sure none remains in server or plugin.)
- **Self-contained deploy bundle:** a `docker-compose.yml` + `.env.example` + a
  short `DEPLOY.md` (create data volume, `docker compose up -d`, run
  `havemind setup`, then `create-vault` per team). One named volume for the SQLite
  DB + blobs; non-root, read-only, cap-dropped container (as today).
- **Tailnet-only — no other networking model.** Every Havemind instance is
  reached exclusively over Tailscale: the box (VPS or a friend's machine) **joins
  the tailnet** and is fronted by `tailscale serve`. Nothing is ever exposed to
  the public internet. Running on a VPS is just "a different machine on the
  tailnet" — almost no code change. Public/internet exposure is permanently out of
  scope for this project; do not design or build it.
- **Privileged steps stay with the operator.** Installing Docker/Tailscale, `sudo`,
  and `tailscale serve` on the new box are done by whoever owns that box, not the
  agent. The agent ships the bundle + exact commands.

## Estimated scope

Server-only, additive. ~3 focused changes + one isolation test suite. No client
changes. Likely no schema migration. Low risk to existing single-vault behaviour
because vault A keeps working exactly as today (it is just "the first vault").

## Open questions for sign-off

- Model A (single admin owns all vaults) confirmed, or do you want Model B
  (independent owners) — bigger, later?
- OK to keep the client model "one Obsidian vault per team" (no plugin change)?
