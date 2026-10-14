# 017, Mail to notes: a mailbox label becomes formatted notes

- Status: **Proposed**. Follows `plans/016-agent-look-and-login.md`.
- Owner's ask: connect mail (Gmail first) to the agents so a mail lands in the
  vault already formatted. Owner's choices: only mails with a label
  ("Havemind"); the note is the clean mail plus an AI summary and tasks; the
  label is removed once the note is written.

## Design

1. **A new ready-made agent, "Mail to notes".** Icon: an envelope. Writes only
   in `Mail/` (not under `Inbox/`: notes written by an agent never trigger
   another agent, so Inbox sorter would not file them anyway). Checks every
   15 minutes; it does not wait for people's changes, its input is the
   mailbox. Only a check that found mail counts towards the day cap, so empty
   checks never stop it at midday.
2. **Login: IMAP with an app password.** Gmail (`imap.gmail.com:993`, an
   app password from myaccount.google.com/apppasswords; spaces stripped, as
   Google shows it in groups of four), and any other IMAP mailbox (iCloud,
   Outlook, a company server) with host and port filled in. No Google Cloud
   app, no OAuth. TLS only (port 993), certificate checked. The label is
   plain ASCII (letters, digits, space, `-_/.`).
3. **Where the login lives.** Add agent sends `{ host, port, user, password,
   label }` once, with the add request, to the owner's server; the server
   writes `agent-secrets/mail/<vaultId>/<agent folder>.json` (0600, never
   the database), so two vaults on one server never share a mailbox. The
   password is never sent back. Removing the agent (the membership removal
   route) removes the file. Agent folders themselves are made unique per
   vault too (today two vaults with an agent of the same name would share
   `agents/<folder>`).
4. **IMAP client, no dependency.** `node:tls` and the handful of commands
   needed: `LOGIN`, `SELECT "<label>"`, `UID SEARCH ALL`,
   `UID FETCH <uid> (RFC822.SIZE)`, then `BODY.PEEK[]` up to 15 MB, with
   attachment parts dropped while parsing; a bigger mail becomes a short
   note from its headers ("too large, open it in your mail"). No mail is
   ever left stuck with its label. Then removing the
   label: Gmail (`X-GM-EXT-1`): `UID STORE <uid> -X-GM-LABELS ("<label>")`;
   other servers: `UID MOVE <uid> INBOX` (the label is a folder there).
   Literal-aware response reader; quoted arguments escaped; a timeout on
   every step.
5. **Formatting, deterministic.** MIME parser: multipart, quoted-printable,
   base64, charsets via `TextDecoder`, RFC 2047 headers. Prefer text/plain;
   else a small HTML-to-Markdown (paragraphs, line breaks, links, lists,
   bold/italic, entities; scripts, styles and images dropped). Attachments
   listed by name only, not saved.
6. **The AI part is text only.** One one-shot call per mail: "summarise in
   2-3 sentences and list the tasks", the mail as data between tags. The
   answer is placed in the note as text; the model never chooses paths or
   writes files, so a mail cannot steer the agent (prompt injection reaches
   only the summary). With the Anthropic API brain the same one call is made
   without tools.
7. **The note.** `Mail/<YYYY-MM-DD> <subject>.md`:
   frontmatter `from`, `to`, `date`, `subject`, `message_id`; `## Summary`,
   `## Tasks` (only when there are any), `## Mail` with the body; attachment
   names at the end. Same subject twice: ` (2)`. Subjects become safe file
   names (no `/ \ : # ^ [ ] |`, at most 80 characters).
8. **Order and safety.** Write the note, sync, and remove the label only once
   the server has accepted the note's revision. The Message-IDs written are
   kept in the agent's state (last 1000), so a crash between write and label
   removal never makes a duplicate; a mail found as already written just
   loses its label. Caps: 20 mails per run, the day cap of checks that found
   mail, 15 MB per mail. A failed mail stays
   labelled and is retried on the next run; the log line never contains mail
   text or the password.
9. **Undo** works as for every agent (notes it created go to the trash). The
   mails stay in the mailbox; only the label is gone.
10. **Shared vault.** Mail notes are seen by every member of the vault, and
    the mail text goes to the chosen model; the form and the docs say both.

## Steps

0. Smoke test against the owner's real Gmail (app password typed into a
   hidden prompt, never in chat or a file): log in, select the label, fetch
   one mail, remove the label with `X-GM-LABELS`, check in Gmail.
1. MIME + HTML-to-Markdown + note builder; tests with real-world samples
   (Gmail HTML, Polish charsets, quoted-printable, nested multipart).
2. IMAP client against a scripted fake server (TLS off in the test only);
   tests for literals, Gmail vs other servers, errors, timeouts.
3. Mail runner: label in, notes out, label removed, dedupe, caps; e2e test
   with the headless agent.
4. Server: `mail` in `POST /vaults/:id/agents` (validated, 0600 file),
   removed with the agent; tests.
5. Plugin: the tile, its fields (address, app password, label; host and port
   only for non-Gmail), the envelope icon; preview check at 300/390 px.
6. Docs (`docs/agents.md`: how to make a Gmail app password and a filter
   that labels mail automatically).
7. Live test on the AWS box with the owner's Gmail; the owner looks at the
   note. Only then, and with the owner's yes, push and release 1.11.0.
