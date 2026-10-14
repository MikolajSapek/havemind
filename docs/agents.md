# AI agents in your vault

An agent is a member of your vault that works on its own, in the background.
It is not a chat: it reads its task, waits until people change something, does
the work and goes quiet again. People stay violet in Havemind; agents are
yellow, in the flower, in People and in Activity. Every change an agent makes is
signed with its name and can be undone like anyone's.

You need Havemind 1.10 or newer on the server and in Obsidian, and an Anthropic
API key for the model.

## Ready-made agents

| Agent | What it does | Writes in |
|---|---|---|
| Inbox sorter | Files new notes from `Inbox/` into folders under `Notes/` | `Inbox`, `Notes` |
| Daily summary | Writes `Summaries/<date>.md`: what changed today, and who did it | `Summaries` |
| Link gardener | Adds links between related notes in a Related section | `Notes` |
| Meeting to tasks | Turns notes in `Meetings/` into task lists with owners and dates | `Tasks` |
| Clip digester | Writes a short digest of each web clip in `Clippings/` | `Clippings/Digests` |

Or pick **Custom** and write the instructions yourself.

## The task note

Each agent has one note, `Havemind/Agents/<Name>.md`, that says what it does:

```markdown
---
may_write: [Inbox, Notes]
every: 1h
---
For each new note in Inbox/, ...
```

- `may_write`: the folders it may create and change notes in, and everything
  below them. Anything else is refused.
- `every`: how often it may run: `30m`, `1h`, `1d`. It runs only when people
  changed something since its last run, so a quiet vault costs nothing.
- The text below: its instructions, in plain words.

Edit it in Obsidian like any note; the agent reads it again before every run.
An agent can never write in `Havemind/` (so it cannot change its own task
note), in `.obsidian/`, in `Havemind Conflicts/` or in the trash, whatever the
note says. It never deletes notes.

## Add an agent (runs on your server)

1. **Turn agents on, once.** On the server machine, put your model key in a
   file only you can read, and start the agents service:

   ```bash
   cd ~/havemind-server
   printf 'ANTHROPIC_API_KEY=%s\n' 'sk-ant-...' > agents.env && chmod 600 agents.env
   docker compose --profile agents up -d
   ```

   On Linux, prefix the `docker` commands with `sudo` if your user is not in
   the `docker` group. The key stays in that file; Havemind never writes it
   anywhere else, and the vault never sees it.

2. **Invite it.** In Obsidian, open Havemind, **People**, **Invite someone**.
   Set the role to **AI agent**, pick a task, optionally change the name, and
   **Create invitation**. Havemind writes the task note and shows the
   invitation and one command.

3. **Let it join.** On the server machine, run the command Havemind shows:

   ```bash
   docker compose --project-directory ~/havemind-server run --rm -it havemind-agents node agent/havemind-agent.mjs join
   ```

   Paste the invitation when it asks. It prints six digits.

4. **Approve it.** Type the six digits in Havemind (the card says "As AI
   agent"). The agent appears in yellow. From now on it runs on its own; the
   agents service checks every minute whether it is due.

To see what agents did: `docker compose --profile agents logs havemind-agents`,
or the yellow rows in **Activity**.

## Use an agent from Claude Code (MCP)

The same agent can be driven by Claude Code or Claude Desktop instead, through
MCP. It keeps the same name, colour and folders.

1. Download `havemind-agent.mjs` from the latest
   [release](https://github.com/MikolajSapek/havemind/releases/latest) onto
   the computer that runs Claude Code (Node 22 or newer, and Tailscale on that
   computer, signed in to your tailnet).
2. Invite an agent in Havemind as above, then on that computer run
   `node havemind-agent.mjs join`, paste the invitation and approve the six
   digits.
3. Add it to Claude Code:

   ```bash
   claude mcp add havemind-inbox -- node /path/to/havemind-agent.mjs mcp "Inbox sorter"
   ```

Claude Code then has `my_task`, `list_notes`, `read_note` and `write_note`,
the last one held to the agent's folders. One agent runs in one place at a
time: if the background service already runs it, the MCP session says it is
busy. Invite a separate agent for Claude Code.

## Undo and remove

- Every note an agent changed shows it in **Activity** and in the note's
  history; **Restore** puts the earlier version back.
- To stop an agent for good, **People**, the agent, **Remove**. Its tokens stop
  working at once.
- To pause all agents: `docker compose --profile agents stop havemind-agents`.

## What it costs

Each run that finds people's changes makes a few model calls (at most 12 turns
and 20 note writes per run). Pick `every` to match how often you want it.
