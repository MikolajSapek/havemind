# Havemind, vault content E2EE encryption and recovery path

- Status: **Plan draft (pending approval)**
- Date: 2026-07-24
- Implements the gate: `specs/003-open-source-release.md` → **Stage 3, general beta** (`0.5.x`)
- Fulfils the hard public-access requirement from: `specs/002-public-access.md`
- Extends: `plans/001-technical-plan.md` §7 (revision envelope), §10 (E2EE compatibility path)
- Subject to: `plan/01-zasady-i-slownik.md` (hard rules), `CLAUDE.md` (hard-rules summary)

This document does NOT change the revision protocol or the opaque server model. It only designs
the contents of `opaque_payload` (plaintext → ciphertext) and key management and recovery,
within the boundaries already approved in `plans/001-technical-plan.md` §10. Any conflict between
this file and `specs/`/`plans/001` → `specs/`/`plans/001` win (`plan/01` rule 1).

---

## Spec

### Goal and gate

E2EE for vault content and a recovery history are a hard gate in `specs/002-public-access.md`
(without E2EE there is no public access to real vaults) and an explicit requirement of
**Stage 3, general beta** from `specs/003-open-source-release.md` "## Release stages and gates":

> "End-to-end encryption for note contents and attachments passes multi-device recovery tests."

This plan delivers the design that satisfies this gate. The first real vault comes into being as
E2EE from its first revision, `plans/001-technical-plan.md` §10: "A disposable plaintext pilot
vault is never upgraded in place into a real encrypted vault."

### Hard constraints (MUST hold, repeated here explicitly)

1. **The server remains opaque.** The Havemind server stores only content-addressed bytes
   (`blob_hash` = SHA-256 of the stored bytes), byte size, and a monotonic `server_sequence`. It
   never sees plaintext, never computes a diff, provenance, or a merge. This is a boundary from
   `plan/01` rule 3 and `plans/001` §2.7, E2EE does not violate it, because diff/merge/provenance
   are already computed exclusively by the client (`sync-core`) on plaintext, locally.
2. **ZERO custom cryptography.** No cryptographic primitive is invented or hand-implemented
   (`plan/01` rule 6, `CLAUDE.md` rule 6, `plans/001` §10: "No custom cryptographic primitive
   will be invented."). We use only a proven, audited library (candidates below). All the
   "cryptography" on our side is composing documented AEAD/KDF/keywrap calls from that library.
3. **Forbidden dependencies.** React, Redis, PostgreSQL, message broker, ORM, Kubernetes, custom
   cryptography, none of these are used (`CLAUDE.md`, `plans/001` §5).
4. **Zero silent overwrites and identity trust only from the server session** remain in force
   (`plan/01` rules 4–5). A broken AEAD tag / wrong key epoch → quarantine, never overwriting the
   local file (`plans/001` §10).
5. **Secrets never in the repo/logs/reports.** The vault key, device keys, recovery code, phrase
, never in Markdown, commits, application logs, or in a subagent's report
   (`plan/01` rule 6). Logs redact encryption material (`specs/003` "Security and privacy
   baseline": "logs ... redacts ... encryption material").

### Library choice (one audited stack, to be confirmed in a spike)

Recommendation: **libsodium** via `libsodium-wrappers-sumo` on the client (WASM, works in Obsidian
desktop on Electron/Chromium; the same library on the server side is not needed, since the server
decrypts nothing). Alternative allowed by `plans/001` §5/§10: native **WebCrypto**
(AES-256-GCM + HKDF), but WebCrypto has no native Argon2id or `crypto_secretbox`/`crypto_box`,
so the KDF and keywrap would need libsodium or `argon2-browser` anyway. Hence libsodium by default
for consistency of primitives.

> **Note, knowledge may be outdated.** Before implementation, verify current versions and audit
> status: `libsodium-wrappers-sumo` (check the latest published version and changelog),
> compatibility with Obsidian's `minAppVersion` from `plans/001` §5 (≥ 1.11.4), and whether
> WebCrypto on the target platforms (macOS + Windows, including the user's second, Windows
> machine) supports the required algorithms without polyfills. Do not treat the versions in this
> document as authoritative.

Choosing the specific suite (cipher, device-key algorithm, recovery-code encoding) requires a
dedicated spike with test vectors, as mandated by `plans/001` §10. This plan sets the shape, not
the frozen numbers, without tests.

### Vault key derivation (KDF)

- On the owner's trusted device, a **random `vault_key`** is created (32 B from the library's
  CSPRNG), NOT derived directly from a password. `plans/001` §10: "a random vault key is created
  on the owner's trusted device." This allows rotating the password without re-encrypting the
  whole vault.
- The user's passphrase is used to derive the **`passphrase_key`** (a wrapping key, KEK) via
  **Argon2id** (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`). Parameters: at least
  `OPSLIMIT_INTERACTIVE`/`MEMLIMIT_INTERACTIVE` as a lower bound, `MODERATE` recommended;
  the exact values are set by a spike against the target hardware. The `salt` (16 B random) is
  plaintext.
- The `vault_key` is encrypted ("wrapped") under the `passphrase_key` (AEAD, e.g.
  `crypto_secretbox`/`crypto_aead_xchacha20poly1305`). The result = **`wrapped_vault_key`**, it
  can safely sit alongside the `salt` and Argon2id parameters in the local device configuration
  (NOT in the synchronized vault, NOT on the server as plaintext).
- The passphrase NEVER leaves the device; the `vault_key` NEVER reaches the server.

### What is encrypted, and what the server still legitimately sees

The `revision envelope` structure (`plans/001` §7) does not change, only the contents of
`opaque_payload` change:

- **Encrypted (AEAD ciphertext under `vault_key`, inside `opaque_payload`):** the operation, the
  current/previous file path, the normalized Markdown snapshot (or tombstone),
  `plaintext_content_hash`, the reconstruction recipe, and any values derived from the path. This
  is exactly the "inner schema" from `plans/001` §7 point 2, now as authenticated ciphertext.
  Binary attachments (F9, already implemented as plaintext blobs) are encrypted with the same
  `vault_key` before upload.
- **Visible to the opaque server (metadata, openly, this is NOT a leak to be fixed, it's the
  contract):** `blob_hash` (SHA-256 of the ciphertext), the exact byte size, `server_sequence`,
  acceptance time (`server_receipt`), and the plaintext fields of `client_protected_header`:
  `revision_id`, `vault_id`, `file_id` (stable, NOT a path), sorted parent IDs, member/device IDs,
  `payload_format`, semantic versions, cipher suite, `key_epoch`, `nonce`. The header is AEAD
  associated data (`plans/001` §7, §10), the server sees it but cannot swap it without breaking
  the tag.
- **Deliberately NOT hidden (a model limitation, disclosed honestly in the threat model):**
  revision counts, sizes, timestamps, and the parent-child graph (DAG). This is metadata that the
  opaque coordinator needs. `file_id` is an opaque identifier, not a path, the path is inside the
  encrypted payload, so the server doesn't know file names or the directory tree, but it does
  know the number of files and the rate of change per `file_id`.

### Key exchange between devices during pairing (2–3 devices)

We reuse the existing, voice-verified 6-digit-code channel (`specs/002` "Owner bootstrap"/
"Collaborator invitation"; project preference: the code is shown only on the joining device, read
aloud, the owner types it in on their end, a voice channel makes impersonation harder). E2EE adds
a key transfer on top of this:

1. The new device generates an ephemeral key pair (libsodium `crypto_kx` / `crypto_box`).
2. Through the existing invitation flow + owner approval after phrase comparison
   (`specs/002`; `plans/001` §10: "device enrollment transfers a wrapped vault key only after
   owner approval and phrase comparison"), the owner's device **wraps `vault_key`** under the new
   device's public key (sealed/`crypto_box`) and hands over the `wrapped_vault_key` for that
   device.
3. The server may relay this wrapped value in transit (it's ciphertext, the opaque server
   doesn't read it), but **the transfer's authorization rests on the server session and a human
   phrase comparison**, not on trusting the server about the content.
4. The 6-digit code / verification phrase binds the channel: it confirms the joining device's
   public key was not swapped by a man-in-the-middle (defense against MITM during pairing).
5. The policy of "does a new member get the full history or just a checkpoint" is disclosed at
   invitation time (`plans/001` §10), for the 2-person pilot, full history by default.

### Key rotation and epochs (`key_epoch`)

- Rotation and member removal use explicit `key_epoch` values; the server enforces the vault's
  `minimum_write_epoch` from the protected header (`plans/001` §10). This is the only
  cryptographic "decision" the opaque server makes, a purely numeric epoch comparison, with no
  insight into content.
- Rotation protects future content, but does NOT retract plaintext already fetched by a former
  member (`plans/001` §10), this is disclosed honestly to the user.

### Interaction with base-hash and 3-way merge (crucial, so nothing breaks)

- LF canonicalization, `plaintext_content_hash`, provenance (UTF-16 offsets), and the **3-way
  merge against a common ancestor** (decision MERGE-3WAY from 2026-07-22, `plan/11-BACKLOG.md`)
  operate EXCLUSIVELY on plaintext, on the client side, AFTER decryption. Merge never touches
  ciphertext.
- Before materializing, the receiving client verifies: the AEAD tag, the inner schema,
  `plaintext_content_hash`, the recipe, the binding to the parent, and vault/file/revision as AAD
  (`plans/001` §10). Only afterwards does `sync-core` compute the merge on the decrypted
  snapshots. The common ancestor for the 3-way merge is a decrypted revision from history, it is
  available locally, because the client keeps decrypted history.
- Conclusion: E2EE is transparent to the merge/provenance layer. `blob_hash` (server-side, over
  the ciphertext) and `plaintext_content_hash` (inside the payload) remain two different values
  as before, E2EE changes nothing here beyond the fact that the blob's bytes are now ciphertext.

### Recovery, honestly about the trade-offs

E2EE means: **loss of the key = loss of data, unless a recovery secret exists.** The server
cannot recover or decrypt content (`plans/001` §2.6: "The server cannot recover or decrypt
vault contents."). Therefore:

- **A recovery kit is generated locally, once, on the owner's trusted device** (`plans/001`
  §2.6, §10: "a recovery kit can restore the vault key without server knowledge"). The kit
  contains a second, independent copy of the `wrapped_vault_key`, wrapped under the **recovery
  key**, not the password.
- The **recovery key** is a high-entropy random secret (e.g. 256-bit) shown to the user as a
  human-readable recovery code (encoding to be settled in the spike, candidate: BIP39-style
  words or base32 with a checksum; ZERO custom cryptography, encoding only).
- Recovery paths: (a) **lost passphrase, device still works** → the user sets a new passphrase,
  the `vault_key` is re-wrapped with a new `passphrase_key`; the recovery key is not needed.
  (b) **all devices lost** → a new device + the recovery key restores the `vault_key` from the
  recovery kit, then sets a new passphrase. (c) **lost passphrase AND lost recovery key** → data
  unrecoverable; this is communicated explicitly when the vault is created, with no false
  promise.
- **Escrow trade-off, deliberately REJECTED as the default:** storing the key (or a share of it)
  on the server/with the operator would break the opaque model and the hard rule in `specs/002`.
  It is permissible only as an *opt-in*, explicitly documented, outside the default path, and is
  not part of Stage 3 scope. By default: no escrow, full user responsibility for the recovery
  key, communicated honestly.

---

## Threat model

This is the heart of this plan. The model documents what the **server operator, network
provider, and collaborator** can observe, per the `specs/003` requirement "## Security and privacy
baseline" ("A threat model documents what the server administrator, network provider and
collaborators can observe.") and it is one of the conditions of **Stage 3, general beta**
(`specs/003`: "A security review and documented threat-model review are complete.").

### 1. Malicious / curious server operator (honest-but-curious and active)

- **Cannot read content.** `opaque_payload` is AEAD ciphertext under `vault_key`, which the
  server never possesses. File names and paths are inside the ciphertext (`file_id` is opaque).
- **Cannot swap content undetected.** `client_protected_header` (including `vault_id`,
  `file_id`, parent IDs, `key_epoch`, `nonce`) is AEAD AAD, changing it breaks the tag on
  decryption, and the client quarantines it (`plans/001` §10). A swapped/corrupted ciphertext
  never overwrites the local file (zero silent overwrites, `plan/01` rule 4).
- **What it DOES see (plaintext metadata, the model's boundary):** `blob_hash`, byte sizes, the
  rate and count of revisions, the parent-child DAG per `file_id`, file count, member/device IDs,
  timestamps. It can infer activity (when and how much someone writes), not content. This is
  disclosed honestly, not hidden (`plan/01` "Honesty as a feature").
- **Cannot forge identity from request data.** `actor_id`/`device_id` come from the server
  session (`plan/01` rule 5), but it is the server that assigns them; E2EE does not protect
  against the server lying about attribution. Limitation disclosed: attribution is only as
  trustworthy as the server session, it is not cryptographically signed by the author in this
  scope.

### 2. Network attacker (passive eavesdropping and active MITM)

- **Transport:** versioned HTTPS (`specs/002`), independent of ingress (Tailscale/Caddy/
  Cloudflare/public). This is the first layer.
- **Second layer (E2EE):** even after breaking/terminating TLS, an attacker sees only ciphertext +
  the same metadata as the server. Without the `vault_key` it cannot read content.
- **MITM during pairing:** neutralized by comparing a human-readable phrase over a voice channel
  + the 6-digit code (`specs/002`, project preference). Swapping the joining device's public key
  changes the phrase → humans detect the discrepancy.
- **Replay:** ciphertext replayed under a different header is quarantined (the AAD doesn't match;
  `plans/001` §10). A monotonic `server_sequence` detects duplicates at the protocol layer.

### 3. Lost / stolen device

- On the device sit: decrypted history in cache, `wrapped_vault_key` + `salt` + Argon2id
  parameters, and the refresh token (Obsidian SecretStorage, `specs/002`).
- **Defense:** the `vault_key` on disk exists only as `wrapped_vault_key`, you can't unwrap it
  without the passphrase (Argon2id slows brute-force). However, the decrypted content cache is
  accessible to anyone with an unlocked OS, this is an at-rest limitation, disclosed honestly;
  full local cache encryption is out of scope for Stage 3 (a future candidate).
- **Response:** the owner revokes the device (`specs/002`: revoke device) and **rotates the
  `key_epoch`**; the server raises `minimum_write_epoch`, the removed device can no longer write
  (`plans/001` §10). Rotation does not retract plaintext already fetched onto that device,
  communicated explicitly.

### 4. Lost passphrase

- Without the passphrase and without the recovery key: **data unrecoverable**, inherent to E2EE
  by design, the server cannot help (`plans/001` §2.6). Communicated honestly when the vault is
  created.
- With the recovery key: recovery via the recovery kit (see "Recovery" in `## Spec`).
- This is a deliberate security↔availability trade-off; escrow is rejected as the default,
  because it breaks the opaque model.

### 5. Downgrade attack

- **Encryption downgrade → plaintext:** vault policy and the discovery response declare the
  required `payload_format_version` and the minimum suite/encryption epoch as **requirements, not
  hints** (`plans/001` §7). A client that cannot meet the required E2EE semantics **fails closed**
  before uploading and before local application; an unknown mutating event remains quarantined,
  never silently treated as plaintext.
- **Key-epoch downgrade:** the server enforces `minimum_write_epoch`, a revision under an old
  epoch after rotation is rejected (`plans/001` §10).
- **Protocol-version downgrade:** an incompatible client is rejected before upload/application
  with a clear upgrade instruction (`specs/003` "Versioning and compatibility").
- **Key point:** a disposable plaintext vault is NEVER upgraded in place to E2EE
  (`plans/001` §10), the first real vault is E2EE from its first revision, so there is no
  "mixed" state that could be downgraded to plaintext.

### 6. Metadata leakage

- **What leaks (deliberately):** byte sizes (may correlate with note length), the rate and
  timing of changes, file count, the DAG, member/device IDs. The operator and the network see
  this.
- **What is NOT there:** content, file names, paths, the directory tree (`file_id` is opaque).
- **Possible hardening (out of Stage 3, for future consideration):** padding blob sizes into
  buckets, limiting timestamp disclosure. Not required for the Stage 3 gate; listed honestly as
  a known limitation, not a promise.
- **Log redaction:** application logs and diagnostics redact encryption material and secrets,
  verified by automated tests (`specs/003` "Security and privacy baseline"; `plan/01`
  rule 6).

---

## Acceptance tests

Functional and verifiable tests (TDD red-green-refactor, `plan/01` rule 2). Each addresses a
specific property of the **Stage 3, general beta** gate.

1. **Encryption round-trip (`sync-core`, unit).** For a random Markdown snapshot: encrypt →
   decrypt → identical plaintext; `plaintext_content_hash` matches; the recipe reconstructs the
   content. Fulfils `plans/001` §10 "encrypt/decrypt/schema/recipe round trip before upload".

2. **The server never sees plaintext (integration, 2 clients + server).** Client A writes a
   known signal phrase (e.g. `CANARY-<uuid>`). The test searches the server's blobs, SQLite, and
   application logs: the phrase does NOT appear as plaintext in any of them. Fulfils `specs/003`
   acceptance: "A diagnostic report contains no ... note content or encryption key."

3. **Rejection of AEAD tampering (unit + integration).** Flipping 1 bit in the ciphertext,
   swapping a `client_protected_header` field (e.g. `file_id`), and replaying ciphertext under a
   different header → in every case decryption/verification fails, the revision is quarantined,
   the local file remains unchanged. Fulfils `plans/001` §10 (quarantine) and
   `plan/01` rule 4 (zero silent overwrites).

4. **Multi-device recovery test, explicit Stage 3 requirement (e2e).** An E2EE vault is created
   on the owner's device; a second device joins via invitation + phrase comparison; both sync the
   same content after decryption. Then: (a) the second device restores the `vault_key` after
   pairing, (b) a third device joins analogously. The test proves:
   "end-to-end encryption ... passes multi-device recovery tests" (`specs/003` Stage 3).

5. **Recovery from the recovery kit without server knowledge (e2e).** Simulate the loss of all
   devices: a fresh device + recovery key restores the `vault_key` from the recovery kit and
   decrypts the full history. The server does NOT participate in key recovery. Fulfils
   `plans/001` §2.6/§10.

6. **Loss without a recovery key = an explicit, controlled failure (unit/e2e).** Without a
   passphrase and without a recovery key, recovery fails with an unambiguous, human-readable
   message (with no suggestion the server will help). Proves the model's honesty, not a
   "magic" recovery.

7. **Downgrade resistance (integration).** A client reporting a `payload_format_version` lower
   than required by vault policy (an attempt at plaintext/an old epoch) is rejected **before**
   any change to local or remote content; the event remains durably pending/quarantined, never
   "applied". Fulfils `specs/003` acceptance "Plugin/server incompatibility is detected before
   any local or remote content is changed." and `plans/001` §7/§10.

8. **Epoch rotation excludes a removed member (integration).** After rotating `key_epoch` and
   raising `minimum_write_epoch`: a revision under the old epoch is rejected by the server; the
   removed device gets no new epoch and cannot write. Fulfils `plans/001` §10.

9. **Merge/provenance works on decrypted plaintext (integration, touching MERGE-3WAY).** Two
   divergent edits of the same file in an E2EE vault: the 3-way merge against a common ancestor
   gives the same result as in the plaintext pilot; non-overlapping hunks merge, genuinely
   overlapping ones create a conflict copy in `Havemind Conflicts/`. Proves E2EE is transparent
   to the merge layer.

10. **Binary attachments encrypted (e2e, touching F9).** An attachment (e.g. PNG/PDF from the F9
    allowlist) syncs as ciphertext; after decryption the recipient has a byte-identical file;
    blobs on the server contain no plaintext of the file. Fulfils `specs/003` Stage 3
    ("note contents and attachments").

11. **Backup contains ciphertext + complete metadata (integration).** A server backup restores
    users, vault metadata, revisions and **encrypted** content on a clean machine; it does not
    contain the `vault_key`. Fulfils `plans/001` §10 ("backups contain ciphertext but ... preserve
    all required metadata and blobs") and `specs/003` acceptance ("restores ... encrypted content
    on a clean machine").

12. **Redaction of secrets in logs/diagnostics (unit).** `havemind doctor` and application logs
    contain no `vault_key`, `wrapped_vault_key`, recovery key, passphrase, tokens, or plaintext,
    verified automatically. Fulfils `specs/003` "Security and privacy baseline".

13. **Library test vectors (unit).** Known test vectors for Argon2id, AEAD, and keywrap from the
    chosen library pass, proof that we use the primitives correctly and have not introduced
    custom cryptography. Fulfils `plans/001` §10 ("test vectors"; "No custom cryptographic
    primitive will be invented.").

---

## Rollout/rollback

### Deployment order (aligned with the phasing of `specs/003` and `plans/001` §11)

We implement E2EE **after** the plaintext pilot has proven the sync semantics
(`plans/001` §10, §11) and after closing the current 1.0 pilot milestones (the 7-day pilot +
the T033 gate). Step by step:

1. **Cryptographic spike (no production use).** Choose and verify the library (versions, audit
   status, see the "knowledge may be outdated" note), select the cipher suite, the device-key
   algorithm, Argon2id parameters, and the recovery-key encoding. Result: test vectors + a
   decision recorded in `DECISIONS.md`. This fulfils "dedicated threat-model spike and test
   vectors" (`plans/001` §10).
2. **`sync-core`: the payload layer.** Implement encrypt/decrypt/verify around the existing
   inner schema, with the header as AAD. Merge/provenance untouched, they operate on decrypted
   plaintext. Tests 1, 3, 9, 13.
3. **Key management and pairing.** Argon2id-wrap the `vault_key`, transfer at enrollment via the
   existing phrase/6-digit channel, `key_epoch` + `minimum_write_epoch`. Tests 4, 8.
4. **Recovery kit.** Local generation, recovery key, paths (a)/(b)/(c). Tests 5, 6, 11.
5. **Attachments + backup + diagnostics.** Tests 10, 11, 12.
6. **Security review and threat-model review** (Stage 3 requirement), only after tests 1–13 are
   green.

**The first real vault is created as E2EE from its first revision.** The disposable plaintext
pilot is NOT migrated in place (`plans/001` §10). This simplifies rollback: there is no data
conversion to undo.

### Gates requiring a user question (`plan/01` rule 9), do NOT do without consent

- **Changing the approved encryption/trust model**, explicitly requires a user question
  (`plan/01` rule 9). This plan is a draft; its approval and any later change to the suite is a
  user decision.
- **Connecting a real (non-disposable) vault**, always a user question (`plan/01`
  rule 9). The first real E2EE vault = this gate.
- **Enabling Tailscale Funnel / public exposure, `sudo` operations on `sapserver`,
  irreversible operations on backups, `git push`/PR**, unchanged, always a user question.
- **Key escrow** (if ever considered), a change of trust model, requires explicit consent and a
  separate review; out of scope for Stage 3.

### Rollback

- **During development (before the first real E2EE vault):** the feature works only on
  disposable vaults; rollback = disabling the E2EE path / reverting commits. Zero production
  data to migrate, because the plaintext pilot was never upgraded to E2EE.
- **After a real E2EE vault has been created:** downgrading to plaintext is **not allowed**,
  it would break the hard requirement in `specs/002`. "Rollback" means solely: restoring the
  previous server version/image with the pre-upgrade backup (`specs/003` "For a self-hoster":
  backup + matching container image), where the backup contains ciphertext anyway. Downgrade
  database migrations are not promised (`specs/003`). Blobs are content-addressed and immutable,
  so restoring an image does not destroy revision history.
- **Rotation as a "soft rollback" for compromise:** if a device/member is compromised, the right
  response is not a downgrade, but rotating `key_epoch` + revoking the device (Test 8), with the
  honest caveat that plaintext already fetched cannot be retracted.

### Conditions for considering the gate satisfied

Stage 3, general beta, on the E2EE part, is closed when: acceptance tests 1–13 are green
(≥ 80% coverage, `plans/001` §5), the spike has recorded the library choice and vectors in
`DECISIONS.md`, the security review and threat-model review are closed, and the public
documentation states explicitly who can read note content for this release (`specs/003`
acceptance: "Public release documentation states exactly which party can read note contents"),
answer: only holders of the `vault_key`, never the server operator.
