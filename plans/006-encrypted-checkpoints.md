# Havemind — follow-up plan: encrypted checkpoints (F9)

- Status: **Follow-up draft (F9-01)** — pending owner approval before implementation.
- Date: 2026-07-24
- Extends: `plans/001-technical-plan.md` §7 (offline delivery — "Real-vault compaction
  requires an encrypted checkpoint"), §8 (backup/restore), §10 (E2EE); fulfils the gate
  `specs/003-open-source-release.md` **Stage 3 — general beta (`0.5.x`)** row "Supported
  backup and restore work on a clean machine".
- Composes with: `plans/004-*` (E2EE/device recovery). This plan assumes either that E2EE
  already exists, or that the checkpoint also works for the plaintext pilot as a degraded
  mode (see `## Spec`, "Modes").
- Relation to the backlog: closes part of F9-01; it is the application layer that Restic
  (SRV-03/04/05, **DEFERRED** by owner decision 2026-07-16 — zero external/cloud backup,
  data only on the user's own hardware) would wrap without knowing the content.

## Canonical facts and boundaries (non-negotiable)

Per `plan/01-zasady-i-slownik.md` rule 1 — on conflict, `specs/`/`plans/` win.
This plan does not change any of the boundaries below, it only adds a layer:

- **The server is opaque** (`plans/001` §3, rule 3): the Havemind process builds the checkpoint
  from bytes it already stores (blob store + `havemind.db`). It computes no diff, provenance, or
  merge, and knows nothing of payload content. A checkpoint is an I/O + library-crypto operation,
  not content interpretation.
- **Zero custom cryptography** (`plans/001` §14 "Never: invent cryptography", §10): encryption of
  metadata and integrity authentication is done exclusively by a proven library (candidate:
  `age` / `rage` as the file format, or libsodium `crypto_secretstream` via Node's
  `sodium-native`; the choice and test vectors require a separate spike as in `plans/001` §10).
  No custom primitive, no custom chaining mode.
- **No forbidden dependencies**: no React, Redis, PostgreSQL, message broker, ORM,
  Kubernetes, or custom cryptography (`plans/001` §5, §14). The checkpoint writes via
  better-sqlite3 + Node fs + an encryption library — nothing more.
- **`sapserver` constraints** (rule 7): 16 GB RAM, ~96 GB free disk, no `docker` group,
  no public ports. The checkpoint must fit its retention within the disk budget and must not
  assume a second machine.
- **Pilot: no cloud, data only on the user's hardware** (rule in `01` "Honesty as a feature";
  SRV-02/03 owner decision). The checkpoint is written to `sapserver`'s disk and copied to the
  user's hardware (USB / SFTP to the Mac / a LAN NAS) — never to a cloud service.

## Spec

### Goal

A periodic, self-contained, encrypted snapshot of an entire Havemind deployment's state, from
which the owner can restore the instance on a clean machine **without any third party involved**
(no cloud, no external key service, no `sapserver` acting as a trust source).
The checkpoint is an application layer: a complete, verified "state at time T" unit, which a
transport/retention tool (eventually Restic, once it returns from being deferred) merely moves
and versions, without understanding its interior.

### What a checkpoint contains

One checkpoint = a directory/archive with three parts (mirroring the split from `plans/001` §8
"database snapshot paired with a manifest of every referenced blob"):

1. **`havemind.db.enc`** — a metadata-database SQLite snapshot taken via the **SQLite Online
   Backup API** (never a raw copy of the live file + WAL — `plans/001` §8), then **encrypted at
   rest** by a library (see "Key management"). The metadata database covers: sequences/cursors,
   `server_sequence`, users, devices, vaults, memberships, invitations (hashed), refresh-token
   families (hashed), files, revisions, revision parents, events, rejoin grants, the
   instance/restore epoch. **This data is NOT E2EE** — it is plaintext server-side metadata —
   which is why the checkpoint must give it its own encryption at rest.
2. **`blobs/`** — content-addressed revision blobs (payload envelopes). Once E2EE ships
   (`plans/004`), a blob is authenticated ciphertext — **encrypted by construction**, and the
   checkpoint copies the bytes without re-encrypting. In plaintext-pilot mode a blob is plaintext;
   see "Modes". Each blob is named by its `blob_hash` (SHA-256 of the stored bytes,
   `plans/001` §7).
3. **`manifest.json`** (minimal, plaintext, authenticated) — no note content, no secrets.
   Fields: `checkpoint_format_version`; `created_at`; `instance_id`; `server_epoch`;
   `schema_version` / `server_version`; `max_server_sequence`; a list of `{ blob_hash, size }` for
   every referenced blob; `db_ciphertext_hash` (SHA-256 of the encrypted database file); the
   identifier of the crypto suite and KDF (`kdf`, `cipher_suite`, `key_epoch`);
   `history_commitment` (a deterministic hash of the revision chain, per the "history commitment"
   from `plans/001` §7). The manifest is **authenticated** (a MAC/signature over its bytes with
   the same checkpoint key), to detect tampering at restore time.

The manifest is plaintext by design: it serves as a "table of contents" for integrity
verification and for the retention tool, but it must not reveal anything sensitive (no plaintext
paths, content, or tokens) — this is a security AC.

### Key management (separate from the E2EE vault key)

- **A separate `checkpoint_key`**, independent of the `vault_key` from `plans/004`. Rationale:
  E2EE protects note content from the server; a checkpoint protects **server metadata** (which
  the server, by definition, must know in plaintext while running). These are two different
  trust boundaries and two different lifecycles (rotating the vault key on member removal ≠
  rotating the backup key).
- **The owner holds the key**, not the server, in a usable form. Model: the owner holds a
  recoverable secret (a high-entropy passphrase generated locally + stored in a recovery kit —
  analogous to the recovery kit from `plans/001` §10). The `checkpoint_key` is derived from this
  secret via a **brute-force-resistant library KDF** (Argon2id from libsodium / the `age`
  mechanism — no custom KDF).
- **The server, which creates checkpoints automatically**, needs to be able to encrypt without
  interaction. A solution that doesn't hand full control to the server: the checkpoint encryption
  key is the **recipient's public key** (the library's asymmetric scheme, e.g. `age` recipient
  X25519). The server holds only the public recipient — it can encrypt a new checkpoint, but
  **cannot decrypt any** (it has no private key). Decryption and restore are performed by the
  owner with their private key from the recovery kit, on a clean machine. This fulfils "no third
  party": `sapserver` could be compromised and still not read its own checkpoints.
- The private key / passphrase **never** goes into the repo, logs, `havemind.db`, or a subagent's
  report (`plan/01` rule 6). The server stores only the public recipient in a config file at
  `/srv/secrets` (like other secrets in F7-03), with 0600 permissions.

### Cadence and retention

- **Cadence**: a configurable interval (daily by default), triggered by the server's own
  scheduler (not an external cron requiring `sudo`). Additionally, a checkpoint **before every
  migration/upgrade** (consistent with `plans/001` §8 "Every upgrade creates or requires a
  verified backup before the first irreversible migration").
- **Mutual exclusion**: while a checkpoint is being assembled, purge and blob garbage collection
  are locked out (`plans/001` §8 "Purge and blob GC are locked out while a backup snapshot is
  assembled"). The checkpoint takes a database snapshot via the Online Backup API, so concurrent
  writes do not corrupt the file.
- **Retention** (default, aligned with the deferred Restic foundation of 7/4/6 from SRV-03): 7
  daily, 4 weekly, 6 monthly. Retention is computed locally; deleting an old checkpoint is an
  operation that is reversible only until a newer one is verified (never "forget" without a
  prior "verify" — analogous to `restic check` before `forget`, `plan/01` rule 9).
- **Disk budget** (rule 7): retention must fit within ~96 GB. The blob store is content-addressed
  and shared across checkpoints by hash — the implementation can hardlink/deduplicate unchanged
  blobs between successive checkpoints instead of copying them N times (the same thing Restic
  would later do at a layer above). Alarm and a `DECISIONS.md` entry on growth > 20 GB
  (consistent with the F8-02 pilot checklist).
- **Copy off the server's system disk** (`plans/001` §8 "stored off the server's physical disk"):
  the finished, encrypted checkpoint is copied to the user's hardware (USB / SFTP to the Mac /
  a LAN NAS). This transport is where Restic will plug in once it returns from being deferred —
  Restic will wrap **already encrypted** checkpoints, never seeing plaintext.

### Restore procedure + integrity verification

Restore targets a **new, empty, isolated data directory** (`plans/001` §8). Steps, all
**before** the server enters a ready state:

1. The owner supplies the private key / passphrase from the recovery kit on a clean machine.
   Decrypt `havemind.db.enc` → `havemind.db` with the library (AEAD/MAC tag verification — an
   invalid tag = abort, nothing starts).
2. **`PRAGMA integrity_check`** on the decrypted database — must return `ok` (`plans/001` §8;
   AC F7-01 already enforces this for backups, and the checkpoint inherits this condition).
3. **Manifest verification**: the manifest's MAC/signature is valid; `db_ciphertext_hash` matches
   the bytes of `havemind.db.enc`.
4. **Byte-hash of every blob**: for every entry in the manifest, compute the SHA-256 of the file
   in `blobs/` and compare it against `blob_hash` and `size`. Additionally, referential integrity:
   every blob referenced by SQLite exists, and conversely no blob in the checkpoint is orphaned
   outside GC policy (`plans/001` §8 "GC never deletes a blob still referenced by SQLite").
5. Only after steps 1–4 pass does the instance start with a **new `server_epoch`**
   (`plans/001` §8), invalidating earlier sessions and forcing clients with an older epoch or a
   cursor outside the server to reconcile `revision_id`/heads before any further mutation
   (exactly the path already tested in F7-01).

Any failure in steps 1–4 = the restore is aborted, the epoch unchanged, no file materialized
(fail-closed).

### Modes (plaintext pilot vs E2EE)

- **E2EE mode** (target, required for Stage 3): blobs are ciphertext (`plans/004`), only the
  metadata database is encrypted separately. The checkpoint as a whole is encrypted at rest by
  construction + a separate database encryption.
- **Plaintext-pilot mode**: blobs are plaintext. For the checkpoint to remain self-containedly
  encrypted at rest, the entire checkpoint directory (database + `blobs/`) is encrypted with
  `checkpoint_key`. This does, however, **not** make the pilot "safe for real notes" — the pilot
  remains disposable-only (`plan/01` "Honesty as a feature"; `plans/001` §10 "A disposable
  plaintext pilot vault is never upgraded in place into a real encrypted vault"). A checkpoint of
  a plaintext vault is never presented as a guarantee of confidentiality for real data.

## Threat model

This model extends the documented deployment threat model (`specs/003` "A threat model documents
what the server administrator, network provider and collaborators can observe"). The
**Stage 3 — general beta (`0.5.x`)** gate from `specs/003-open-source-release.md` explicitly
requires: "Supported backup and restore work on a clean machine" and "A security review and
documented threat-model review are complete" — this section is part of that documentation and
must be reviewed before checkpoints are considered to satisfy the Stage 3 — general beta gate.

| # | Threat | Actor / vector | Control |
|---|---|---|---|
| T1 | **Theft of the checkpoint (confidentiality at rest)** | Theft of `sapserver`'s disk, USB, a NAS share, or interception of a copy in transit | `havemind.db.enc` is encrypted with library AEAD under a key the server does not possess (public recipient); in plaintext mode, the entire checkpoint is encrypted with `checkpoint_key`; the manifest has no content/secrets. Compromising `sapserver` itself does not reveal checkpoints, since it holds no private key. |
| T2 | **Tampered checkpoint (integrity/authenticity at restore)** | Swapping bytes of the database, a blob, or the manifest by an attacker with access to the storage location | The database's AEAD/MAC tag is verified on decryption; the manifest is authenticated (MAC/signature); `PRAGMA integrity_check`; byte-hash of every blob vs `blob_hash`+`size`; `db_ciphertext_hash` in the manifest. Any mismatch → restore aborted fail-closed, epoch unchanged. The opaque server cannot "repair" or fabricate content (`plans/001` §8). |
| T3 | **Loss of the key** | The owner loses the passphrase / recovery-kit private key | The key is the only way to read the data — loss = permanent inability to restore (an accepted cost of the "no third party" model, same as the E2EE recovery kit in `plans/001` §10). Procedural control: the recovery kit is generated locally on first run, and its existence and off-`sapserver` storage are part of the Stage 3 checklist; no backdoor and no "server-side recovery" (the server cannot decrypt — `plans/001` assumption 6 "The server cannot recover or decrypt vault contents"). Documentation explicitly warns that key loss is irreversible — honesty instead of a false recovery promise. |
| T4 | **Partial / corrupted checkpoint** | Interrupted write (crash, out of space), bit rot on media, a truncated copy | The checkpoint is published atomically: write to a temp file on the same filesystem, `fsync`, atomic rename, parent-directory `fsync` (the blob publication pattern from `plans/001` §8); a checkpoint is considered valid only after it is written and its manifest verified. At restore, the full verification (steps 1–4) catches a missing/truncated blob or database → rejection and a fallback to an older checkpoint from retention. Retention (7/4/6) ensures one corrupted checkpoint is never the only copy. "Forget" an old one only after "verify" of a newer one. |
| T5 | **Metadata in the manifest as a leak** (adjacent to T1) | An attacker reads the plaintext `manifest.json` | The manifest contains only hashes, sizes, versions, the epoch — zero plaintext paths, note content, tokens, invitations. Enforced by a redaction test (like the diagnostics in F7-03). |

Out of scope (per `plans/001` §7 "Attribution is deterministic collaboration history, not
forensic proof against a malicious collaborator or administrator"): a checkpoint does not protect
against a malicious owner who holds the private key — that is by definition a trusted role. It
protects against infrastructure and media compromise.

## Acceptance tests

All tests are functional and verifiable (TDD red-green-refactor, `plan/01` rule 2).
Methods stated explicitly.

1. **Restore to a clean instance is byte-for-byte identical** — create a deployment with N
   revisions and M blobs, take a checkpoint, restore into an empty isolated directory on a
   "clean machine" (fixture). AC: every blob in the restored instance is byte-for-byte identical
   to the original (`diff`/SHA-256 per blob → 0 differences); the set of
   `revision_id`/`server_sequence`/heads is identical.
   (Fulfils `specs/003` Stage 3 — general beta "backup and restore work on a clean machine".)
2. **`PRAGMA integrity_check` clean after restore** — after decrypting the database from the
   checkpoint, `PRAGMA integrity_check` returns exactly `ok`. AC: result = `ok`; with an
   artificially corrupted database, the test expects the restore to abort before startup
   (fail-closed).
3. **Confidentiality at rest (T1)** — grep the raw bytes of `havemind.db.enc` (and, in plaintext
   mode, the whole archive) for known content/token markers injected into the fixture → 0 hits.
   AC: without the private key, decryption returns an error, not plaintext.
4. **Tamper detection (T2)** — after creating a checkpoint, flip one bit in (a) the database, (b)
   a single blob, (c) the manifest; run a restore. AC: each of the three cases → restore aborted,
   `server_epoch` unchanged, zero files materialized; the error message leaks no content.
5. **Blob byte-hashes in the manifest** — for a fresh checkpoint, compute the SHA-256 of every
   file in `blobs/` and compare against the manifest. AC: 100% match of `blob_hash`+`size`; a blob
   referenced by SQLite but absent from `blobs/` → restore rejected (referential integrity).
6. **New epoch + forced reconciliation** — after restore the instance has a new `server_epoch`; a
   client with an old cursor gets a response forcing reconciliation (a regression check against
   F7-01: `409 CURSOR_INVALID` end-to-end over HTTP). AC: an old cursor → reconciliation before
   any mutation.
7. **Atomicity / partial checkpoint (T4)** — inject a crash between the write and the rename of
   the temp file. AC: no "half-finished" checkpoint is visible as valid; the last valid checkpoint
   remains complete and passes restore.
8. **7/4/6 retention and "verify before forget"** — after a series of checkpoints, the policy
   maintains 7 daily/4 weekly/6 monthly. AC: the count and selection of checkpoints match the
   policy; an attempt to delete the oldest one without a prior successful verification of a newer
   one → blocked.
9. **The server cannot decrypt its own checkpoint (T1/no-third-party model)** — with only the
   material the server stores (the public recipient), an attempt to decrypt → impossible/error.
   AC: decryption succeeds only with the owner's private key.
10. **Manifest has no secrets (T5)** — grep `manifest.json` for plaintext paths, tokens, and note
    content injected into the fixture → 0 hits (the redaction-test pattern from F7-03).
11. **Mutual exclusion with GC/purge** — a checkpoint assembled concurrently with the GC path:
    AC: GC/purge does not remove a blob referenced by the in-progress checkpoint; the database
    snapshot via the Online Backup API stays consistent despite concurrent writes.

## Rollout/rollback

### Entry conditions

- E2EE (`plans/004`) implemented and passing multi-device recovery tests — because Stage 3 —
  general beta ties E2EE and backup together. In plaintext mode a checkpoint can be built earlier
  as a foundation, but it does **not unlock** Stage 3.
- F7-01 (backup/restore + server epoch) complete — the checkpoint inherits its Online Backup API,
  manifest verification, and epoch path (already `[x]` in the backlog).
- A separate crypto-suite spike + test vectors chosen and reviewed (as `plans/001` §10 "require a
  dedicated threat-model spike and test vectors. No custom cryptographic primitive will be
  invented"). **Owner decision gate** before implementation (rule 9: changing the approved
  encryption/trust model always requires a question).

### Deployment order (per `plans/001` §11, sequentially, TDD)

1. Checkpoint format + manifest + integrity tests on fixtures (without encryption) — RED→GREEN.
2. Library encryption layer (KDF + AEAD/recipient), test vectors, confidentiality tests
   (T1) and tamper tests (T2).
3. Atomic publication + crash tests (T4) + mutual exclusion with GC.
4. Scheduler + 7/4/6 retention + disk budget + copy off the server disk.
5. Restore to a clean instance end-to-end (AC 1,2,6) + recovery-kit and key-loss documentation (T3).
6. Only after everything is green: the threat-model review (a Stage 3 — general beta
   requirement), then possibly wrapping with Restic (SRV-03/04/05 once it returns from being
   deferred) — Restic transports already-encrypted checkpoints, without changing their content.

### Rollback

- A checkpoint is **additive and non-destructive**: it does not modify the running database or
  blob store (it reads via the Online Backup API + copies blobs by hash). Disabling the feature =
  stopping the scheduler; existing checkpoints remain valid and restorable. No database-schema
  migration is required by the checkpoint mechanism itself → no downgrade migration to undo
  (consistent with `plans/001` §8 "Rollback uses the matching prior image and backup, never an
  in-place schema downgrade").
- If a new checkpoint format turns out to be faulty: `checkpoint_format_version` in the manifest
  lets restore recognize and reject an unsupported version fail-closed; older checkpoints from
  the previous version remain restorable with the previous container image (immutable tags,
  `specs/003`).
- Irreversible operations on checkpoints (deletion, `forget --prune`) require an owner question
  (`plan/01` rule 9) and are always preceded by a successful verification of a newer checkpoint.
- A restore failure does not touch the source: restore targets a new empty directory, so a failed
  attempt does not damage the running instance or other checkpoints (fail-closed, isolation from
  `plans/001` §8).
