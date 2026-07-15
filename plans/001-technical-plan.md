# Havemind technical implementation plan

- Status: **Approved by owner on 2026-07-15**
- Date: 2026-07-15
- Implements: `specs/001-mvp.md`, `specs/002-public-access.md`, `specs/003-open-source-release.md`

## 1. Outcome

Build a private two-person Havemind pilot that synchronizes two disposable Obsidian vaults through `sapserver`, preserves every accepted revision, survives offline work and restarts, exposes a useful activity history and can show who last changed each visible text range.

The pilot is intentionally not approved for real private notes. The architecture must already allow future end-to-end encryption and public self-hosting without replacing the revision protocol.

## 2. Approved assumptions

1. Source code is a TypeScript npm-workspace monorepo licensed under Apache-2.0.
2. The first tested clients are Obsidian desktop on macOS and Windows. Mobile APIs remain compatible where practical but mobile background sync is not an MVP guarantee.
3. `sapserver` remains private and can use Tailscale for pilot transport; the plugin itself speaks an ingress-independent HTTPS protocol.
4. The pilot uses disposable Markdown vaults. Attachments and E2EE are later release gates, not hidden claims of the plaintext pilot.
5. Each new device joins through a one-time invitation and owner approval with a human-readable verification phrase.
6. An owner receives a locally generated recovery kit once E2EE is introduced. The server cannot recover or decrypt vault contents.
7. The server is an append-only coordinator and blob store. Content-aware diff, provenance and merge logic live in the client-side `sync-core`, so encrypted payloads can replace plaintext payloads later.

## 3. Architecture

```text
Obsidian plugin A                         Obsidian plugin B
  Vault adapter                            Vault adapter
  IndexedDB queue/cache                    IndexedDB queue/cache
  sync-core                                sync-core
       |                                       |
       +----------- versioned HTTPS -----------+
                            |
                      Havemind server
                    auth + revision DAG
                     SQLite + blobs
                            |
                 one persistent data directory
```

### Trust boundary

- The server authenticates the member and device, assigns authoritative actor metadata, orders accepted events and preserves the revision DAG.
- A client never supplies a trusted `actor_id` through request data or proxy headers.
- The client validates/decrypts payloads, computes provenance, resolves clean merges and applies filesystem changes.
- Before E2EE, payloads are plaintext but travel through the same opaque-envelope interface used by future ciphertext.
- Tailscale, Caddy and tunnel providers are transport choices only; none defines Havemind membership.

## 4. Monorepo structure

```text
apps/
  obsidian-plugin/       Obsidian adapter, onboarding, Activity and overlay
  server/                Fastify API, auth, SQLite and blob persistence
packages/
  protocol/              Wire schemas, version negotiation, canonical headers and errors
  sync-core/             Revision DAG, diff/provenance, merge and client sync state machine
  test-support/          Shared fixtures only after two packages genuinely need them
deploy/
  compose.yaml           Supported self-host stack
  examples/              Explicit ingress examples; no production secrets
docs/
  architecture/          Protocol, threat model and decisions
  operations/            Setup, doctor, backup, restore and upgrades
plans/                   Approved implementation plans
specs/                   Product requirements
```

Dependencies flow in one direction:

```text
protocol <- sync-core <- obsidian-plugin
protocol <- server
```

The plugin and server never import one another. `sync-core` has no Obsidian, DOM, SQLite or HTTP dependency.

## 5. Technical stack

Versions checked on 2026-07-15 and locked exactly in `package-lock.json` during scaffolding:

- Node.js 22 LTS for local development and the server container;
- npm workspaces with npm 10;
- TypeScript 6.0 in strict mode (the newest line currently supported by the selected lint toolchain);
- Vitest 4.1 with V8 coverage and a global 80% threshold;
- fast-check 4.9 for model/property tests;
- Fastify 5.10 and Zod 4.4 for the HTTP contract and validation;
- better-sqlite3 12.11 with WAL, foreign keys and parameterized statements;
- Obsidian API types 1.13 and `minAppVersion` at least 1.11.4 for `SecretStorage`;
- esbuild 0.28 for a small plugin bundle;
- native Web Crypto or a separately reviewed browser-compatible crypto library only when the E2EE spike begins.

No React frontend, Redis, PostgreSQL, message broker or ORM is added to the MVP.

## 6. Development commands

The scaffold must provide these stable root commands:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:integration
npm run dev:server
npm run dev:plugin
npm run compose:smoke
```

Package-specific commands may exist, but CI and documentation use the root commands.

## 7. Protocol contracts

### Canonical text and paths

- Markdown content is normalized to LF before hashing or diffing.
- Provenance positions use UTF-16 code-unit offsets, matching JavaScript and CodeMirror.
- Tests cover CRLF, emoji, surrogate pairs, combining marks and multiline Markdown.
- Paths use `/`, Unicode NFC and no leading slash, empty segment, `.` or `..` segment.
- `.obsidian/**`, trash and `Havemind Conflicts/**` are reserved and never uploaded.
- A separate lowercase NFC collision key detects paths unsafe on common macOS/Windows filesystems. Case-only renames use a temporary path.

### Revision envelope

Every accepted revision has three deliberately separate parts:

1. `client_protected_header`, known before encryption: globally unique client-generated `revision_id`, `vault_id`, stable `file_id`, sorted parent IDs, expected member/device IDs, payload format, required sync/provenance/path semantic versions, payload encoding and, for E2EE, cipher suite, key epoch and nonce;
2. opaque payload bytes: initially plaintext JSON containing operation, current/previous path, normalized Markdown snapshot or tombstone, logical content hash and reconstruction recipe; later authenticated ciphertext containing that same inner schema;
3. `server_receipt`, assigned only after durable acceptance: authoritative member/device IDs, monotonic per-vault `server_sequence`, server receipt time, exact byte size and server-computed `blob_hash`.

For E2EE, canonical `client_protected_header` bytes are AEAD associated data. Server sequence/time are not AAD because they do not exist when the client encrypts. The clear `blob_hash` is SHA-256 of stored bytes; `plaintext_content_hash` and any path-derived value stay inside the payload.

The vault policy and discovery response declare required `payload_format_version`, `sync_semantics_version`, `provenance_recipe_version`, `path_normalization_version` and, when applicable, encryption suite/minimum write epoch. These are not optional hints for mutating clients. A client that cannot implement every required semantic fails closed before upload or local application; an unknown mutating event remains durably pending/quarantined and is never skipped as applied.

Server invariants:

- an identical revision ID and identical server-computed blob digest returns the original result; the same ID with different bytes returns `409`;
- revision IDs are globally unique; parent IDs are unique, exist, belong to the same vault/file and never self-reference;
- a batch is validated topologically and cannot introduce a cycle;
- expected member/device IDs match the authenticated session;
- zero parents are valid only for the first revision of a new `file_id`;
- a one-parent stale revision creates a branch instead of erasing another head;
- a multi-parent reconciliation is accepted only by compare-and-swap when its parent set exactly equals the current head set, otherwise `HEAD_SET_CHANGED` requires recomputation;
- a revision is immutable after acceptance;
- membership, role, device status, required semantics, write epoch, revision, heads, event and cursor are checked/updated atomically;
- cursors have no gaps or duplicates and advance only for durably committed events;
- accepted size and `blob_hash` exactly match the stored bytes;
- garbage collection never deletes a blob still referenced by SQLite;
- an incompatible client fails before push or pull changes state.

### Provenance

Visible provenance is derived and cached locally as normalized runs:

```ts
type ProvenanceRun = {
  length: number;
  sourceRevisionId: string;
};
```

- Every normal edit and conflict resolution carries a versioned reconstruction recipe made of validated parent ranges plus literal text; the full snapshot must exactly equal the recipe result.
- Source ranges retain their previous source revision. Literal text receives the current revision.
- Deleted ranges remain only in history.
- Initial imports use a special source revision.
- A restore copies the historical content provenance while Activity records the restoring actor.
- Every receiving client independently validates recipes against decrypted parent revisions and re-derives provenance; an invalid recipe is quarantined and never applied. The opaque server cannot attest content-level provenance.
- Attribution is deterministic collaboration history, not forensic proof against a malicious collaborator or administrator.

### Offline delivery

- Local changes are persisted to IndexedDB before any upload attempt.
- Push retries reuse the same revision ID.
- Downloaded and applied cursors are separate.
- Pulled events are persisted before filesystem application.
- A per-file mutex and expected hash prevent local/remote races.
- Unexpected content never gets overwritten silently; it creates a new local revision or explicit conflict.
- Loss of local IndexedDB never causes automatic guessing of `file_id` from path alone.
- The download cursor may advance after an event is durably stored, while each event/file retains a separate validation/materialization state. Corrupt or unsupported payloads are quarantined and do not block safe materialization of unrelated files.
- Each client maintains vault-wide ownership of canonical path collision keys. Concurrent create, rename or restore collisions between different file IDs become explicit path conflicts; the earliest accepted server sequence remains temporarily materialized while every other head is preserved for resolution.
- The disposable pilot bootstraps a new device from complete retained history under strict size limits. Real-vault compaction requires an encrypted checkpoint containing current snapshots, provenance and a history commitment; no history is garbage-collected until the checkpoint safety policy is separately approved.

## 8. Server components

### Persistence

SQLite tables cover schema migrations, instance/restore epoch, users, devices, vaults, memberships, invitations, refresh-token families, files, revisions, revision parents, vault events and idempotency records.

Large immutable payloads use content-addressed blob files under the same data root. The server computes the blob SHA-256 from received bytes; the client-side logical content hash remains a separate encrypted-payload field. Blob publication uses a temporary file on the same filesystem, file `fsync`, atomic rename and parent-directory `fsync`. An existing hash is verified rather than overwritten. Only then does one `BEGIN IMMEDIATE` transaction persist the revision, parents, heads, event, idempotency record and cursor before returning success.

SQLite runs on a local filesystem with one writer instance and explicit `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and a bounded `busy_timeout`. Orphan reclamation is deferred initially; later garbage collection must be mark-and-sweep with a safety window and mutual exclusion with backup/purge.

### API surface

Initial route groups:

- discovery and health;
- local-only instance setup and owner-device pairing;
- invitation, pending-device verification and approval;
- access-token refresh and device revocation;
- vault creation and membership listing;
- batched revision push and cursor-based pull;
- immutable event-envelope and blob retrieval;
- local administrator diagnostics and backup commands.

Every request and response uses shared protocol schemas. Protected routes use a central deny-by-default authentication/authorization pre-handler. The API is JSON-only, cookie-free and CORS-disabled, sets `Cache-Control: no-store` for sensitive responses and enforces explicit limits for bodies, batches, parent counts, note size and vault quota. Stable machine error codes are separate from human text.

### Authentication

- Instance initialization and owner creation happen only through a local setup CLI. There is no "first public request becomes owner" path. The CLI stores only a short-lived, single-use hash for pairing the first owner device; the server will not enter ready state until local initialization has completed, and the setup path is then permanently disabled.
- One-time owner-device and invitation secrets have at least 256 bits of entropy and are stored hashed.
- Invitations expire after 15 minutes and cannot be replayed.
- A friendly HTTPS join page keeps the invitation secret in the URL fragment so it does not enter proxy logs or `Referer`; it locally creates one versioned base64url envelope for secure copy/import. The public Obsidian protocol handler only opens the wizard because it does not expose URL fragments, and no capability is placed in its query.
- The plugin sends the invitation secret only in a redemption POST body. The server-side invitation record, not mutable deep-link display data, is authoritative for vault and inviter identity.
- Redemption creates a pending device; vault credentials are issued only after owner approval and comparison of the same human-readable phrase on both devices.
- Before approval, a pending device can query only its own approval state and cannot list or download vault data.
- Access tokens live for 10–15 minutes.
- Device-scoped refresh tokens rotate through a crash-safe, idempotent protocol: the client durably stores a generated successor token and `rotation_id` alongside the current token before sending both; the server atomically consumes the current hash and records the successor hash and rotation ID. Retrying the identical rotation succeeds, while reuse with different successor data revokes the family.
- Raw tokens, authorization headers, invitations and note payloads never enter logs.
- Role and vault membership are enforced centrally and narrowed again for owner-only actions.
- Rate limits apply before authentication and per authenticated member/device.
- Proxy identity headers are ignored as product identity.
- Client IP is used only for bounded rate limiting and operational logs. Forwarded proxy information is trusted only from the explicitly configured ingress.
- When an accepted opaque revision cannot be validated by healthy clients, the owner can revoke its device and create a client-side recovery reconciliation that supersedes the bad head; the server never fabricates replacement content.

### Backup, restore and deployment contract

- Backup uses the SQLite Online Backup API, never a raw copy of an active database/WAL.
- The database snapshot is paired with a manifest of every referenced blob, digest, size, maximum server sequence, schema/server version, instance ID and restore epoch.
- Purge and blob garbage collection are locked out while a backup snapshot is assembled.
- The supported production backup is encrypted and stored off the server's physical disk; the initial documented path uses Restic.
- Restore targets a new, empty, isolated data directory. Before startup it runs `PRAGMA integrity_check` and verifies every manifest blob.
- A restored instance receives a new `server_epoch`, revokes prior sessions and forces clients with an older epoch or a cursor beyond the server to reconcile revision IDs and heads before further mutation.
- Upgrade means preflight, verified backup, controlled one-shot migration and health check. Rollback uses the matching prior image and backup, never an in-place schema downgrade.

The supported Compose deployment uses a non-root UID, read-only root filesystem where compatible, `cap_drop: ALL`, `no-new-privileges`, init, a temporary `tmpfs`, bounded CPU/memory/PIDs and rotated logs. It has no Docker socket, privileged mode or default host `ports`. The pilot-only bridge may bind `127.0.0.1:8787`; it never binds `0.0.0.0`. Secrets use permission-restricted files and `*_FILE` inputs. Liveness and readiness are separate, and published images are pinned by version/digest.

## 9. Obsidian plugin components

The plugin is a thin adapter around injected ports:

```text
VaultPort | RemoteApi | ClientStore | SecretStore | Clock | Scheduler | Notifier
```

### Lifecycle

- `onload()` registers commands, settings, ribbon/status UI, Activity view, editor extension, Reading View processor and the `obsidian://havemind-join` handler, but performs no vault scan or network request.
- Vault scanning and network access begin after explicit onboarding or `workspace.onLayoutReady()` for an existing connection.
- `requestUrl()` is the HTTP transport.
- API endpoints never redirect. The plugin uses one validated HTTPS origin and treats unexpected redirect responses as connection errors.
- `SecretStorage` holds refresh credentials; `data.json` holds only a lowercase alphanumeric/hyphen secret reference and non-sensitive connection metadata. Disconnect revokes the device, overwrites the local secret with an empty value because the current API has no delete operation, then removes the reference.
- SecretStorage is not described as a hardware or operating-system keychain; credentials remain scoped, rotating and remotely revocable.
- IndexedDB is namespaced by a random local `client_instance_id` and stores file mappings, outbox, inbox, heads, cursors, Activity cache, provenance and deferred applies.
- `onunload()` stops schedulers, closes local storage, releases subscriptions and invalidates late network callbacks. It does not attempt a final network flush.

### Synchronization

- One single-flight loop runs at startup, focus, online return and a five-second interval with jittered backoff.
- A reconciliation scan after layout readiness compares every eligible Markdown file with the durable local index before the plugin may report `Synced`.
- Vault create/modify/rename/delete events are serialized per file and deduplicated by hash.
- Remote events use expected hashes and echo suppression.
- Failure to persist an outbox entry produces a blocking `Unsynced` state and prevents the corresponding network operation.
- Active editor changes use public editor transactions when safe; the inbox cursor advances only after the subsequent Vault state confirms the expected durable hash.
- Every open leaf/popout for the target file is checked; if any buffer diverges from the known base, remote apply is deferred or becomes a merge/conflict.
- Delete uses Obsidian trash APIs. Edit-versus-delete becomes a conflict.
- Local user rename events come from Obsidian normally, while replaying a remote rename uses the lower-level Vault rename path to avoid rewriting links a second time.
- A delete event uses the previously durable local snapshot because Obsidian does not provide deleted content in the event.

### User interface

- A guided owner/join wizard and one connection card.
- Status: `Synced`, `Syncing`, `Offline`, `Conflict`.
- Native Activity view with filters, safe text diff, revision restore and device approval.
- `Show authors` command/ribbon toggle, off by default.
- CodeMirror integration uses public `editorInfoField`, `StateEffect` and `StateField`; decorations are built only for visible ranges and only when the document hash matches provenance.
- Color is accompanied by underline/pattern, tooltip and keyboard-accessible current-range details.
- Reading View uses block-level markers when section mapping is available and shows no guessed attribution when `getSectionInfo()` returns no source mapping.
- `Havemind Conflicts/**` contains clearly labeled local generated artifacts that are not editable sources of synchronized truth; conflict resolution happens through Activity.

The pilot manifest is desktop-only until mobile behavior passes its own smoke tests.

## 10. E2EE compatibility path

E2EE is designed before real-vault use but implemented after the plaintext disposable pilot proves synchronization semantics.

Required properties:

- a random vault key is created on the owner's trusted device;
- content-sensitive revision payloads and attachments are encrypted locally with authenticated encryption;
- canonical client-protected header fields are authenticated as associated data, while the later server receipt remains separate;
- a client performs an encrypt/decrypt/schema/recipe round trip before upload;
- a receiving client verifies AEAD, inner schema, logical content hash, recipe, parent binding and vault/file/revision associated data before materialization;
- corrupted tags, wrong key epochs, malformed payloads or ciphertext replayed under another header are quarantined and never change a local file;
- device enrollment transfers a wrapped vault key only after owner approval and phrase comparison;
- a recovery kit can restore the vault key without server knowledge;
- key rotation and member removal use explicit key epochs; the server enforces a vault `minimum_write_epoch` from the protected header;
- an offline authorized device obtains the current key and re-encrypts its pending operation before upload; a removed member cannot obtain the new epoch or submit writes;
- rotation protects future content but cannot revoke plaintext already downloaded by a former member;
- the policy for giving a new member full history or only a new checkpoint is explicit during invitation;
- server-side backups contain ciphertext but still preserve all required metadata and blobs;
- clients derive and validate provenance from decrypted revision history.

The exact cipher suite, device-key algorithm and recovery encoding require a dedicated threat-model spike and test vectors. No custom cryptographic primitive will be invented.

A disposable plaintext pilot vault is never upgraded in place into a real encrypted vault. The first real vault is created as E2EE from its first revision.

## 11. Implementation sequence and verification gates

### Phase 0 — repository and contracts

Create the npm workspace, strict TypeScript configuration, lint/build/test commands, protocol package and CI-ready coverage configuration.

Gate: clean install, build, lint and one deliberately red-then-green protocol test work from the repository root.

### Phase 1 — high-risk sync-core spike

Implement canonicalization, content/path hashes, provenance-run transformation and deterministic line/character diff fixtures. Evaluate a small maintained diff dependency against golden cases before adopting it.

Gate: deterministic results for Unicode, repeated text, multiline edits, insert/replace/delete and normalization; 80%+ coverage.

### Phase 2 — DAG, offline state machine and conflicts

Implement immutable revisions, head tracking, two-client simulation, idempotent queues, clean three-way merges, explicit conflicts, tombstones, restore and manual resolution recipes.

Gate: property/model tests with shuffled delivery, duplicate retries, partitions and process restarts show no lost accepted revision and convergence after conflict resolution.

### Phase 3 — server vertical slice

Implement migrations, blobs, discovery, local owner setup, sessions, one vault and batched envelope/blob push/pull.

Gate: Fastify integration tests prove auth isolation, idempotency, restart durability, spoofed-actor rejection and no missing-blob commit.

### Phase 4 — plugin connection vertical slice

Build a loadable plugin shell, SecretStorage adapter, IndexedDB store, connection wizard and one-file initial import/download between two fake vault adapters.

Gate: plugin build produces valid `main.js` and `manifest.json`; adapter integration test joins with a one-time invitation and resumes a crashed bootstrap.

### Phase 5 — full Markdown operations

Connect real Vault events and implement create, update, rename, delete, restore, offline restart, echo suppression and conflict materialization.

Gate: two disposable Obsidian vaults pass the destructive operation matrix without silent overwrite.

### Phase 6 — Activity and author overlay

Build Activity and diffs locally from validated payloads plus authenticated receipts, then add notices, filters and CodeMirror/Reading View provenance UI. Restore creates a new client revision referencing historical source content; the server has no content-aware restore route.

Gate: overlay never changes Markdown hashes; Unicode attribution and accessible light/dark behavior pass automated and manual tests.

### Phase 7 — private `sapserver` pilot

Package the server, deploy it through the private ingress, run diagnostics, configure off-host backup and connect two disposable vaults.

Gate: seven-day pilot, forced network outages, service restart, client restart and clean-machine restore complete successfully.

### Phase 8 — gated follow-up plans

After the disposable pilot passes, write separate implementation plans for (a) public GitHub/BRAT alpha packaging, (b) E2EE/device recovery, (c) attachments/quota and (d) encrypted checkpoints/retention. Execute them sequentially rather than combining four high-risk changes.

Gate: each follow-up plan preserves this protocol's safety invariants and satisfies the relevant release stage in `003-open-source-release.md` before implementation or publication.

## 12. Test strategy

### Unit

- canonical text/path handling;
- schema validation and version negotiation;
- diff/provenance transformation;
- invitation parser and verification phrase;
- token hashing/rotation/reuse;
- queue transitions, cursor commits and echo suppression;
- Activity view models and overlay range mapping.
- IndexedDB blocked upgrade, quota failure, version change and explicit recovery states.

### Property/model

- random edit sequences and Unicode strings;
- revision DAG invariants;
- duplicate, delayed and reordered delivery;
- two clients editing through arbitrary offline partitions;
- provenance run coverage exactly equals document UTF-16 length.

### Integration

- real temporary SQLite and blob directories;
- Fastify injection for every API route and authorization boundary;
- fake IndexedDB plus two fake vaults;
- crash points before/after blob, DB, inbox, filesystem and cursor commits;
- migrations and backup/restore fixtures.

### Manual

- two actual Obsidian desktop vaults;
- light/dark themes and keyboard navigation;
- active-editor races;
- enable/disable/reload lifecycle, multiple open views and restart during editor save;
- Tailscale-private and standard HTTPS discovery;
- clean server restore and clean client bootstrap.

Coverage target is at least 80% for statements, branches, functions and lines in production packages. More important safety invariants have explicit tests even if the numerical threshold is already met.

## 13. Security verification

Before the private server pilot:

- threat model reviewed;
- no default password or committed secret;
- all SQL parameterized;
- all API inputs bounded and validated;
- invitation expiry/replay/race tests pass;
- refresh-token reuse and revocation tests pass;
- authorization tests cover cross-vault IDOR attempts;
- logs and diagnostics pass secret/content redaction tests;
- container runs non-root without privileged mode or Docker socket;
- only the selected ingress reaches the application;
- dependency and container vulnerability results are reviewed.

Before real data, add E2EE vectors, key-recovery, malicious-ciphertext, device-removal and metadata-leakage tests.

## 14. Boundaries

### Always

- write a failing behavior test before production behavior;
- preserve accepted revisions and local pending operations;
- use public Obsidian APIs and shared protocol schemas;
- validate untrusted input at every boundary;
- inspect all generated diffs and run the relevant tests;
- keep the pilot visibly labeled disposable-data-only.

### Ask first

- connect a real vault;
- deploy or change privileged configuration on `sapserver`;
- open the repository publicly, create GitHub releases or submit to Obsidian;
- introduce telemetry, third-party hosted services or a paid dependency;
- change the approved encryption/trust model;
- commit or push changes.

### Never

- store raw refresh/invitation secrets or private keys in Markdown, logs or Git;
- trust client-supplied actor identity;
- silently overwrite a divergent local file;
- expose the SQLite database or application port by default;
- invent cryptography;
- claim real-vault readiness before all safety gates pass.

## 15. Primary risks and controls

| Risk | Control |
|---|---|
| Silent data loss during a local/remote race | Durable queues, expected hashes, per-file mutex and crash tests |
| Incorrect author colors after Unicode edits | LF canonicalization, UTF-16 runs, golden/property tests and hash-gated overlay |
| E2EE forcing a protocol rewrite | Opaque payload server and client-side provenance from the first revision format |
| Divergent clients after retries or partitions | Immutable DAG, idempotent revision IDs, separate cursors and model tests |
| Compromised invitation or device | Short one-time invitation, phrase approval, device-bound rotating tokens and revocation |
| SQLite/blob inconsistency | Atomic blob publication, transaction invariants and restore verification |
| Self-hosting complexity | One Compose stack, one data root, setup/doctor commands and limited supported presets |
| Plugin/server version skew | Discovery negotiation, capabilities and fail-closed behavior before mutation |

## 16. Decision

The owner approved this order and architecture, including the decision that the server stores opaque revision payloads while `sync-core` performs diff, provenance and merge work on trusted clients. The owner also authorized uninterrupted local implementation and verification within the approved scope.
