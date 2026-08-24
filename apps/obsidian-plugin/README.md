# Havemind

Private, self-hosted, real-time sync for a shared Obsidian vault. Havemind is
for a small trusted circle that wants to keep Markdown data on hardware it
controls, rather than in a third-party cloud.

## Install

Install from the Obsidian Community directory, or use BRAT with this repository
while a release is being reviewed. Havemind is desktop-only and requires a
Havemind server that the vault owner self-hosts.

## Privacy and permission disclosures

Havemind has no telemetry, analytics, advertisements, or Havemind-operated
account service.

- **Network use:** After a user explicitly connects a vault, Havemind makes
  HTTPS requests only to the self-hosted server URL entered by that user. The
  requests authenticate devices, create and approve invitations, synchronise
  revisions and blobs, load membership state, and wait for changes. No network
  request is made while the plugin is disconnected. The self-hosted server
  stores synced vault content in plaintext, so it must be operated by someone
  the vault members trust.
- **Vault file enumeration:** During initial reconciliation and conflict
  handling, Havemind lists vault paths to detect creates, deletions, renames and
  conflicts. It reads and synchronises supported vault content plus an explicit
  allowlist of appearance settings. It never synchronises `.obsidian/plugins/`,
  plugin data, or plugin secrets.
- **Clipboard:** Havemind only writes a one-time invitation to the system
  clipboard after the vault owner selects **Copy invitation**. It never reads
  the clipboard or logs invitations.
- **Base64 encoding:** Base64url encodes binary revision envelopes and
  invitations for transport. It is not encryption, obfuscation, or a mechanism
  for hiding code, URLs, or keys.

## Security model

Havemind relies on the private Tailscale network and the server chosen by vault
members. It does not provide end-to-end encryption. Do not connect a vault to a
server you do not trust, and do not expose the server to the public internet.

## Support

Source, self-hosting instructions and issue tracking are available at
<https://github.com/MikolajSapek/havemind>.
