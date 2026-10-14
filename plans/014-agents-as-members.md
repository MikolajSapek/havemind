# 014, AI agents as members of the vault

- Status: **Proposed**, 2026-10-14. Phase 4 of `plans/011-after-1.7.md`; the
  owner chose this direction (over end-to-end encryption, for now).
- Owner's ask: add external agents and predefined ones; people stay violet,
  agents are yellow; each agent has written down what it must do in the vault.

## Goal

An agent joins a vault like a person does, as its own member. It has a yellow
hexagon in the flower, its changes are yellow and signed in Activity and in a
note's history, and each can be undone. What it is for and where it may write
is a note in the vault that people can read and edit.

## Decisions (owner, 2026-10-14)

- **Scope is kept by the agent's client, and every change can be undone.**
  The server stays blind to content and paths (rule 2). Advisory, said so
  plainly in the docs, backed by attribution and one-click undo.
- **Where agents run:** my recommendation, to confirm: one headless Havemind
  agent client, used two ways:
  1. **MCP first.** `npx @havemind/agent mcp` gives Claude Desktop, Claude Code
     or any MCP client tools on the vault. The client syncs through the
     Havemind server itself, so it does not need Obsidian open.
  2. **Scheduled on the server later.** The same client in a container next to
     the server runs predefined agents on a timer, with the owner's model key.
  This avoids building two clients and starts where the owner already works.

## What the tree has (read 2026-10-14)

- Roles are `owner | editor` (`migrations/001-initial.sql:52`).
- Sync logic lives in `packages/sync-core` and `packages/protocol`; the plugin
  wraps it with Obsidian adapters. A headless client reuses the packages and
  replaces the vault adapter with a folder on disk or an in-memory store.
- Attribution already names every revision's member (receipt `memberId`).
- Today an agent writing on a paired machine is that machine's owner
  (`docs/using-with-ai-agents.md`).

## Design

1. **Server: an `agent` role.** Migration widens the role check to
   `owner | editor | agent` and lets an invitation intend `agent`. The roster
   returns the role. An agent can read and push like an editor; it cannot
   invite, approve or remove. Old servers have no `agent`: the plugin hides
   "Add agent" when the server's `/.well-known/havemind` lacks the capability
   (rule 1 of plan 011).
2. **Agent task notes.** `Havemind/Agents/<Name>.md` in the vault:
   frontmatter `agent: <membership>`, `may_write: [folders]`, `schedule`
   (for later), `model` (for later); the body is the instructions in plain
   language. People edit it in Obsidian; it syncs like any note.
3. **Headless client `@havemind/agent`.** Pairs from an agent invitation (the
   owner still approves with the six digits, read off the client's terminal),
   keeps its own state file, syncs, and enforces `may_write` before every
   push. MCP tools: `list_notes`, `read_note`, `search`, `write_note`,
   `create_note`, `my_task` (reads its task note). Writes outside `may_write`
   are refused with the reason.
4. **Plugin.**
   - Flower: agent seats yellow (`--havemind-flower-agent: var(--color-yellow)`),
     a small "AI" label instead of initials; people stay lavender.
   - Activity and note history: agent rows with a yellow mark; "Undo all of
     this agent's changes since…" on its People row.
   - People: an "Agents" group under people, each with its task note link,
     folders and last activity; "Add agent" opens a picker of predefined
     agents or "Custom", creates the task note and the agent invitation, and
     shows the MCP setup snippet for Claude Desktop / Claude Code.
5. **Predefined agents** (task-note templates, owner picked all four, plus
   two from research):
   - Inbox sorter: files notes from `Inbox/` into folders, adds tags.
   - Daily / weekly summary: writes a summary note of what changed and who.
   - Link gardener: finds orphan notes, suggests links, fixes broken ones.
   - Meeting to tasks: turns meeting notes into tasks with owners.
   - Vault Q&A (read-only): answers questions from the vault, writes nothing.
   - Clip digester: summarises web clips in `Clippings/` into short notes.

## Spike first (time-boxed)

Before step 1: can a headless client built on `sync-core` pair, push one
revision and show as its own member on the current server? Kill criteria: it
needs server changes beyond the role, or it duplicates the plugin's sync
engine instead of reusing it. Result goes in this file before any release.

## Ships in

Server release with the role; plugin 2.0.0 (agents in the flower, People,
Activity); `@havemind/agent` 0.1 on npm with MCP. Scheduled server agents in a
later release.

## Risk and rollback

- A misbehaving agent: undo its changes, remove its membership (existing
  owner action), the server revokes its tokens.
- Scope is advisory: documented, plus attribution; server-side enforcement
  stays possible later without changing the task-note format.
