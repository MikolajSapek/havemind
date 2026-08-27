# Havemind closed beta

Havemind is ready for a small, supervised beta: 10–20 people who want to share
one Obsidian vault with a trusted partner or small team while running their own
server. The goal is to validate onboarding, day-to-day sync and recovery with
real workflows, not to collect users at any cost.

## Who should join

Good testers already use Obsidian on desktop, can join a private Tailscale
network, and are comfortable running or trusting a self-hosted server. They
should have a second device or a trusted collaborator who can edit the same
vault.

Do not recruit people who need end-to-end encryption, mobile support, public
internet access, or a managed hosted service. Havemind is desktop-only, runs on
a private network, and the selected server stores synced content in plaintext.

## Safety before first connection

1. Start with a new, non-sensitive vault. Do not migrate an important vault in
   the first week.
2. Use one trusted, tailnet-only server. Never enable Tailscale Funnel or expose
   the server publicly.
3. Confirm that the server operator has a current passing restore drill.
4. Install only one synchronisation product for the beta vault. Do not combine
   Havemind with Obsidian Sync, iCloud, Dropbox or another file synchroniser on
   the same vault.
5. Agree which people may join before the owner creates invitations.

## Installation and first connection

1. Install **Havemind** from the Obsidian Community directory. To try a
   prerelease, use BRAT with <https://github.com/MikolajSapek/obsidian-havemind>.
2. Open the Havemind sidebar and select **Connect**.
3. The server owner first pairs their own device using the single-use setup
   token. They then create a one-time invitation for each additional device.
4. The recipient pastes the invitation, verifies the server, vault and inviter,
   and reads the six-digit verification phrase to the owner.
5. Wait until both panels report **Connected · synced**. Make one small edit on
   each device and confirm it appears on the other.

## What testers should try

- Create, edit, rename and delete notes from both devices.
- Edit different sections of one note at the same time; then intentionally edit
  the same line and verify that both versions remain recoverable.
- Add a supported attachment (PNG, JPG, GIF, WebP, SVG or PDF) below 25 MB.
- Disconnect one device, make an edit, reconnect and verify the queued change.
- Restart Obsidian while connected and confirm the panel returns to its prior
  state.
- Check the Activity, People, Status and Connect tabs, including invitations and
  member removal where appropriate.

## Feedback and incident reporting

Havemind sends no telemetry. Feedback is therefore voluntary and should be
filed as a GitHub issue using the template in
[feedback-template.md](feedback-template.md). Never include invitation tokens,
refresh tokens, note text, screenshots of confidential notes, server secrets or
the contents of `data.json`.

For a possible data-loss event: stop editing both devices, do not reset the
connection, preserve the vault folders, and contact the server owner before
attempting recovery.

## Beta success criteria

The beta can expand only when each tester completes onboarding, normal edits
and offline recovery without unresolved data loss; feedback shows that the trust
model is understood; and every participating server has a recent passing restore
drill. Review reports weekly and fix reliability issues before adding more
testers.
