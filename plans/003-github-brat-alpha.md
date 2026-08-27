# Plan 003, plugin distribution via GitHub Releases + BRAT (technical alpha)

- Status: **Draft, pending owner approval**
- Date: 2026-07-16
- Implements: `specs/003-open-source-release.md` section "Release stages and gates" →
  **Stage 2, public technical alpha** (`0.2.x`); `specs/002-public-access.md` (plugin
  transport-independent, zero-config invitation).
- Follows from: `plans/001-technical-plan.md` §11 Phase 8 (a) "public GitHub/BRAT alpha packaging"
  and §14 "Ask first: open the repository publicly, create GitHub releases".
- Blocking dependency: **Phase 7 (the seven-day pilot on `sapserver`) must pass** before
  anything in this plan is carried out (`plans/001` §11 Phase 8: "After the disposable
  pilot passes").

This plan covers only *how to distribute an already-built plugin artifact*. It does not change
the sync protocol, the trust model, or the opaque-server boundary. Any conflict with
`specs/`/`plans/001` → `specs/`/`plans/001` win (`plan/01-zasady-i-slownik.md` rule 1).

---

## Spec

### The problem this replaces

Today's workflow is a manual build + zip to the Desktop + manual installation into the
`.obsidian/plugins/` folder on both pilot machines (see `apps/obsidian-plugin/build.mjs`,
`main.js`, `manifest.json`, `styles.css`). There is no user-visible versioning,
no auto-update, and "every client must run the same build" is maintained solely by
manual discipline. This is already fragile with just 2 people.

Target state (Stage 2 from `specs/003`): *"The plugin is installable through a documented
GitHub/BRAT testing path."* The plugin installs and updates via BRAT (Beta Reviewer's
Auto-update Tool) from tagged GitHub Releases, without manual file copying.

### Scope

In scope:

1. Versioned GitHub Releases carrying a **three-file artifact**: `main.js`, `manifest.json`,
   `styles.css` (per `specs/003` "Obsidian publication requirements" and "attach
   `main.js`, `manifest.json` and, when used, `styles.css` to the release").
2. `versions.json` at the repo root (a `plugin-version → minAppVersion` map), the public contract
   of Obsidian/BRAT, required so that BRAT and any future Community-directory install correctly
   pick the right version for a given Obsidian version.
3. `manifest-beta.json` at the repo root, the beta channel for BRAT: lets us separate "what
   BRAT sees as the latest beta" from `manifest.json` used for a possible future Community
   directory publication (Stage 4, out of scope for this plan).
4. Auto-update UX for 2–3 pilots: how BRAT checks and bumps the version, and how this doesn't
   break a working vault.
5. Interaction with the hard constraint "all clients must run the same build", staged rollout /
   min-version gate via `discovery` + `client_protected_header` required semantics
   (`plans/001` §7).
6. The path from a private repo to a public technical alpha (ordering of gates, what must exist
   in the repo before tag `0.2.0` goes public).

Out of scope (deliberately, to avoid bundling several high-risk changes, `plans/001` §11
Phase 8):

- E2EE / device recovery (separate Phase 8b plan).
- Attachments/quota (Phase 8c).
- Publishing server container images and SBOM checksums (Stage 3, `specs/003`).
- Submission to the Obsidian Community directory (Stage 4).
- Automated release publication via CI (see Rollout, a release is confirmed manually).

### Facts about the current repo (grounded, not guessed)

- `apps/obsidian-plugin/manifest.json`: `id: "havemind-sync"`, `name: "Havemind"`,
  `version: "0.9.0"`, `minAppVersion: "1.11.4"`, `isDesktopOnly: true`.
- `apps/obsidian-plugin/package.json`: `version: "0.0.1"`, **inconsistent** with `manifest.json`
  `0.9.0`. Must be synchronized before versioning goes public (gate below).
- Build: `node build.mjs` (esbuild 0.28, format `cjs`, `platform: browser`, external `obsidian`
  + CodeMirror/lezer). Output: `main.js` (~844 KB). `build.mjs` already has a guard rejecting
  `node:`/`process.`/`require('fs'|'path'|'electron')` in the bundle, keep it.
- `styles.css` (13.5 KB) exists and IS used, so it's part of the artifact. Note: the current
  `package.json` `files` field lists only `main.js` and `manifest.json`, irrelevant for BRAT
  (BRAT pulls assets from the release, not from npm), but the release artifact MUST contain
  all three files.
- No `.github/` in the repo, **there is no CI or release workflow yet**. Needs adding (gate
  below), per `specs/003` "Continuous integration and releases".
- Remote: private repo under `github.com/MikolajSapek/...` (owner's account). Making it public =
  a gate requiring a question to the user (`plan/01-zasady-i-slownik.md` rule 9,
  `plans/001` §14 "Ask first").

### Version model

- The plugin and server version **independently under SemVer** (`specs/003` "Versioning and
  compatibility").
- Stage 2 is the `0.2.x` line (`specs/003`). The pilot build `0.9.0` from `manifest.json` does NOT
  automatically become `0.2.0`; moving to a public alpha is a **deliberate reset of the number to
  `0.2.0`** or keeping `0.9.x` as the private pilot line, with an explicit entry in `DECISIONS.md`.
  This is an open owner decision (see "Open decisions" below), since it touches the public
  version contract.
- The GitHub Release tag MUST **exactly** equal `manifest.json.version` (`specs/003`:
  "GitHub Release tag exactly matching the manifest version"). Tag without a `v` prefix, Obsidian/BRAT
  expect a clean SemVer (e.g. tag `0.2.0`, not `v0.2.0`).

### `versions.json` (contract)

Repo root. Key = plugin version, value = minimum Obsidian version:

```json
{
  "0.9.0": "1.11.4",
  "0.2.0": "1.11.4"
}
```

Maintenance rule: every published plugin tag has an entry in `versions.json` with a value equal
to `minAppVersion` from the manifest of **that** version. `minAppVersion` may increase (e.g. if a
future version needs a newer `SecretStorage` API), but never decreases without a deliberate
decision.

### `manifest-beta.json` (BRAT channel)

A copy of `manifest.json` used only as the "latest beta" for BRAT. During Stage 2 it may be
identical to `manifest.json`. The point of separating them: once, in Stage 4, `manifest.json` is
pinned to a version approved in the Community directory, `manifest-beta.json` still points to the
latest prerelease for BRAT testers, without pushing an unvetted version to regular users.

### Auto-update UX for 2–3 pilots

1. One-time install: the pilot installs BRAT from the Community directory, adds the plugin repo
   ("Add beta plugin", enters `MikolajSapek/<repo>`), BRAT pulls assets from the latest release.
2. Auto-update: on Obsidian startup (and on-demand via "Check for updates"), BRAT compares
   `manifest-beta.json.version` with the installed version; if newer, it downloads the new
   `main.js`/`manifest.json`/`styles.css` and reloads the plugin.
3. The plugin performs no auto-update of its own and makes no network request to GitHub,
   updates are managed exclusively by BRAT (consistent with `plans/001` §9: `onload()` makes no
   network request; the only HTTP transport is `requestUrl()` to the Havemind server, not to
   GitHub).
4. Notification: BRAT itself shows a notice "updated to x.y.z". Havemind additionally shows the
   plugin version on the connection card (`specs/002` "Connection card"), the pilot sees where
   they stand.

---

## Threat model

Scope: what is newly introduced by the *distribution channel* (GitHub Release + BRAT). This does
not repeat the full protocol threat model (`plans/001` §13). We narrow it to the boundary: "from
the artifact in my build to the code running in the pilot's Obsidian".

| # | Threat | Who | Control |
|---|---|---|---|
| T1 | Swapped/poisoned artifact in a release (someone with repo access publishes a malicious `main.js`) | Attacker with write access, or a compromised owner account | Only the owner publishes releases manually; branch protection on `main`; 2FA on the GitHub account; the artifact is built deterministically from a tagged commit (`specs/003`: "reproducible plugin artifacts"). BRAT trusts the release, there is no independent signature verification, so account control is the only boundary. Disclosed explicitly as a limitation. |
| T2 | BRAT pulls a version incompatible with the server → one client newer, the other older, despite "same build" | Natural drift, not an attack | Min-version gate in `discovery` + required semantic versions in `client_protected_header` (`plans/001` §7): an incompatible client **fails closed before** push/pull (`specs/003`: "incompatible client is rejected before it uploads or applies changes"). See "Staged rollout" below. |
| T3 | A secret in the artifact (token, invitation, key) ends up in a public release | Build error | `build.mjs` builds only from `src/`, not from `data.json`/SecretStorage; the guard on `process.`/`node:` already exists. Add a CI grep of the artifact for secret patterns before release (`specs/003`: "secret scans"). `plan/01` rule 6: secrets never in the repo/release. |
| T4 | A public repo reveals `sapserver`'s address/identity or makes it reachable | Opening the repo | Opening the repo does NOT open `sapserver` (`specs/003` acceptance: "Installing the open-source plugin grants no access to sapserver"; `specs/002`). Before publishing: grep the repo for the tailnet IP, `sapserver`, Tailscale hostnames, private vault paths (see AT6 in `release.yml`). Sapserver stays behind Tailscale, without Funnel (Funnel = a gate requiring a question, `plan/01` rule 9). |
| T5 | A user installs the plugin and thinks it's safe for real notes | Natural misunderstanding | Every alpha version is explicitly marked "disposable vaults only" (`specs/003` Stage 2: "Alpha users are told to use disposable vaults only"; lack of E2EE is flagged in the UI, `plan/01` "Honesty as a feature"). README data-safety warning + in-plugin notice. |
| T6 | Malicious fork/impersonation of the plugin ID `havemind-sync` | External | Until Stage 2, distribution only via the owner's known repo given directly to pilots. Uniqueness ID is checked only at Community submission (Stage 4, `specs/003`: "`havemind-sync` remain working identifiers until uniqueness is re-checked"). |
| T7 | Downgrade attack, BRAT/pilot stays on an old vulnerable version | Passive | `versions.json` + BRAT notification; the connection card shows the version; the server's min-version gate can reject too-old protocol (T2). There is no forced auto-update, an accepted risk for 2–3 known pilots, disclosed. |

Boundaries this plan does NOT cross: the server remains opaque (it computes nothing about
content, and does not participate in plugin distribution); zero custom cryptography (we do not
introduce artifact signing with our own scheme, if signing ever happens, it will use a standard
tool, under separate review); zero forbidden dependencies (React/Redis/PostgreSQL/broker/ORM/
custom crypto/Kubernetes), BRAT and GitHub Releases add none of these to the plugin bundle.

---

## Acceptance tests

Every test is functional and verifiable (a script / grep / manual step with a clear pass/fail).
Paths below are relative to the repo root (adjust for your local checkout location).

### AT1, the release artifact has exactly three files and matches the manifest

```bash
cd apps/obsidian-plugin
npm run build
test -f main.js && test -f manifest.json && test -f styles.css || { echo FAIL; exit 1; }
echo "PASS: three-file artifact present"
```

Pass: all three files exist after the build. Fail: any one is missing.

### AT2, tag version == manifest.json.version == package.json.version

```bash
cd apps/obsidian-plugin
MANIFEST_V=$(node -p "require('./manifest.json').version")
PKG_V=$(node -p "require('./package.json').version")
[ "$MANIFEST_V" = "$PKG_V" ] || { echo "FAIL: manifest=$MANIFEST_V pkg=$PKG_V mismatch"; exit 1; }
echo "PASS: versions aligned at $MANIFEST_V"
```

Pass: both versions equal (today FAIL: `0.9.0` vs `0.0.1`, this is work to do, not a test bug).
CI release extension: additionally `[ "$GITHUB_REF_NAME" = "$MANIFEST_V" ]`.

### AT3, `versions.json` has an entry for the published version with the correct minAppVersion

```bash
cd . # repo root
V=$(node -p "require('./apps/obsidian-plugin/manifest.json').version")
MIN=$(node -p "require('./apps/obsidian-plugin/manifest.json').minAppVersion")
GOT=$(node -p "require('./versions.json')['$V'] || ''")
[ "$GOT" = "$MIN" ] || { echo "FAIL: versions.json['$V']=$GOT expected $MIN"; exit 1; }
echo "PASS: versions.json entry matches manifest"
```

Pass: `versions.json[version] === manifest.minAppVersion`.

### AT4, `manifest-beta.json` exists and is a valid superset of the manifest

```bash
cd apps/obsidian-plugin
test -f manifest-beta.json || { echo "FAIL: manifest-beta.json missing"; exit 1; }
node -e "const m=require('./manifest.json'),b=require('./manifest-beta.json');
for (const k of ['id','name','minAppVersion','isDesktopOnly']) if(m[k]!==b[k]){console.log('FAIL key',k);process.exit(1)}
if(!b.version){console.log('FAIL: no version');process.exit(1)}
console.log('PASS: manifest-beta consistent')"
```

Pass: `id`/`name`/`minAppVersion`/`isDesktopOnly` identical, `version` present.

### AT5, the artifact contains no secrets or forbidden runtime APIs

```bash
cd apps/obsidian-plugin && npm run build
# build.mjs guard already throws on node:/process./require(fs|path|electron)
grep -nE 'sapserver|tail[0-9a-f]{4,}\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|refresh_token|BEGIN [A-Z]* PRIVATE KEY|invitation_secret' main.js \
  && { echo "FAIL: secret-like content in bundle"; exit 1; } || echo "PASS: no secret markers in main.js"
```

Pass: no matches. (The guard on `node:`/`process.` is enforced by `build.mjs` itself, build FAIL = test FAIL.)

### AT6, the repo does not reveal private infrastructure (gate before publication)

```bash
cd . # repo root
grep -rInE '100\.x\.y\.z|sapserver|Documents/[^/]*Private|Tailscale.*auth|passwordless-sudo' \
  --include='*.md' --include='*.json' --include='*.ts' --include='*.mjs' \
  --exclude-dir=node_modules --exclude-dir=.git . \
  && { echo "REVIEW: matches found, must be scrubbed or justified before public tag"; exit 1; } \
  || echo "PASS: no private-infra markers in publishable files"
```

Pass: no matches in files that will go into the public repo. (Note: `plan/` and operational
notes with the `sapserver` address must NOT go into the public repo, see Rollout.)

### AT7, end-to-end BRAT install (manual, single run)

Steps (pass/fail for each):

1. On a clean, disposable Obsidian vault install BRAT from the Community directory. → BRAT loads.
2. "Add beta plugin" → `MikolajSapek/<repo>`. → BRAT pulls `main.js`+`manifest.json`+`styles.css`
   from the latest release, the plugin appears in the list, activates without a console error.
3. The connection card shows the installed plugin version equal to the release tag. → matches.
4. Publish a new release with a higher version; in Obsidian trigger BRAT "Check for updates". →
   BRAT detects it, updates, the plugin reloads, the connection card shows the new version.

Pass: all 4 steps. This satisfies `specs/003` Stage 2 "installable through a documented
GitHub/BRAT testing path" and the `specs/002` acceptance "collaborator joins... without manually
entering network configuration".

### AT8, min-version gate: incompatible client fails closed (staged rollout)

Integration test (two clients, based on `plans/001` §7 and test strategy §12). Scenario: the
server declares in `discovery` a required `sync_semantics_version` higher than the old client's
version.

Pass: the old client receives a clear upgrade instruction and does **not** perform push/pull (no
change to local or remote state), `specs/003`: "An incompatible client is rejected before
it uploads or applies changes". Fail: the old client writes anything. This test already belongs
to the protocol contract; here we bind it as a safety condition for the distribution's staged
rollout.

### AT9, CI release workflow builds and attaches three files + versions.json (once `.github/` exists)

Verification that the workflow (e.g. `release.yml` triggered on tag `[0-9]+.[0-9]+.[0-9]+`):
runs `npm ci && npm run build`, validates AT1–AT5, and attaches `main.js`, `manifest.json`,
`styles.css` as release assets. Pass: a dry-run of the workflow (`act`, or pushing a tag to a test
branch) produces a release with three assets; AT1–AT5 green in the CI log. Fail: any asset
missing.

---

## Rollout/rollback

### Order (none of this without Phase 7 passing)

Phase R0, preparation in the private repo (no owner question needed, local):

1. Synchronize `package.json.version` with `manifest.json.version` (AT2 passes).
2. Add `versions.json` and `manifest-beta.json` at the root (AT3, AT4).
3. Add `.github/workflows/`:
   - `ci.yml`, `npm ci`, `build`, `typecheck`, `lint`, `test`, `test:coverage`, plus AT1–AT6
     as steps (per `specs/003` "Continuous integration and releases", `CLAUDE.md` commands).
   - `release.yml`, triggered on a SemVer tag, builds and attaches the three files (AT9). Does
     **not** auto-publish anything beyond GitHub Releases; the owner creates the tag itself.
4. Complete the repository baseline required by `specs/003` "Repository and contributor
   baseline" *before* the repo goes public: root `README.md` (architecture, status,
   **data-safety warning "disposable vaults only"**, quick start), `LICENSE` (Apache-2.0),
   `SECURITY.md` (private vulnerability reporting, required "before the public alpha"),
   `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
5. Run AT6 and scrub/exclude from publication anything that reveals `sapserver` (including
   `plan/`, operational notes with the Tailscale address). Decision on what stays private = an
   entry in `DECISIONS.md`.

Phase R1, **owner gate** (`plan/01` rule 9; `plans/001` §14 "Ask first: open the
repository publicly, create GitHub releases"):

- Ask the owner before: (a) `git push` of anything new to the remote, (b) changing repo
  visibility to public, (c) creating the first GitHub Release / tag `0.2.0`. None of these
  operations happen automatically within `/loop`.
- Open decision to confirm: the public alpha version number (`0.2.0` reset vs continuing
  `0.9.x`), see "Open decisions".

Phase R2, first public alpha:

1. Owner sets the repo to public (after AT6 passes + the R0.4 baseline).
2. Tag `0.2.0` (== manifest == package.json), CI `release.yml` builds and attaches the three files.
3. Pilots add the repo in BRAT (AT7). README explicit: "technical alpha, disposable vaults only".

Phase R3, staged rollout of subsequent versions (maintaining "same build"):

- The "all clients must run the same build" rule is enforced **not** by simultaneity of
  installation, but by the server's min-version gate (`plans/001` §7, AT8): the server raises the
  required semantics version in `discovery` only when it wants to force a new client; until then,
  older and newer plugin versions cooperate because they share the same `sync_semantics_version`.
- Procedure for releasing a version with a **breaking** protocol change: (1) publish the release,
  (2) ask both pilots to BRAT-update *before* the server raises the required version, (3) only
  after both clients confirm, redeploy the server with the higher required version. This order
  protects against a client being fail-closed mid-session.
- Versions with no protocol change (UI/bugfix only) require no coordination, BRAT updates
  asynchronously.

### Rollback

- Plugin rollback = the previous release. BRAT does not auto-downgrade, so:
  1. The owner marks the faulty release as pre-release / removes it from the "latest" listing
     (BRAT picks the newest non-draft release).
  2. Pilot: in BRAT, remove and re-add the plugin pinned to the earlier version, or manually copy
     the three files of the previous release into `.obsidian/plugins/havemind-sync/`
     (fallback = exactly today's manual workflow, so it's always available).
  3. If the faulty version raised the required protocol version on the server, first redeploy the
     server to the previous required version (opaque, no content migration), then downgrade
     clients.
- Server rollback is out of scope for this plan (`plans/001` §8 "Rollback uses the matching prior
  image and backup"); the only relevant point here is that plugin distribution assumes no
  irreversible server change.
- Irreversible steps (deleting a release, `git push --force`, changing the repo from public to
  private after someone has cloned it), a gate requiring an owner question (`plan/01` rule 9).

### Path from private repo → public technical alpha (gate summary)

1. Pilot Phase 7 passed (entry condition from `plans/001` §11 Phase 8).
2. R0 baseline + distribution files in place, AT1–AT6 green locally, no question needed.
3. Owner confirms: version number, public visibility, first tag/release, **gate**.
4. Public repo + tag `0.2.0` + BRAT (AT7) = **Stage 2, public technical alpha** reached
   (`specs/003` "Release stages and gates").
5. Stage 3 (E2EE, container images, SBOM) and Stage 4 (Community directory, uniqueness ID),
   separate plans, out of scope for this document.

### Open decisions (for `DECISIONS.md`, require owner input)

- Reset the number to `0.2.0` vs continuing `0.9.x` as the public alpha.
- Name/visibility of the public repo (currently private, account `MikolajSapek`).
- Which `plan/` files and operational notes stay private (cannot go into the public repo due to
  AT6 / the `sapserver` address).
- Whether `SECURITY.md` provides a public reporting channel before opening the repo (required
  "before the public alpha" per `specs/003`).
