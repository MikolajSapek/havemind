# 07 — Hardened Compose and e2e fault harness

Source tasks: T030, T031. This deployment package is built specifically FOR `sapserver` — see
`08-sapserver-operations.md` for the target machine's real constraints.

## Compose contract (hard values, not adjectives)

```yaml
# draft of requirements, not a ready-to-use file — issue F7-02 writes the actual compose.yaml
services:
  havemind-server:
    user: "1000:1000"          # non-root, no privileged
    read_only: true             # where compatible with the Node runtime
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:8787:8787"    # NEVER 0.0.0.0
    volumes:
      - /srv/appdata/havemind:/data
    secrets:
      - havemind_db_key          # file in /srv/secrets, never inline env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 3
    tmpfs:
      - /tmp
    init: true
```

Budgets: image pinned to a specific tag + digest (not `latest`); log driver `local`,
`max-size: 10m` (consistent with the existing `/etc/docker/daemon.json` on `sapserver`).

## Event → reaction table (fault harness, T031)

| Injected event | Expected reaction |
|---|---|
| Server restart during a push | no revision duplication after restart (idempotency) |
| Client restart during a local apply | file materialises correctly after restart, no half-applied state |
| Network partition, 2 clients offline simultaneously | on return: convergence with no loss of any accepted revision |
| Duplicate delivery (network retry) | server returns the original result, no second revision |
| Restore from backup onto a clean instance | new epoch forces reconciliation on all clients |
| Conflict on the same line on both clients | both heads kept, entry in `Havemind Conflicts/`, no silent loss |

## Anti-spec (S5)

- Never use `ports: ["8080:80"]` without an explicit `127.0.0.1:` prefix — that's a security
  bug, not a style choice.
- Never run an image without a pinned digest in a configuration meant to run on `sapserver`.
- No Watchtower / automatic container updates (per the Sapserver note: "manual, controlled
  updates").

## Issues → BACKLOG mapping

- F7-02 — hardened Compose (T030)
- F8-01 — e2e fault harness (T031, before the pilot gate)
