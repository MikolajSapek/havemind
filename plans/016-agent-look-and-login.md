# 016, agents: pixel icons, a designed Add agent, and Claude login

- Status: **Shipped in 1.10.0** except step 5 (Claude Code on this computer), which needs a desktop helper: the plugin may not start programs. Codex, any OpenAI-compatible model and bulk undo were added on the owner's ask. Follows `plans/015-one-click-agents.md`.
- Owner's ask: the agent UI must be properly designed; every agent gets a
  small pixel icon; and a way in without an API key: "log in through the
  CLI". Owner's choices: both login ways selectable; icons in the Add agent
  picker, the People row, the flower seat and Activity.

## Design

1. **Pixel icons.** One 12×12 pixel drawing per ready-made agent (Inbox
   sorter: a tray and an arrow; Daily summary: a calendar page; Link
   gardener: a sprout; Meeting to tasks: a checklist; Clip digester:
   scissors; Custom: a small robot), as data, drawn as SVG squares with
   `shape-rendering: crispEdges` in the theme's ink, on the agent yellow.
   The task note carries `icon: <id>`; the plugin reads it from the vault
   (the server never knows), falling back to the robot.
   - Add agent: a grid of tiles (icon, name, one line), one selected.
   - People: the icon in a small yellow square before the name.
   - Flower: the icon inside the agent's yellow hexagon instead of initials;
     the accessible name keeps the agent's name.
   - Activity: the icon before the note title on the agent's rows.
2. **Add agent, designed.** Tiles; name; then "How it thinks" as three
   choices: **Claude subscription** (runs on the server, 24/7),
   **API key** (runs on the server), **Claude Code on this computer**
   (desktop only; runs while Obsidian is open). Each shows only what it
   needs; one primary button. Copy is plain and short.
3. **Claude subscription on the server.** The owner runs
   `claude setup-token` once (Claude Code, logged in to their Claude
   account) and pastes the token. The server stores it like the key, in
   `agent-secrets/model.oauth` (0600, never the database). The agents image
   carries Claude Code (pinned); a run with this login calls
   `claude -p` once per run, no tools, in an empty folder, with the changed
   notes as data, and reads back a JSON list of writes, each through the
   same scoped write path. Same caps.
4. **Claude Code on this computer.** Desktop Obsidian only. The plugin
   enrolls the agent and claims it itself with the owner's session (a new
   owner route, so no service token on the laptop), keeps its tokens in the
   plugin's secret storage, mirrors the vault for it in the plugin's folder,
   and runs it on its schedule with the local `claude -p` (already logged
   in; nothing to paste). It runs only while Obsidian is open, and says so.

## Steps

1. Icons: data, renderer, the four places, task note `icon:`; tests.
2. Add agent redesign with the three choices; tests.
3. Server: `oauthToken` beside `key`; owner claim route; tests.
4. Agents image: Claude Code pinned; runner one-shot mode; tests with a stub
   `claude`.
5. Plugin local runner (desktop).
6. Live test on the AWS box (subscription) and this Mac (local), then
   release.
