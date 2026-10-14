# Install Havemind in one command

This sets up your own Havemind server and connects your vault to it. You need a
computer that stays on, a free Tailscale account, and about ten minutes. Nothing
is opened to the public internet: only devices signed in to your Tailscale
network can reach the server.

The manual path, with every setting explained, is
[self-hosting.md](self-hosting.md).

## 1. Pick the server machine

Any of these works:

- a Linux machine running Debian, Ubuntu or Raspberry Pi OS (a Raspberry Pi 4
  or 5, an old laptop, a mini PC, a small VPS);
- a Mac that does not go to sleep (System Settings, Energy: prevent sleeping
  when the display is off).

It must stay on: when it is off, nobody syncs (edits wait and go through later).

## 2. Set up Tailscale (once)

Tailscale is the private network your devices talk over.

1. Make an account at [tailscale.com](https://tailscale.com) (free for
   personal use).
2. In the [admin console](https://login.tailscale.com/admin/dns), open **DNS**
   and make sure **MagicDNS** is on and **HTTPS Certificates** is enabled. The
   server's address comes from these.
3. Install the Tailscale app on **every device that syncs**: your laptop, your
   phone, and later the people you invite. Sign in with the same account (or
   invite others from **Users** in the admin console).

You do not have to install Tailscale on the server machine yourself: the
installer does it.

## 3. Run the installer on the server machine

Open a terminal on the server machine and run:

```bash
curl -fsSL https://github.com/MikolajSapek/havemind/releases/latest/download/install.sh | bash
```

What you will see:

1. **Docker.** On Linux, if Docker is missing, it asks before installing it with
   Docker's official script (you may be asked for your password). On a Mac it
   asks you to install Docker Desktop or OrbStack, open it once, and run the
   command again.
2. **Tailscale.** If Tailscale is missing, it asks before installing it. If the
   machine is not signed in yet, it prints a login link: open it in any browser
   and sign in with your Tailscale account.
3. **Server.** It downloads the Havemind server, starts it, and waits until it
   answers. Files go to `~/havemind-server`.
4. **Your vault.** It asks for your name and the vault's name.
5. **Done.** It prints one line that starts with `hm_pt_` and ends with your
   server's address, for example:

   ```
   hm_pt_k3...@https://my-pi.your-tailnet.ts.net
   ```

That line connects your Obsidian as the owner. It works once and expires after 15
minutes; if it expires, run the command again and answer yes to "Make a new
code".

## 4. Connect Obsidian

1. In Obsidian: **Settings, Community plugins, Browse**, search for
   **Havemind**, install and enable it.
2. Open the Havemind pane, choose **I'll run the server**, then
   **I've done this, connect**.
3. Paste the line into the first field and press **Connect**. Leave the Server
   URL field empty: the address is inside the line.

The flower in the pane turns green after the first sync.

## 5. Invite the others

From the Havemind pane, open the Invite tab and make an invitation for each person. Send them the
invitation. They need Tailscale on their devices, signed in to your tailnet
(admin console, **Users**, Invite external users), and the Havemind plugin.

## If something goes wrong

| What you see | What to do |
|---|---|
| "could not read this machine's Tailscale name" | Turn on MagicDNS in the admin console (step 2), then run the installer again. |
| The connect form says it cannot reach the server | Is Tailscale on and signed in on this device? Open `https://<server address>/.well-known/havemind` in a browser; it should show `"service":"havemind"`. |
| "the server did not start" | Run `docker compose --project-directory ~/havemind-server logs` on the server machine and look at the last lines. |
| The code expired | Run the installer again and answer yes to "Make a new code". |

## Update or remove

- **Update:** run the same command again. It keeps your data and your devices
  stay connected.
- **Stop:** `docker compose --project-directory ~/havemind-server down`. Your
  data stays in a Docker volume and the folder `~/havemind-server/backups`.

Backups run daily into `~/havemind-server/backups`; see
[self-hosting.md, backups](self-hosting.md#i-backups) for copying them off the
machine.
