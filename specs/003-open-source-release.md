# Havemind open-source readiness amendment

- Status: **Approved by owner on 2026-07-15**
- Date: 2026-07-15
- Amends: `001-mvp.md` and `002-public-access.md`

## Objective

Havemind is developed first as a private, two-person pilot and, if that pilot proves reliable, released as an open-source project that other people can self-host without depending on Mikolaj's infrastructure.

Open source does not mean open access to `sapserver`. Every deployment has its own users, vaults, storage, encryption keys and administrator. The owner's deployment remains private and invitation-only.

The product must balance three goals:

1. joining an existing shared vault is simple enough for a non-administrator;
2. hosting a server has one documented, supportable path;
3. secure defaults do not require the administrator to understand Havemind internals.

## Product promises

### For a collaborator

- Install the plugin, open an invitation, review the server and vault, and confirm.
- Do not type an IP address, port, API token, database setting or proxy configuration.
- Receive clear errors for an expired invitation, incompatible server, revoked device, unavailable server or invalid certificate.
- Keep a normal local Obsidian vault that still works while the server is offline.

### For a self-hoster

- Use one supported Docker Compose stack containing the Havemind server and its required runtime components.
- Use SQLite and persistent filesystem storage in the first supported release; PostgreSQL, Redis and Kubernetes are not required.
- Complete first-run setup with a browser wizard or equivalent guided CLI.
- Choose an explicitly documented network preset: private network, existing HTTPS reverse proxy, or the recommended public HTTPS path.
- Run a diagnostic command that reports actionable problems without printing secrets.
- Upgrade through one documented procedure that creates a pre-upgrade backup and runs tested forward migrations.
- Restore the previous version by restoring that backup and the matching container image. Database downgrade migrations are not promised.

The quick start may assume that Docker and a usable hostname or private network already exist. DNS, domain purchase and router restrictions are external prerequisites and must be explained honestly, not hidden behind a claim of fully automatic hosting.

## Supported deployment package

The repository will contain:

- `compose.yaml` with persistent volumes, health checks and restart policies;
- `.env.example` containing no usable default credentials;
- a setup command that generates strong secrets and a one-time owner bootstrap code;
- a first-run wizard for server name, public URL, storage check and owner creation;
- `havemind doctor`, `havemind backup` and `havemind restore` commands or equivalent documented container commands;
- deployment guides for the supported private and public HTTPS presets;
- published container images for `linux/amd64` and `linux/arm64` before the general beta;
- immutable version tags and documented image digests for stable releases.

The default application container:

- runs as a non-root user;
- does not require privileged mode or Docker socket access;
- exposes the application only to the selected ingress network, not automatically to every host interface;
- stores all durable state under one documented data location;
- fails closed when required secrets, HTTPS identity or filesystem permissions are invalid;
- logs operational events but redacts invitations, sessions, note contents and encryption material.

Advanced settings remain available but are not part of the primary quick start. A deployment that replaces SQLite, authentication or the storage layer is outside the initial support promise.

## Security and privacy baseline

- No open registration. Access is created through owner-controlled, short-lived, one-time invitations.
- Authentication and membership are enforced by Havemind regardless of whether ingress is Tailscale, Caddy, Cloudflare Tunnel or another HTTPS route.
- Secrets are generated randomly; there are no default passwords, sample production keys or credentials committed to the repository.
- Access credentials can be rotated and devices can be revoked.
- Server and plugin validate protocol versions, request schemas, paths, sizes and content types.
- Public deployments have documented rate limits and strict host/origin behavior.
- Telemetry is off by default. Any future diagnostics upload must be explicit opt-in and documented.
- Security-sensitive logs and diagnostic bundles are redacted by automated tests.
- A `SECURITY.md` file defines private vulnerability reporting and supported versions before the public alpha.
- A threat model documents what the server administrator, network provider and collaborators can observe.

The public alpha may synchronize only disposable test vaults and must display that limitation clearly. Real private vaults are not supported until end-to-end encryption, attachment handling, backup/restore and destructive conflict tests satisfy the gates below.

## Release stages and gates

### Stage 1, private pilot (`0.1.x`)

- Two disposable local vaults and the private `sapserver` instance.
- Markdown synchronization, offline queue, conflicts, deletion/restore, Activity and author overlay work end to end.
- No claim that real notes are safe.
- Backup and restore are exercised, not merely documented.

### Stage 2, public technical alpha (`0.2.x`)

- Source repository becomes public with a clearly experimental label.
- The plugin is installable through a documented GitHub/BRAT testing path.
- One-command server quick start, setup wizard and diagnostics are available.
- Automated tests cover two clients, retries, restarts, duplicate delivery, incompatible versions and failed migrations.
- Alpha users are told to use disposable vaults only.

### Stage 3, general beta (`0.5.x`)

- End-to-end encryption for note contents and attachments passes multi-device recovery tests.
- Attachment synchronization, quotas and retention behavior are implemented.
- Supported backup and restore work on a clean machine.
- Upgrade from the previous supported release is tested with real fixture data.
- `amd64` and `arm64` images, checksums, a software bill of materials and vulnerability scan results are published.
- A security review and documented threat-model review are complete.

### Stage 4, stable/community release (`1.0.0`)

- The plugin satisfies the current Obsidian Community Plugin submission requirements.
- Onboarding and recovery have been tested by people who did not develop the project.
- The compatibility policy, migration policy, privacy model and support boundaries are documented.
- No unresolved critical or high-severity security issue is known.
- A complete real-vault test is performed only after all prior safety gates pass.

Releasing source code early does not waive a safety gate. Each release prominently states whether it is suitable only for disposable data or for real vaults.

## Versioning and compatibility

- Plugin and server use independent Semantic Versioning.
- The synchronization protocol has an explicit version and a documented compatibility range.
- The server discovery response advertises its current protocol version and supported client range.
- An incompatible client is rejected before it uploads or applies changes and receives a human-readable upgrade instruction.
- From general beta onward, a server supports the current stable plugin and at least the immediately preceding compatible plugin release.
- SQLite migrations are ordered, transactional where SQLite permits, idempotently recorded and tested from every supported upgrade origin.
- Every upgrade creates or requires a verified backup before the first irreversible migration.
- Release notes identify schema changes, protocol changes, security fixes and manual actions.

## Repository and contributor baseline

Before the public alpha, the repository includes:

- `README.md` with architecture, status, screenshots, quick start and clear data-safety warning;
- an Apache-2.0 `LICENSE` covering the monorepo;
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `CHANGELOG.md`;
- setup, upgrade, backup, restore, troubleshooting, privacy and threat-model documentation;
- a versioned protocol description and compatibility matrix;
- issue and pull-request templates that request reproducible diagnostics without secrets;
- a documented development environment and test command.

The owner selected Apache-2.0 for the complete monorepo on 2026-07-15. It favors broad adoption, permits third-party self-hosting and includes an explicit patent grant. This can be revisited only before the first public release, because changing contributor licensing later is materially harder.

## Continuous integration and releases

Every proposed change must run:

- formatting, linting, type checking and unit tests;
- synchronization model/invariant tests and client-server contract tests;
- a two-client integration test with offline/reconnect behavior;
- plugin build and manifest validation;
- Docker build, fresh-install smoke test and migration test;
- dependency, secret and container vulnerability scans.

Stable releases additionally require:

- a Git tag matching the declared version;
- reproducible plugin artifacts (`main.js`, `manifest.json` and optional `styles.css`);
- versioned container images and checksums;
- human-readable release notes and upgrade instructions;
- a clean-install test and a backup/upgrade/restore drill.

Automated dependency updates may open pull requests but may not publish a release or modify production deployments without review.

## Obsidian publication requirements

Before Community Plugin submission, Havemind must at minimum:

- have a public source repository with root `README.md`, `LICENSE` and `manifest.json`;
- use a unique plugin ID and name that follow Obsidian's current manifest rules;
- use Semantic Versioning and a GitHub Release tag exactly matching the manifest version;
- attach `main.js`, `manifest.json` and, when used, `styles.css` to the release;
- disclose network access, accounts, external storage, privacy behavior and any telemetry in the README;
- keep the production bundle small, avoid heavy startup work and use public Obsidian APIs;
- test beta builds through BRAT or an equivalent documented manual install before directory submission;
- re-check the official submission rules immediately before publishing because they may change.

`havemind-sync` and `Havemind` remain working identifiers until uniqueness is re-checked at submission time.

## Acceptance criteria

- Installing the open-source plugin grants no access to `sapserver` or any other server without a valid invitation.
- A collaborator joins a vault through one invitation and no manual network configuration.
- On a supported host with Docker and HTTPS already available, a new administrator completes Havemind setup in under ten minutes using only the quick start.
- The default Compose deployment starts with no default password, no publicly exposed database and no privileged container.
- A diagnostic report contains no raw invitation, access token, refresh token, note content or encryption key.
- A documented backup restores users, vault metadata, revisions and encrypted content on a clean machine.
- Plugin/server incompatibility is detected before any local or remote content is changed.
- CI proves fresh install, supported upgrade, failed-upgrade recovery and two-client offline synchronization.
- Public release documentation states exactly which party can read note contents for that release.

## Decision

The owner approved the staged model: private disposable-vault pilot, public GitHub/BRAT technical alpha, E2EE and operational hardening before general beta, then Obsidian Community Plugin submission after independent onboarding and recovery tests.

Apache-2.0, local-first end-to-end encryption with a recovery key, one monorepo and the initial scope boundaries were approved together on 2026-07-15.
