# Contributing to Havemind

Thanks for your interest. Havemind is a small, deliberately narrow project: a
self-hosted, local-first sync layer for Obsidian built for two people sharing
one vault. Contributions are welcome within that scope.

## Before you start

- Read the [README](README.md) for the architecture and the trust model.
- This is a **technical alpha**. Use disposable vaults only; never test against
  a vault with real notes.
- Open an issue to discuss non-trivial changes before writing code, so we can
  agree the approach early.

## Development

Requires Node.js 22 and npm 10.

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

## Ground rules

- **Test-driven.** Write a failing test first, then the implementation. New
  logic ships with tests.
- **The server stays opaque.** It stores content-addressed blobs and revision
  headers only, it never computes diffs, merges, or provenance. Keep that
  boundary intact.
- **No new heavy dependencies.** React, Redis, PostgreSQL, message brokers,
  ORMs, custom cryptography, and Kubernetes are out of scope by design.
- **No secrets in the repo.** Never commit tokens, keys, invitations, or any
  private infrastructure details (addresses, hostnames, credentials).

## Pull requests

- Keep changes focused; one logical change per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org) for messages
  (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Ensure `build`, `typecheck`, `lint`, and `test` all pass before requesting
  review. CI runs the same checks plus the release acceptance tests.

## Code of conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
