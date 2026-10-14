# 013, one-command server install and a one-paste connect code

- Status: **Shipped in 1.9.0 to 1.9.2**, 2026-10-14 (Linux and macOS).
- Live test, 2026-10-14: a fresh AWS t4g.small, Ubuntu 24.04 arm64, nothing
  installed. The published `curl | bash` installed Docker and Tailscale, the
  owner signed the machine into the tailnet with one link, and an empty vault
  on a Mac connected with the pasted line (owner pair 200, first revision 200,
  pane "In sync"). The test found three bugs the dry-run tests could not:
  `/etc/os-release` replacing `VERSION` (1.9.0, caught by CI), a root-owned
  data volume and a half-finished setup on re-run (1.9.1), and `docker compose
  exec` eating the piped script (1.9.2). Each has a regression test.
- Not yet tested live: the macOS server path (Docker Desktop or OrbStack).
- Owner's ask: "install the whole thing on a server in one click, and a
  tutorial for Tailscale and for the connection".

## Goal

On a Linux machine or a Mac with nothing on it, one command ends with one line
to paste into Havemind in Obsidian. No server address and token typed into two
fields.

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
   - writes `~/havemind-server/compose.yaml` and `.env`, pulls the image, starts it,
     waits for `/readyz`;
   - runs owner setup (asks for the owner's name and the vault name);
   - runs `tailscale serve` for HTTPS inside the tailnet (never Funnel);
   - prints one line, `hm_pt_…@https://<machine>.<tailnet>.ts.net`, to paste.
   Re-running it is safe: it detects an existing install and offers update or
   a new pairing token, never a second server.
3. **One-paste code, not a link.** A link (`obsidian://havemind-connect`) was
   the first idea, but the plugin's rule is that secrets never arrive through
   an `obsidian://` URI (`isSafePassiveJoinProtocolData`): any page could fire
   one. So the server CLI prints the pairing token joined to its own origin,
   `hm_pt_…@https://server`, and the connect form splits it
   (`resolvePairingCode`). The token alone plus the Server URL field still
   works; a code whose origin disagrees with the field is refused.
4. **Tutorial.** `docs/install.md`, short, in steps with what you will see at
   each: get a machine, run the command, sign in to Tailscale (and install
   Tailscale on your laptop and phone, same account), paste the line. The
   plugin's "I'll run the server" screen shows the one command and links to
   this page. `self-hosting.md` stays as the manual path.

## Rules

- Old plugins keep working: the server API does not change.
- The installer never opens anything to the public internet; Funnel stays a
  manual, explicit choice (repo rule 5 for our own server).
- No secret in the code beyond the single-use pairing token; it is printed
  only to the terminal that ran the installer.

## Steps and tests

1. CI image publish (test: `compose-smoke` against the published image).
2. `install.sh` with `shellcheck` and a dry-run mode, tested in a throwaway
   Debian container (Docker present, Tailscale mocked).
3. Plugin one-paste code (red test: code split, origin mismatch refused, the
   old two-field input unchanged).
4. Docs and the host screen.
5. Live test: a fresh VM or the Raspberry Pi, from zero to a connected vault.

## Ships in

Server image + installer as a server release; plugin 1.9.0 for the one-paste code and the host screen.
