# Havemind

Havemind is a proposed self-hosted collaboration layer for Obsidian. Each person keeps a normal local vault, while a private server synchronizes revisions and records who changed what. A toggleable author overlay colors text fragments by the person who last changed them, without altering the Markdown files.

Current status: **private-pilot implementation in progress**. The protocol,
sync engine, durable local queues, SQLite migrations and immutable blob storage
are under automated test. Havemind is not ready for a real vault, public
deployment or production use.

The current pilot payload format is intentionally plaintext. End-to-end
encryption is a hard gate before any real vault is connected; a disposable
plaintext pilot will never be upgraded in place.

## Documents

- [MVP specification](specs/001-mvp.md)
- [Zero-configuration connection amendment](specs/002-public-access.md)
- [Open-source readiness amendment](specs/003-open-source-release.md)
- [Approved technical implementation plan](plans/001-technical-plan.md)
- [Private-pilot task matrix](plans/002-pilot-tasks.md)
- [Existing-solutions research](docs/research.md)

## Local verification

Requires Node.js 22 and npm 10.

```bash
npm install
npm run verify
npm run test:coverage
```

Do not point the development plugin at an existing Obsidian vault. The manual
pilot will use two newly created disposable vaults after the automated fault
matrix, backup restore and deployment checks pass.
