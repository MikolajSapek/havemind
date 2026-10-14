# 015, add an agent with one click

- Status: **Shipped in 1.10.0**, 2026-10-14; tested live on AWS (Ubuntu arm64). Follows `plans/014-agents-as-members.md`.
- Owner's ask: "a button, add agent, and that's it": no invitation to copy,
  no command on the server, no six digits. The model comes from an API key
  given once, or from Claude Code on the owner's computer (MCP).

## Why the six digits can go for agents

The six digits prove that the device joining is the one the owner meant,
when a person on another machine redeems an invitation sent over some channel.
An agent added from the owner's own logged-in plugin, and picked up by the
agents service on the owner's own server, travels no such channel: the
owner's session is the proof. People keep the six digits.

## Design

1. **Service token.** The installer generates `HAVEMIND_AGENT_SERVICE_TOKEN`
   (32 random bytes) into `.env` (server) and `agents.env` (agents service),
   both 0600, never into the vault or the plugin. The server enables the
   service routes, and lists `agent-service-v1` in discovery, only when it is
   set. Compared in constant time.
2. **Enrollment (owner).** `POST /vaults/:vaultId/agents {name}`, owner only:
   stores an enrollment (vault, name, the owner's membership and device). No
   secret is created yet.
3. **Claim (service).** `POST /agent-service/claim {initialRefreshToken,
   redemptionId}` with the service token. The service writes both to the new
   agent's state folder BEFORE calling, so a lost response is retried with the
   same values. The server, in ONE transaction: takes the oldest unclaimed
   enrollment, creates an agent invitation as that owner, redeems it with the
   service's refresh token, approves it with the code it just made, and marks
   the enrollment claimed with the `redemptionId`. A repeat with that
   `redemptionId` returns the same identity. Returns vault, membership,
   device, names and `apiBaseUrl`, never a token (the service made the
   refresh token). 204 when nothing waits. An enrollment whose owner device or
   membership is gone is dropped with a reason, never retried.
4. **Model key, a file, never the database.** The database is in every backup,
   and backups are shipped off the machine. A bind mount `./agent-secrets`
   (uid 1000, 0700), read-write in the server, read-only in the agents
   service, outside the data volume and `./backups`. `PUT
   /vaults/:vaultId/agent-model {key}` (owner) writes `model.key` 0600; `GET`
   says only whether it is set. The agents service reads the file. The key is
   never logged, never returned, and the plugin takes it in a password field
   and keeps it nowhere.
5. **Agents service** runs by default (no profile) and never crash-loops: it
   starts without a key, claims and syncs, and runs agents only once the key
   file exists. Its server URL comes from `HAVEMIND_API_BASE_URL`. A claimed
   agent's identity is `identity.json` beside its secrets; it does not go
   through the onboarding controller.
6. **Names are unique.** Enrollment refuses a name an active member already
   has, and a pending enrollment's name.
7. **Plugin.** People: **Add agent** (owner, server lists
   `agent-service-v1`): pick a task, optional name, and the key if the server
   has none yet. One click writes the task note and enrolls the agent; it
   appears in yellow within a minute. Older servers keep the invitation path.
8. **Status block.** The composer keeps a status above the tabs (phones show
   no status bar, the 1.1.3 defect), but as one compact line with the status
   glyph, not the old block.
9. **sapserver and the manual stack.** `deploy/compose.yaml` and
   `docs/self-hosting.md` get the agents service, the token and the secrets
   mount too.

## Rules

- Rule 2: the server still never reads paths or content; it only creates a
  membership and stores a key.
- Rule 4: the key and the service token never reach a log, the vault or a
  response to the plugin.
- Old plugins: the invitation path is unchanged.

## Steps and tests

1. Server: migration 009 (enrollments), routes, red tests: owner only,
   service token only, claim creates an agent member with the service's
   refresh token, same `redemptionId` twice gives one member, two claims for
   one enrollment give one winner, duplicate name refused, key never echoed
   and never in the database, routes absent without a token.
2. Headless: adopt a claimed identity; run loop claims; key from config.
3. Plugin: Add agent, key prompt, capability gate.
4. Installer: token generation, agents service on by default.
5. Live test on the AWS box, then release.
