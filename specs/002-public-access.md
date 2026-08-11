# Havemind zero-configuration connection amendment

- Status: **Approved by owner on 2026-07-15**
- Date: 2026-07-15
- Amends: `001-mvp.md`

## Objective

The Havemind plugin must not be coupled to Tailscale or require users to manually configure IP addresses, ports, tokens or reverse proxies.

This requirement does **not** make `sapserver` an open community server. The owner's instance remains private, has no public registration and accepts only explicitly invited members.

## Product boundary

There are two different user experiences:

1. **Joining a shared vault** must be almost zero-configuration.
2. **Hosting a new Havemind server** is an administrator action. It can be simplified with Docker and a setup wizard, but it still requires storage and a secure HTTPS route.

Someone installing the community plugin does not automatically connect to Mikolaj's server. Each shared vault belongs to a specific Havemind instance selected by its owner.

## Transport-independent plugin

- The plugin communicates with a versioned HTTPS API and has no hard dependency on Tailscale, Cloudflare, Caddy or any other ingress provider.
- A server exposes a minimal `/.well-known/havemind` document containing only its name, API base URL, protocol version and supported authentication methods.
- The plugin validates that discovery document, checks protocol compatibility and derives all API URLs automatically.
- The same plugin build works with:
  - private Tailscale Serve;
  - a normal public HTTPS domain;
  - Cloudflare Tunnel or a similar outbound tunnel;
  - a direct reverse proxy such as Caddy;
  - localhost/LAN only for development.
- Changing the server hostname or ingress must not change the synchronization protocol or attribution model.

Our first `sapserver` pilot may remain behind Tailscale for network privacy. That is a deployment choice for our instance, not a requirement built into the plugin.

## Built-in Havemind membership

Authentication and authorship are handled by Havemind itself, even when Tailscale is also present. This keeps behavior identical across deployment types.

- No open registration.
- The server owner creates members and invitations.
- Every invitation belongs to one server, one shared vault and one intended member.
- Every accepted revision receives its authoritative `actor_id` from the authenticated Havemind session.
- Tailscale identity headers may be checked as optional defense-in-depth on a private deployment, but they are not the portable source of product identity.

### Owner bootstrap

1. The server creates a one-time owner bootstrap code during setup.
2. The owner enters it once in the Obsidian connection wizard.
3. Redemption creates the owner and first device, then invalidates the code.

### Collaborator invitation

1. The owner selects `Invite person`, enters a display name and copies a friendly link.
2. The server creates a 256-bit one-time invitation, stores only its hash and expires it after 15 minutes.
3. The recipient opens the normal HTTPS landing page, selects `Copy secure invitation`, and opens the versioned `obsidian://havemind-join` link. The link opens the wizard but carries no secret in its query.
4. The recipient pastes the copied canonical envelope once. The plugin discovers the server, displays its verified hostname, shared-vault name and inviter, then asks for confirmation.
5. After redemption, the plugin stores the refresh credential through Obsidian SecretStorage and performs a resumable initial download.

Redeeming the short-lived invitation creates a pending device. The owner approves it after both people compare the same human-readable verification phrase; this is the secure default for the private pilot and public deployments.

Obsidian's public protocol-handler API exposes query parameters but does not
expose a URL fragment. Havemind therefore does not put an invitation capability
in an `obsidian://` query, where operating-system or application URL handling
could retain it. The secure copy/import step is the supported pilot path. A
future zero-click handoff requires a separately reviewed, non-bearer mechanism;
private Electron APIs are not an acceptable workaround.

## Connection experience

### Joining an existing vault

```text
Install Havemind
  -> Open invitation
  -> Review server and vault
  -> Select Connect
  -> Automatic initial download
```

The joining user does not type:

- an IP address;
- a port;
- a Tailscale address;
- an API token;
- a database or Docker setting.

### Connection card

Plugin settings show one clear card:

- server name and verified HTTPS hostname;
- shared-vault name;
- current user and device;
- `Synced`, `Syncing`, `Offline` or `Conflict`;
- last successful synchronization;
- owner-only member and invitation actions;
- `Disconnect this device`.

Connection diagnostics use human language and actionable steps rather than raw network errors.

## Simple self-hosting package

The repository will provide one supported Docker Compose deployment and a first-run setup wizard.

The administrator supplies only:

- persistent data location;
- HTTPS hostname or selected private-network preset;
- backup destination before production use.

The setup validates:

- HTTPS and hostname consistency;
- writable persistent storage;
- protocol/server version;
- backup configuration;
- whether the service is accidentally exposed beyond the selected mode.

Advanced proxy, database and container settings remain hidden unless the administrator explicitly opens an advanced section.

## Sessions and security

- Random opaque access tokens expire after 15 minutes and remain in memory only.
- Random opaque refresh tokens are stored through Obsidian SecretStorage, expire after 30 days and rotate on use.
- The server stores token hashes, not raw tokens.
- The owner can list and revoke members and devices.
- Invitations and credentials never appear in Activity, application logs or Markdown files.
- All API inputs are validated; requests have strict size limits and rate limits.
- Public deployments add pre-authentication IP limits, strict Host/Origin handling and stronger invitation/device controls.
- Private deployment does not weaken application authorization; it only reduces the reachable attack surface.

## Changes to the original MVP specification

The following earlier assumptions are superseded:

- Tailscale is not required by the plugin and is not the universal identity provider.
- The invitation contains enough validated discovery information to configure the connection automatically.
- Havemind sessions provide portable identity and attribution on every deployment type.
- `sapserver` remains a private, invitation-only instance; this amendment does not enable public registration or make it a shared backend for unrelated plugin users.

All synchronization, deletion, provenance, conflict, overlay, backup and real-vault safety requirements remain unchanged.

## Acceptance criteria

- The same plugin build connects to both a Tailscale-private test server and a normal HTTPS test server.
- A collaborator joins through one invitation without manually entering network configuration or credentials.
- Installing the plugin alone reveals no private server and grants no access to `sapserver`.
- An uninvited user cannot list server vaults, members, paths, revisions or activity.
- Changing the ingress hostname does not change stored revisions or attribution identities.
- A self-hoster can start the supported stack from documented Docker Compose configuration and complete setup through the wizard.
- The plugin clearly distinguishes connection errors, expired invitations, incompatible protocol versions and revoked access.

## Decision

The owner approved a transport-independent plugin with zero-configuration invitations, while keeping `sapserver` private and invitation-only. The initial private pilot may still use Tailscale as infrastructure, but other Havemind deployments do not have to use it.
