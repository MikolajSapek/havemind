# 014, AI agents as members of the vault

- Status: **Shipped in 1.10.0**, 2026-10-14, with plans 015 and 016. Phase 4 of `plans/011-after-1.7.md`; the
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
- **Agents are autonomous background workers, not chat** (owner,
  2026-10-14). The server-side runner is the main way; MCP is the second.
- **Where agents run: the user chooses per agent** (owner, 2026-10-14: "two
  options, the user picks"). One headless Havemind agent client, run either
  way, picked in "Add agent":
  1. **MCP first.** `npx @havemind/agent mcp` gives Claude Desktop, Claude Code
     or any MCP client tools on the vault. The client syncs through the
     Havemind server itself, so it does not need Obsidian open.
  2. **Always on the server.** The same client in a container next to the
     server runs the agent continuously or on its schedule, with the owner's
     model key, so it works while every laptop sleeps.
  One client, two ways to run it; both ship in the first agents release.

## What the tree has (read 2026-10-14)

- Roles are `owner | editor` (`migrations/001-initial.sql:52`).
- Sync logic lives in `packages/sync-core` and `packages/protocol`; the plugin
  wraps it with Obsidian adapters. A headless client reuses the packages and
  replaces the vault adapter with a folder on disk or an in-memory store.
- Attribution already names every revision's member (receipt `memberId`).
- Today an agent writing on a paired machine is that machine's owner
  (`docs/using-with-ai-agents.md`).

## Design

1. **Server: a member `kind`.** Migration adds `memberships.kind`
   (`person | agent`, default `person`) and `invitations.intended_kind`. The
   owner's invitation sets it; redeem copies it to the membership; the roster
   returns it. Permissions are an editor's. `/.well-known/havemind` advertises
   the capability `agent-members-v1`; the plugin hides "Add agent" without it
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
5. **Predefined agents** are autonomous: they run in the background on their
   own schedule and do work in the vault, never a chat (owner, 2026-10-14:
   chat already exists in the vault, e.g. Claudian; these must not duplicate
   it). Task-note templates, the owner's four plus one from research:
   - Inbox sorter: files notes from `Inbox/` into folders, adds tags.
   - Daily / weekly summary: writes a summary note of what changed and who.
   - Link gardener: finds orphan notes, suggests links, fixes broken ones.
   - Meeting to tasks: turns meeting notes into tasks with owners.
   - Clip digester: summarises web clips in `Clippings/` into short notes.

## Spike first (time-boxed)

Before step 1: can a headless client built on `sync-core` pair, push one
revision and show as its own member on the current server? Kill criteria: it
needs server changes beyond the role, or it duplicates the plugin's sync
engine instead of reusing it. Result goes in this file before any release.

**Result (2026-10-14): yes, neither kill criterion fired.**

- Pair, push, own member: already proven by `tests/e2e/onboarding-two-device.test.ts`,
  which drives a second device through the production onboarding controller,
  `RequestUrlTransport`, `SyncRunner`, outbox and vault apply against a real
  in-process server; its revisions carry the approval's own `membershipId`.
  No server change.
- Runs without Obsidian: an esbuild bundle (platform node) of the onboarding
  controller and API, onboarding store, access-token provider, transport,
  `DurableSyncState`, `VaultApplyAdapter`, `RevisionHistory`, connection
  resolvers, outbox, `VaultChangeObserver`, `reconcileVaultState` and
  `SyncRunner` has 112 inputs, none of them `obsidian`, and loads in plain
  Node. Only the assembly under `runtime/adapters/` (sync controller, push
  producer, sync loop) imports Obsidian; the headless client replaces that
  assembly with a filesystem one, reusing everything below it.
- Permissions: every owner action on the server (invite, approve, remove,
  rejoin grant) already refuses a non-owner (`role !== 'owner'` in
  `onboarding-routes.ts`, `revoke-routes.ts`, `rejoin-routes.ts`,
  `invitations.ts`, `rejoin-grants.ts`). An agent is therefore an editor plus
  a mark, not a new permission tier.

**Design change from the spike:** step 1 below becomes a `kind` on the
membership (`person | agent`), set by the owner's invitation and never by the
joining client (rule 3), instead of a third role. Same permissions as an
editor, so no route guard changes.

## Ships in

Server release with the role; plugin 2.0.0 (agents in the flower, People,
Activity); `@havemind/agent` 0.1 on npm with MCP. Scheduled server agents in a
later release.

## Risk and rollback

- A misbehaving agent: undo its changes, remove its membership (existing
  owner action), the server revokes its tokens.
- Scope is advisory: documented, plus attribution; server-side enforcement
  stays possible later without changing the task-note format.

## Built (2026-10-14)

1. Server: `memberships.kind` and `invitations.intended_kind` (migration 008),
   set by the owner's invitation; roster and pending approvals return it;
   discovery lists `agent-members-v1`. Rollback after 008 means restoring the
   backup taken before the update: an older server refuses a newer schema.
2. Plugin: agents in yellow (`--havemind-flower-agent`) in the flower, People
   ("AI agent", after the people) and Activity; the approval card says
   "As AI agent". Agent seats keep their initials rather than an "AI" label:
   two agents must stay distinguishable, and the colour already says "agent".
3. Headless client `apps/obsidian-plugin/src/headless`: the plugin's own sync
   code over a folder; `fetch`, 0600 state files, no runtime `obsidian`
   (bundle test). The file port detects folders by `TFolder.children`.
4. Runner: task note parse, `checkWrite` scope (never `Havemind/`,
   `.obsidian/`, conflicts, trash), runs only when due and when people changed
   notes, capped turns and writes, Claude over `fetch`.
5. `havemind-agent` CLI (join, run, once, mcp, list), MCP over stdio, one lock
   per agent; bundled in the server image and attached to releases; installer
   service `havemind-agents` behind the `agents` profile, key in `agents.env`.
6. Plugin: role "AI agent" in Invite someone with five ready-made tasks plus
   Custom; writes the task note and shows the join command.

Not yet: "Undo all of this agent's changes since…" (per-note Restore works),
deletes by agents, and the live test on a fresh machine with a real key.

