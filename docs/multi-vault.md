# Multi-vault support

**Implemented.** One Havemind server hosts several independent, isolated
vaults in a single container: Mikolaj and Hubert share vault A, Janek and
Maciek share vault B, and neither team can see, wake, or write the other's
data.

This file replaces a 220-line implementation plan that sat at "proposed
(awaiting go)" long after the work shipped.

## The model that shipped

**Model B, independent owners per vault.** Every vault has its own owner, who
invites, approves and revokes that vault's members with no relation to any
other vault. Owner-ness is `memberships.role = 'owner'`, already per vault, so
the authorization layer supported this natively.

The only true singleton is `users.is_instance_owner = 1`, which marks the
account that ran `setup`. It confers no cross-vault authority.

## What the plan called blocking, and where each was closed

| Blocker | Resolution |
|---|---|
| No way to create a second vault | `create-vault --owner <name>` in `apps/server/src/setup/cli.ts` |
| `loadFirstActiveVault` pinned a two-vault user to the older one | `/bootstrap` takes `?vault=`, and membership is verified before the vault is served (`onboarding-routes.ts`) |
| Owner pairing tokens minted only at `setup` | `create-vault` mints its own pairing for the secondary owner (`cli.ts:152`) |

## How isolation is enforced

Every sync path keys on `vault_id` and checks membership before doing anything:

- `memberships (vault_id, user_id, role, status)` with `UNIQUE (vault_id, user_id)`
- `/vaults/:vaultId/revisions|wait|blobs`, each calling
  `loadActiveMembership(user, vaultId)` first
- Invitations are per vault; approval mints a membership scoped to
  `invitation.vault_id`
- Blob presence, storage quota and the wake registry are all per `vault_id`

Nine tests in `apps/server/src/auth/multi-vault-isolation.test.ts` hold this,
including the case that matters most: naming a vault you hold no membership in
returns 403 and no events.

## Creating a second vault

On the server, as the operator:

```bash
node apps/server/dist/setup/cli.js create-vault --owner "Janek"
```

It prints a pairing token for that vault's owner, who uses it exactly as the
first owner used theirs.
