# Security policy

We take security seriously and welcome reports of vulnerabilities.

## Supported versions

Only the latest published `1.1.x` release is supported. Older builds receive no
fixes, please update before reporting.

Note that 1.1.0 closed a device-impersonation path in the rejoin flow. Devices
paired before that release fail closed and must re-pair; running anything older
than 1.1.0 is not supported.

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
network configuration, those are operated separately and are out of scope.

## Data-safety reminder

Havemind has **no end-to-end encryption**. Note content is stored on the server
in plaintext, so anyone who controls the machine running the server can read the
vault. Run it only on hardware you and your circle trust, keep it tailnet-only,
and treat server access as vault access.

This is a deliberate scope decision for a small, self-hosted, trusted-circle
tool, not an oversight. If your threat model includes the server operator, this
is not the right tool for that vault.
