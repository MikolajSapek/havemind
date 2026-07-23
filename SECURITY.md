# Security policy

Havemind is an early technical alpha. We take security seriously and welcome
reports of vulnerabilities.

## Supported versions

Only the latest published `0.9.x` alpha release is supported. Older builds
receive no fixes — please update before reporting.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's built-in private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

If private reporting is unavailable to you, contact the maintainer through the
email listed on their GitHub profile and mark the message as a security report.

We aim to acknowledge a report within 5 working days and to agree a disclosure
timeline with the reporter before any public detail is shared.

## Scope

This policy covers the Obsidian plugin and the open-source server code in this
repository. It does not cover any private deployment, its hosting, or its
network configuration — those are operated separately and are out of scope.

## Data-safety reminder

The alpha uses a plaintext pilot payload format and has no end-to-end
encryption. Use **disposable vaults only**. Never connect a vault holding real
or sensitive notes.
