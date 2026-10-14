<p align="center">
  <img src="design/brand/havemind-banner-white.png" alt="Havemind, a shared Obsidian vault for people you trust" width="100%">
</p>

<p align="center">
  <img src="design/brand/havemind-hero.gif" alt="A note written on a MacBook appears on an iPhone about a second later; on the MacBook the Havemind flower spins while it sends and turns green when done" width="100%">
</p>

# Havemind

### Share one Obsidian vault with people you trust.

Havemind is self-hosted sync for [Obsidian](https://obsidian.md), built for two
or three people sharing one vault. Everyone keeps a normal local copy. A server
you own passes the changes around and remembers who wrote what.

Built for people. If you also run Claude, MCP or another local agent in that
vault, its edits land in the same history.

**Version 1.10.2, desktop and mobile.** AI agents join your vault with one click: background workers, in yellow, each with a task note. A two-week pilot on two devices lost no
data, including through three real incidents.

There is no end-to-end encryption. Your server stores the vault in plaintext,
so whoever runs that machine can read it. Read the
[security model](#security-model) before you connect a vault you care about.

**Self-hosting your own instance?** One command sets it up, see
[docs/install.md](docs/install.md); the manual guide is
[docs/self-hosting.md](docs/self-hosting.md).

**New here?** The [tutorial](docs/tutorial.md) goes from zero to a shared
vault with five AI agents, step by step, with screenshots.

**AI agents as members?** Background agents (inbox sorter, daily summary and
more) join your vault in yellow, each with a task note: see
[docs/agents.md](docs/agents.md).

## Install

Havemind needs two things: the plugin, and a server you run.

**The plugin.** In Obsidian, open Settings, then Community plugins, then
Browse, and search for **Havemind**. Install it and enable it. It runs on
macOS, Windows, Linux, iOS and Android, and needs Obsidian 1.11.4 or newer.

**The server.** There is no Havemind cloud to sign up for: you host it, or you
join someone who does. See [Quick start](#quick-start) below.

## Quick start

Two paths, depending on whether you are the one running the server.

### You are hosting

1. **Set up Tailscale.** Make a free account, turn on MagicDNS and HTTPS
   certificates in its admin console, and install the app on your laptop and
   phone. Everyone who syncs joins the same tailnet; nothing is exposed to the
   public internet.
2. **Run one command** on the machine that will be the server (Linux:
   Debian, Ubuntu or Raspberry Pi OS; or a Mac that stays awake):

   ```bash
   curl -fsSL https://github.com/MikolajSapek/havemind/releases/latest/download/install.sh | bash
   ```

   It asks before installing Docker or Tailscale, starts the server inside
   your tailnet, and ends with one line, `hm_pt_...@https://...`.
3. **Connect the plugin.** Open the Havemind pane in Obsidian, choose
   **I'll run the server**, then **I've done this, connect**, and paste that
   line. The Status tab says **In sync** when it is working.
4. **Invite the other person.** People tab, then Invite someone. Send them the
   invitation; it works once.
5. **Approve their device.** They read a 6-digit code aloud to you, you type
   it in. Three attempts. That handshake is what binds their identity, so do
   it by voice, never by message.

Every step, with what you will see, is in [docs/install.md](docs/install.md).
To build and run the server by hand instead, see
[docs/self-hosting.md](docs/self-hosting.md).

The long version, including backups and multiple vaults, is in
[docs/self-hosting.md](docs/self-hosting.md).

### You are joining someone else's vault

1. Install Tailscale, log in, and accept the invitation to their tailnet.
2. Install the Havemind plugin in Obsidian.
3. Open the invitation the owner sent you.
4. Your device shows a **6-digit code**. Read it aloud to the owner over a
   call, never in a chat message.
5. Once they approve, the vault syncs. It appears in your Obsidian like any
   other vault.

## What it does

- **One vault, every device.** Mac, Windows, Linux, iPhone, Android. Write on
  the phone, it is on the laptop a couple of seconds later.
- **Nothing is overwritten silently.** Edits that do not overlap merge on their
  own. When two people change the same lines, both versions survive and a copy
  lands in `Havemind Conflicts/`.
- **You can see who wrote what.** Every change in the Activity panel carries
  its author's name when the member can be resolved. The author identity comes
  from the server with the revision; unknown authors keep a neutral label.
  The Activity feed keeps the last 200 entries on the device, across
  restarts. Restore on an entry puts that note back to the text it had
  then, as a normal edit that syncs; the current text stays in history.
- **Every note has its history.** "Show history of this note" (command
  palette or the file menu) lists each synced version with who made it and
  when it reached the server, shows how a version differs from the note now,
  and restores it.
- **Notes, attachments and how the vault looks.** Markdown notes, images and
  PDFs up to 25 MB, plus your theme, snippets, hotkeys and
  graph settings.
- **Joining takes a phone call.** The new device shows six digits, the owner
  types in what they hear. Three tries. That is what ties a person to a device.

<details>
<summary>The details behind those five</summary>

| | |
|---|---|
| Sync speed | A peer's change lands in about a second over the long-poll channel. An edit waits 1.5 s to settle first, reducing bursts from format-on-save tools. Incompatible formatter settings can still cause churn. Creates, renames and deletes go out immediately. |
| `.obsidian/` scope | An allowlist, nothing more: `themes/`, `snippets/`, `hotkeys.json`, `graph.json`, `appearance.json`, `app.json`, `core-plugins.json`. |
| Attachments | PNG, JPG, GIF, WebP, SVG, PDF, up to 25 MB, byte for byte. Other files (Canvas, Bases, audio, video) are not synced; the plugin says how many it skipped. |
| Crash safety | The outbox survives a crash. A torn state file is kept as a sidecar and flagged, never dropped. |
| Members | The owner sees who is in the vault and can remove them. A device whose session died reconnects with Rejoin, no new code. |
| Several vaults | One server, independent vaults. Two teams share a box without seeing each other's data. |
| Backups | Off unless you set `HAVEMIND_BACKUP_DIR`; the shipped compose file sets it. Then a snapshot every 24 h, last 7 kept, in plaintext like the live data; encrypt copies off the server (the ops scripts use restic). |
| Limits | Storage quota per vault, throttling per device. |

</details>

## What it looks like

<p align="center">
  <img src="docs/images/01-status-framed.png" alt="The Status tab on a MacBook: the server in the middle, green when in sync, one hexagon per device around it" width="100%">
</p>

<p align="center">
  <img src="docs/images/03-people-framed.png" alt="The People tab listing the owner and two editors" width="100%">
</p>

<p align="center">
  <img src="docs/images/05-agents-status-framed.png" alt="The Status tab with AI agents: you in violet, five agents in yellow with pixel icons, around a green server" width="100%">
</p>

<p align="center">
  <img src="docs/images/04-mobile-framed.png" alt="The Havemind pane on an iPhone: the flower with a green core, and In sync" width="49%">
  <img src="docs/images/11-mobile-activity.png" alt="Activity on an iPhone: Inbox sorter, an AI agent, filed a note a person had just written" width="49%">
</p>

## What it will not do

- **Run in our cloud.** There isn't one. The server is your hardware, reachable
  only over your [Tailscale](https://tailscale.com) network.
- **Sync your plugins.** `.obsidian/plugins/` never crosses: not the code, not
  the state, not the `data.json` secrets. Nor does your enabled-plugin list or
  window layout. So nobody can swap out your plugin code and have Obsidian run
  it, and two machines can keep entirely different plugin sets. Blocked paths
  are refused twice, once when a revision is written and again when one
  arrives, so an older peer cannot push what a newer one forbids.
- **Think about your notes.** The server holds blobs and revision headers.
  Diffs, merges and authorship happen on your machine.

## Architecture

```
Obsidian plugin (Vault A) ─┐
                           ├── HTTPS over tailnet ──► opaque server (Fastify + SQLite)
Obsidian plugin (Vault B) ─┘   real-time /wait wake     content-addressed blob store
```

The plugin does the thinking: watching the vault, a durable outbox that
survives a crash, the pull-and-apply loop, three-way merges, conflict copies,
the activity log. Your files are never rewritten to canonicalise them; that
happens on the hash side only.

The server is deliberately dumb. Fastify and SQLite in WAL mode, blobs stored
by content hash, and the long-poll that wakes your other devices. It rotates
refresh tokens and spots reuse, rate-limits per device, holds each vault to its
quota, and sweeps orphaned blobs at startup. Non-root, read-only, capabilities
dropped.

## Security model

**AI agents** (optional) are the one exception to "nothing leaves your
server": a running agent sends the notes people changed, and the vault's note
paths, to the model provider the owner picked. With a local Ollama nothing
leaves. See [docs/agents.md](docs/agents.md).

Security here rests on Tailscale, not on encryption inside the app. The server
answers only on your private tailnet, never the public internet, and Tailscale
(WireGuard) encrypts everything in transit with per-device authentication.

Between members of a vault, the line is drawn at code. Appearance settings
cross: themes, snippets, hotkeys, `graph.json`, `appearance.json`, `app.json`
and `core-plugins.json`, which toggles Obsidian's own built-in modules.
`.obsidian/plugins/` never crosses. Plugin code, state and secrets stay on the
machine they live on, so one member cannot overwrite another's plugin and have
Obsidian run it on the next reload.

The vault sits on the server in plaintext. **Whoever controls that machine can
read everything.** Run it on hardware you and your people trust, keep it on the
tailnet (never turn on Tailscale Funnel), and treat access to the server as
access to the vault. End-to-end encryption is out of scope on purpose: this is
a small tool for a circle that already trusts each other, not a zero-trust
service. See [known limitations](docs/pilot/known-limitations.md) for the
current operational caveats.

## Privacy and permission disclosures

No telemetry, no analytics, no ads, no accounts we operate, no hard-coded
server. The plugin makes its first network request only after you connect a
vault, and none at all while disconnected.

- **Network.** Every request goes to the one HTTPS address you typed when
  connecting. They carry invitations, device authentication, revisions and
  blobs, membership state, and the held long-poll that makes sync feel
  immediate. That server is yours, not ours, and it stores your notes in
  plaintext.
- **Reading your vault.** On first reconciliation and when resolving a
  conflict, the plugin lists vault paths to spot creates, deletes, renames and
  conflicts. It reads and sends only notes, allowed attachments, and the
  `.obsidian/` appearance allowlist above.
- **Clipboard.** Write-only, once, when the owner presses Copy invitation. The
  plugin never reads your clipboard and never logs the invitation.
- **Base64.** A transport encoding for binary payloads. Not encryption, not
  obfuscation, and not a way to hide code or URLs.

The Community directory asks for network use to be spelled out in the README,
which is why this section exists.

## Documents

**If you are running it**

- [Tutorial](docs/tutorial.md), zero to a shared vault with AI agents
- [Self-hosting guide](docs/self-hosting.md), zero to working server
- [Current limitations](docs/pilot/known-limitations.md), the caveats that bite
- [AI agents as members](docs/agents.md), background agents with task notes
- [Using it with AI agents](docs/using-with-ai-agents.md)

**If you are working on it**

- [Technical plan](plans/001-technical-plan.md), the architecture and the
  engineering contract
- [MVP spec](specs/001-mvp.md), what the product promised to be
- [Contributing](CONTRIBUTING.md) and [decisions](DECISIONS.md)

## Local verification

Requires Node.js 22 and npm 10.

```bash
npm ci
npm run verify      # workspace/release checks, lint, typecheck, all tests, build
npm run test:e2e     # run only the two-device tests (also included in verify)
npm run test:coverage # coverage thresholds, checked separately in CI
```

`npm run verify` is the baseline local check before a release. CI also checks
coverage, design tokens, the generated plugin class list, release artifacts
and private-infrastructure markers; a passing local verify does not replace
a passing CI run. The individual steps (`npm run build`, `npm run typecheck`,
`npm run lint`, `npm test`) are still there when you want to run just one.

Do not point a development build at an existing important vault. Use a dedicated
test vault for development and automated testing.
