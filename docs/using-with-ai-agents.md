# Using Havemind with Claude and AI agents

**How it works, in one line:** an AI agent uses Havemind by reading and writing
files in the shared vault folder on a synced, connected machine, it never talks
to the Havemind server directly.

## Requirements (all must be true)

1. **Obsidian is open** on that machine, with the Havemind plugin **enabled and
   showing Connected**. Sync runs while Obsidian is open.
2. **Tailscale is connected** on that machine, so the server is reachable.
3. The machine is a **paired device**, the owner, or an approved member of the
   vault.
4. The agent reads and writes **inside the same vault folder** the plugin watches.
5. The agent touches **notes and attachments only**, never `.obsidian/` (plugin
   config is excluded and never synced).

## Connect an agent (steps)

1. Point the agent, or its MCP server (e.g. an Obsidian MCP), at the **vault
   folder path**.
2. Keep **Obsidian open and Connected** on that machine while the agent works.
3. Let the agent create and edit notes, changes sync to every other device in
   **about a second**, with authorship recorded.

## Good to know

- **Authorship is per device, not per agent.** Every agent running on one machine
  shares that device's identity in the Activity panel.
- **Append-only and conflicts apply to agents too.** A genuine clash lands as a
  conflict copy under `Havemind Conflicts/`, both versions kept, nothing silently
  overwritten.
- **If Obsidian is closed** on that machine, the agent's edits are not pushed until
  you reopen it and it reconnects. They queue on disk and sync on the next open.
- **Many writers at once is the point.** Several people and several agents can
  write the same vault together.

## Two people, two Claudes, one vault

Each person runs Obsidian with the plugin connected on their own machine, and
points their own Claude/agent at their local vault folder. Havemind keeps all of
it one continuously-synced brain.

For installing the plugin and running a server, see the project README and
[docs/self-hosting.md](self-hosting.md).
