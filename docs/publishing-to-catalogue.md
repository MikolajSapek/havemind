# Publishing the plugin to the Obsidian community catalogue

Distribution repo: <https://github.com/MikolajSapek/obsidian-havemind> (plugin-only,
manifest at root). Monorepo `apps/obsidian-plugin/` stays the source of truth.

## Already done (prerequisites)

- Public distribution repo with `manifest.json`, `main.js`, `styles.css`,
  `versions.json`, `README.md`, `LICENSE` at the root.
- GitHub Release tagged `0.9.0` with `main.js` + `manifest.json` + `styles.css`
  attached as assets.
- Users can already install today via BRAT (see the distribution repo README).

## Submit to the official catalogue (done by the owner, in a browser)

Requires an Obsidian account — cannot be automated by the agent.

1. Go to **community.obsidian.md**, sign in with the Obsidian account.
2. Link the GitHub account (proves repo ownership).
3. **Plugins → New plugin**, paste `https://github.com/MikolajSapek/obsidian-havemind`.
4. Accept developer policies → **Submit**.
5. The bot runs an automated review. Fix any issue with a new commit + a new
   release with a bumped version, then reply on the submission.

Expected review queue: weeks to ~2 months.

## Pre-submission checks (run before Submit)

- Command IDs must NOT contain the plugin id `havemind-sync` (Obsidian
  auto-prefixes). Grep the plugin source for `addCommand` / `id:`.
- No leftover sample-plugin code; no forbidden names in `manifest.json`.
- Description ≤250 chars, ends with a period, no emoji. (0.9.0 already passes.)

## Likely reviewer question

Havemind requires a user-configured private server. Precedent: Self-hosted
LiveSync is in the catalogue. Emphasise: zero telemetry, user-owned
infrastructure, network traffic only to the server URL the user configures.

## Shipping updates

Run `scripts/publish-plugin.sh` from the monorepo: it rebuilds, scans the bundle
for secret markers, copies the artefacts to the distribution repo, commits, and
cuts a GitHub Release tagged to the manifest version. BRAT and the catalogue
auto-update users from there.
