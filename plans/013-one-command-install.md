# 013, one-command server install and a connect link

- Status: **Proposed**, 2026-10-14. Next after `plans/012-note-history.md`.
- Owner's ask: "install the whole thing on a server in one click, and a
  tutorial for Tailscale and for the connection".

## Goal

On a Linux machine with nothing on it, one command ends with a link. Clicking
that link on the owner's computer opens Obsidian and connects the vault. No
copying server addresses or tokens by hand.

```bash
curl -fsSL https://github.com/MikolajSapek/havemind/releases/latest/download/install.sh | bash
```

## What the tree has today (read 2026-10-14)

- The server builds from source (`deploy/compose.yaml`, `build:`), so a first
  install compiles the monorepo on the target machine.
- Owner setup is a CLI step (`havemind.js setup --owner --vault`), printing an
  `hm_pt_...` pairing token; the owner pastes URL and token into the plugin.
- The plugin registers `obsidian://havemind-join` (`main.ts:238`) for
  invitations.
- `docs/self-hosting.md` covers Docker, Tailscale Serve, backups and updates,
  as ten manual sections.

## Design

1. **A published image.** CI builds `ghcr.io/mikolajsapek/havemind-server:<v>`
   on every server tag (multi-arch: amd64, arm64 for a Raspberry Pi), with a
   provenance attestation like the plugin's. The compose file gets an
   `image:` default; building from source stays possible.
2. **`install.sh`**, attached to each release, small and readable:
   - checks the OS (Debian/Ubuntu/Raspberry Pi OS first; others get a clear
     "not supported yet, here is the manual guide");
   - installs Docker and Tailscale with their **official** installers when
     missing, after saying what it will do and asking (`sudo` is the user's
     yes, never silent);
   - runs `tailscale up` when the machine is not on a tailnet yet, which prints
     the login link the user opens once;
   - writes `/opt/havemind/compose.yaml` and `.env`, pulls the image, starts it,
     waits for `/readyz`;
   - runs owner setup (asks for the owner's name and the vault name);
   - runs `tailscale serve` for HTTPS inside the tailnet (never Funnel);
   - prints one `obsidian://havemind-connect?...` link plus the same as a
     terminal QR code, and a one-line health summary.
   Re-running it is safe: it detects an existing install and offers update or
   a new pairing token, never a second server.
3. **`obsidian://havemind-connect`** in the plugin: takes the server URL and
   the pairing token, shows them for confirmation ("Connect this vault to
   havemind.tail1234.ts.net as owner?"), then runs the existing owner connect.
   The token is single-use and expires as today; the link carries nothing
   else.
4. **Tutorial.** `docs/install.md`, short, in steps with what you will see at
   each: get a machine, run the command, sign in to Tailscale (and install
   Tailscale on your laptop and phone, same account), click the link. The
   plugin's "I'll run the server" screen shows the one command and links to
   this page. `self-hosting.md` stays as the manual path.

## Rules

- Old plugins keep working: the server API does not change.
- The installer never opens anything to the public internet; Funnel stays a
  manual, explicit choice (repo rule 5 for our own server).
- No secrets in the link beyond the single-use pairing token; it is printed
  only to the terminal that ran the installer.

## Steps and tests

1. CI image publish (test: `compose-smoke` against the published image).
2. `install.sh` with `shellcheck` and a dry-run mode, tested in a throwaway
   Debian container (Docker present, Tailscale mocked).
3. Plugin `havemind-connect` handler (red test: link parsed, confirm shown,
   connect called once; malformed link refused with a message).
4. Docs and the host screen.
5. Live test: a fresh VM or the Raspberry Pi, from zero to a connected vault.

## Ships in

Server image + installer as a server release; plugin 1.9.0 for the link.
